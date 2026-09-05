import "server-only";
import { prisma } from "@/lib/prisma";
import { getRemainingVolumeM3 } from "@/lib/reservations";
import { withSequentialNumber } from "@/lib/sequence";
import { logAudit } from "@/lib/audit";

// See the same note on production/actions.ts's own TX_OPTIONS —
// several sequential round trips to Neon inside one transaction can
// comfortably exceed Prisma's 5s default interactive-transaction
// timeout, especially on a cold connection.
const TX_OPTIONS = { timeout: 15000 };

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
// time, by whoever's releasing it. The caller is responsible for
// validating plantId belongs to reservation.siteId and is ACTIVE before
// calling this.
export async function releaseTicketForReservation(reservationId: string, requestedVolume: number, plantId: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { mix: { include: { components: true } } },
  });
  if (!reservation) return null;

  // The remaining-volume read and the ticket create used to be two separate
  // round trips with no lock between them — two concurrent releases for the
  // same reservation could both read the same "remaining" figure and both
  // create a ticket, together dispatching more than was ever requested.
  // Serializable makes Postgres detect that read-write conflict and abort
  // one of the two competing transactions. The reservation's own active
  // mix revision read below rides the same guarantee: a concurrent
  // save/cancel of a revision (src/lib/reservationMixRevisions.ts, also
  // Serializable) and this release can never produce a ticket whose
  // components are mixed between an old and a new revision — whichever of
  // the two transactions commits first is what the other sees, or
  // Postgres aborts one outright if they were truly concurrent.
  let ticket;
  try {
    ticket = await prisma.$transaction(
      async (tx) => {
        const remaining = await getRemainingVolumeM3(reservationId, reservation.requestedVolumeM3, tx);
        const volumeM3 = Math.min(requestedVolume, remaining);
        if (volumeM3 <= 0) throw new Error("NO_REMAINING_VOLUME");

        // A ticket already released before this point keeps its own
        // frozen BatchComponentActual rows regardless of what happens to
        // the reservation's revision history afterward — nothing ever
        // re-reads MixDesign/MixComponent or ReservationMixRevision once
        // a ticket exists (see BatchComponentActual's own comment; every
        // later stage — completion, reclaim, reversal, the shortage-
        // override snapshot — already works strictly from this table).
        const activeRevision = await tx.reservationMixRevision.findFirst({
          where: { reservationId, status: "ACTIVE" },
          include: { components: true },
        });
        const componentSource: { materialId: string; designMassKgPerM3: number }[] = activeRevision
          ? activeRevision.components.map((c) => ({ materialId: c.materialId, designMassKgPerM3: Number(c.designMassKgPerM3) }))
          : reservation.mix.components.map((c) => ({ materialId: c.materialId, designMassKgPerM3: c.designMassKgPerM3 }));

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
    );
  } catch {
    return null;
  }

  await logAudit({
    module: "Production",
    recordId: ticket.id,
    afterValue: `${ticket.ticketNumber} — ${ticket.volumeM3} m3`,
    reasonCode: "BATCH_RELEASED",
  });

  return ticket;
}
