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

// A positive allow-list, not a terminal blacklist — a blacklist of just
// DELIVERED/CANCELLED would also let a REQUESTED or ON_HOLD reservation
// through the domain function if it somehow carried both approvals (or
// any future status this schema adds later), since neither is in that
// blacklist either. Only these two statuses are ever release-ready
// (RMR-R4-P1-01).
const RELEASABLE_RESERVATION_STATUSES = new Set(["CONFIRMED", "IN_PRODUCTION"]);

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

// allowedSiteId is still session-derived data, not session ACCESS — this
// function never calls getCurrentUser()/cookies() itself; the caller
// computes effectiveSiteId(user) and passes the plain value in. null
// means unrestricted (ADMIN), same convention as isSiteInScope. Defense
// in depth (RMR-R5-P1-01): the caller's own outer scope check reads the
// reservation's siteId before this function ever takes its lock, so a
// site reassignment landing in that gap would otherwise go unchecked —
// the chosen plant already has to match the reservation's site (below),
// which prevents the same race indirectly, but re-checking the actor's
// own scope explicitly, after the lock, is clearer and doesn't depend on
// that indirect relationship holding.
export type ReleaseActor = { id: string; role: string; allowedSiteId: string | null };

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
// transaction that creates the ticket, below.
//
// A fresh read alone isn't enough, though (RMR-R4-P1-01): if the
// reservation is already IN_PRODUCTION, the old code never wrote to the
// Reservation row at all in the success path (the status update was
// skipped exactly because it was already IN_PRODUCTION) — meaning
// Postgres's own Serializable conflict detection, which works by
// finding a read/write cycle between transactions, had nothing to
// detect against a concurrent closeReservation() committing DELIVERED
// in that same window: a plain read here and an unrelated write there
// aren't a conflict, they're just two transactions that both happened
// to run. The explicit SELECT ... FOR UPDATE below makes the Reservation
// row itself the shared lock: closeReservationForId (src/lib/
// reservations.ts) takes the exact same lock before its own state check,
// so the two can never interleave — whichever gets there first blocks
// the other until it commits, and the second one then sees the fresh,
// already-committed state.
export async function releaseTicketForReservation(reservationId: string, requestedVolume: number, plantId: string, actor: ReleaseActor): Promise<ReleaseTicketResult> {
  try {
    const ticket = await withRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
          if (locked.length === 0) throw new ReleaseAbort({ status: "NOT_FOUND" });

          const reservation = await tx.reservation.findUniqueOrThrow({
            where: { id: reservationId },
            include: { mix: { include: { components: true } } },
          });

          if (actor.allowedSiteId !== null && reservation.siteId !== actor.allowedSiteId) {
            throw new ReleaseAbort({ status: "NOT_FOUND" });
          }

          const isApproved = reservation.initialApprovedAt != null && reservation.finalApprovedAt != null;
          if (!isApproved || !RELEASABLE_RESERVATION_STATUSES.has(reservation.status)) {
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
          // together dispatching more than was ever requested. The row
          // lock taken above already serializes this against a SECOND
          // release for the same reservation too (both would try to lock
          // the same row; the second waits, then sees this one's already-
          // committed ticket when it re-reads remaining volume) — this is
          // no longer resting on Serializable's conflict detection alone.
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

          // Written in the SAME transaction as the ticket itself
          // (RMR-R4-P2-02) — a version that logged this after the
          // transaction committed meant a successful release could exist
          // with no matching audit event if that later, separate write
          // ever failed, and (since the redirect never happens when an
          // action throws) an operator could reasonably retry and
          // release a second ticket while volume remained. actor is
          // passed in by the two Server Action callers, which already
          // have it from their own session — this function itself never
          // touches getCurrentUser()/cookies(), so it stays callable
          // directly from tests with no request context.
          await tx.auditEvent.create({
            data: {
              actorId: actor.id,
              role: actor.role,
              module: "Production",
              recordId: created.id,
              afterValue: `${created.ticketNumber} — ${created.volumeM3} m3`,
              reasonCode: "BATCH_RELEASED",
            },
          });

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
