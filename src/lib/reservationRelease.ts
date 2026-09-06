import "server-only";
import type { BatchTicket } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRemainingVolumeM3 } from "@/lib/reservations";
import { withSequentialNumber } from "@/lib/sequence";
import { resolveTicketComponents } from "@/lib/batchCompletion";
import { withRetry } from "@/lib/inventoryLedger";

// See the same note on production/actions.ts's own TX_OPTIONS —
// several sequential round trips to Neon inside one transaction can
// comfortably exceed Prisma's 5s default interactive-transaction
// timeout, especially on a cold connection.
const TX_OPTIONS = { timeout: 15000 };

// A reservation this far along can never be released against again —
// same terminal set closeReservation's own guard uses
// (reservations/actions.ts). Checked fresh, inside the transaction, not
// just once by the caller beforehand (RMR-R2-P1-02).
const TERMINAL_RESERVATION_STATUSES = new Set(["DELIVERED", "CANCELLED"]);

export type ReleaseTicketResult =
  | { status: "OK"; ticket: BatchTicket }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_STATE" }
  | { status: "NO_REMAINING_VOLUME" }
  | { status: "STORAGE_NOT_CONFIGURED"; material: string };

// Thrown from inside the transaction to unwind to a typed result without
// letting withRetry's own P2034-retry loop mistake an expected business
// outcome for a serialization conflict (RMR-P2-07) — never escapes this
// file.
class ReleaseAbort extends Error {
  constructor(public result: Exclude<ReleaseTicketResult, { status: "OK" }>) {
    super(result.status);
  }
}

// The actual ticket-creation logic shared by releaseBatchTicket (a
// planned, pre-approved reservation) and createManualRelease (a walk-in
// sale that self-approves on the way in) — extracted out of
// production/actions.ts (matching claimTripSlot/applyReclaimCredit's own
// extraction) so tests can exercise the REAL release logic directly,
// including its reservation-mix-revision lookup, instead of a paraphrase.
// Doesn't redirect; each caller does that itself since they land
// somewhere different.
//
// plantId here is the STATION — the reservation itself only committed to
// a plant/site (see the Reservation model comment); which station within
// it actually produces this ticket is decided right here, at release
// time, by whoever's releasing it. The caller's own OUTER checks
// (approval, site/plant scope, plant active) are a UX-level pre-check
// only now — every one of them is re-verified fresh, inside the same
// transaction that creates the ticket, below. Without that, a
// concurrent close/cancel, a revoked approval (editing a reservation's
// volume/mix/site clears its signoffs — see reservations/actions.ts), or
// a plant deactivated in the gap between that outer check and this
// transaction actually running could create a ticket for — and silently
// reopen — a reservation that had already gone terminal (RMR-R2-P1-02).
//
// Deliberately does NOT call logAudit itself on success (an earlier
// version did) — logAudit's own getCurrentUser() call reads cookies()
// via next/headers, which throws outside a real Next.js request/action
// context. That's exactly the context this function is designed to run
// in directly from tests (see the file-level comment above), so the
// audit write for a successful release belongs to the two Server Action
// callers instead — same split completeBatchTicket/reverseBatchTicket
// already use, where the domain function stays pure and the wrapper
// logs.
export async function releaseTicketForReservation(reservationId: string, requestedVolume: number, plantId: string): Promise<ReleaseTicketResult> {
  try {
    const ticket = await withRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const reservation = await tx.reservation.findUnique({
            where: { id: reservationId },
            include: { mix: { include: { components: true } } },
          });
          if (!reservation) throw new ReleaseAbort({ status: "NOT_FOUND" });

          const isApproved = reservation.initialApprovedAt != null && reservation.finalApprovedAt != null;
          if (!isApproved || TERMINAL_RESERVATION_STATUSES.has(reservation.status)) {
            throw new ReleaseAbort({ status: "INVALID_STATE" });
          }

          const plant = await tx.plant.findUnique({ where: { id: plantId }, select: { siteId: true, status: true } });
          if (!plant) throw new ReleaseAbort({ status: "NOT_FOUND" });
          if (plant.siteId !== reservation.siteId || plant.status !== "ACTIVE") {
            throw new ReleaseAbort({ status: "INVALID_STATE" });
          }

          // The remaining-volume read and the ticket create used to be two
          // separate round trips with no lock between them — two
          // concurrent releases for the same reservation could both read
          // the same "remaining" figure and both create a ticket,
          // together dispatching more than was ever requested. Serializable
          // makes Postgres detect that read-write conflict and abort one
          // of the two competing transactions (withRetry above then
          // retries the aborted one automatically). The reservation's own
          // active mix revision read below rides the same guarantee: a
          // concurrent save/cancel of a revision
          // (src/lib/reservationMixRevisions.ts, also Serializable) and
          // this release can never produce a ticket whose components are
          // mixed between an old and a new revision — whichever of the
          // two transactions commits first is what the other sees, or
          // Postgres aborts one outright if they were truly concurrent.
          const remaining = await getRemainingVolumeM3(reservationId, reservation.requestedVolumeM3, tx);
          const volumeM3 = Math.min(requestedVolume, remaining);
          if (volumeM3 <= 0) throw new ReleaseAbort({ status: "NO_REMAINING_VOLUME" });

          // A ticket already released before this point keeps its own
          // frozen BatchComponentActual rows regardless of what happens to
          // the reservation's revision history afterward — nothing ever
          // re-reads MixDesign/MixComponent or ReservationMixRevision once
          // a ticket exists (see BatchComponentActual's own comment; every
          // later stage — completion, reclaim, reversal, the shortage-
          // override snapshot — already works strictly from this table).
          const activeRevision = await tx.reservationMixRevision.findFirst({
            where: { reservationId, status: "ACTIVE" },
            orderBy: { revisionNumber: "desc" },
            include: { components: true },
          });
          const componentSource: { materialId: string; designMassKgPerM3: number }[] = activeRevision
            ? activeRevision.components.map((c) => ({ materialId: c.materialId, designMassKgPerM3: Number(c.designMassKgPerM3) }))
            : reservation.mix.components.map((c) => ({ materialId: c.materialId, designMassKgPerM3: c.designMassKgPerM3 }));

          // Preflight the effective recipe against the chosen station's own
          // storage BEFORE creating a ticket that can never be completed
          // (RMR-P2-02) — reuses the exact same resolution rules real
          // completion uses (batchCompletion.ts's resolveTicketComponents),
          // not a second copy that could silently drift from it. A revision
          // that adds a material with nowhere to draw it from at THIS
          // station now fails here, with a typed, attributable reason,
          // instead of failing invisibly at completion time days later.
          const materials = await tx.material.findMany({
            where: { id: { in: componentSource.map((c) => c.materialId) } },
            select: { id: true, name: true, type: true, inventoryTracked: true, specificGravity: true },
          });
          const materialById = new Map(materials.map((m) => [m.id, m]));
          const resolution = await resolveTicketComponents(tx, {
            plantId,
            plant: { siteId: plant.siteId },
            components: componentSource.map((c) => {
              const material = materialById.get(c.materialId)!;
              return {
                materialId: c.materialId,
                targetMassKg: c.designMassKgPerM3 * volumeM3,
                actualMassKg: null,
                material: { type: material.type, name: material.name, inventoryTracked: material.inventoryTracked, specificGravity: material.specificGravity },
              };
            }),
          });
          if (resolution.status === "STORAGE_NOT_CONFIGURED") {
            throw new ReleaseAbort({ status: "STORAGE_NOT_CONFIGURED", material: resolution.material });
          }

          // ticketNumber is globally unique (one company-wide sequence, not
          // per-plant) — it used to be counted per plantId while the column
          // itself has no per-plant scoping, so the FIRST ticket at any
          // second plant always collided with "BT-<year>-0001" from the
          // first one ever used. See withSequentialNumber's own comment for
          // the full story.
          const created = await withSequentialNumber(
            "BT",
            (yr) => tx.batchTicket.count({ where: { createdAt: yr } }),
            (ticketNumber) =>
              tx.batchTicket.create({
                data: {
                  reservationId,
                  mixId: reservation.mixId,
                  plantId,
                  ticketNumber,
                  volumeM3,
                  status: "RELEASED",
                  reservationMixRevisionId: activeRevision?.id ?? null,
                  components: {
                    create: componentSource.map((c) => ({
                      materialId: c.materialId,
                      targetMassKg: c.designMassKgPerM3 * volumeM3,
                    })),
                  },
                },
              }),
          );

          if (reservation.status !== "IN_PRODUCTION") {
            await tx.reservation.update({ where: { id: reservationId }, data: { status: "IN_PRODUCTION" } });
          }

          return created;
        },
        { ...TX_OPTIONS, isolationLevel: "Serializable" },
      ),
    );

    return { status: "OK", ticket };
  } catch (e) {
    // Only a recognized, expected business outcome resolves to a typed
    // result — anything else (a real DB error, a constraint violation, a
    // programming bug) propagates instead of being swallowed as if it
    // meant "nothing to release" (RMR-P2-07). The caller's own Server
    // Action has no try/catch either, same as every other action in this
    // app — an unexpected throw here surfaces through Next's normal error
    // boundary, which is a real, visible failure, not a silent no-op.
    if (e instanceof ReleaseAbort) return e.result;
    throw e;
  }
}
