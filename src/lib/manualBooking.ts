import "server-only";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { withSequentialNumber } from "@/lib/sequence";
import { evaluateProjectCredit } from "@/lib/creditPolicy";
import { releaseTicketForReservation, type ReleaseActor, type ReleaseTicketResult } from "@/lib/reservationRelease";

// A walk-in sale: a customer at the yard with no prior booking. Creates
// the reservation and releases the first ticket against it in one step,
// self-approved by the operator, because the two-stage sign-off exists for
// a planned pour, not a truck waiting to load.
//
// Self-approval never covered credit, but the old version created a
// CONFIRMED, fully signed-off reservation without asking, so a walk-in was
// the easiest way around a customer's credit hold. The booking now makes
// the same credit decision every other path makes (creditPolicy.ts),
// inside the transaction that creates it:
//
// - within the limit: CONFIRMED and self-approved, then released. Release
//   decides credit again inside its own transaction, so a balance that
//   changes in between is still caught there.
// - not fitting under the limit: the booking is kept ON_HOLD with only the
//   initial approval, nothing is released, and the result says so. The
//   hold is lifted by final approval, which re-checks credit, exactly as
//   for any other held reservation.
//
// Extracted from createManualRelease (production/actions.ts) so tests run
// the real logic without a request context. The reservation and its audit
// row commit together; they used to be two separate writes.
export type ManualBookingInput = { projectId: string; siteId: string; plantId: string; mixId: string; volumeM3: number };

export type ManualBookingResult =
  | { status: "RELEASED"; reservationId: string; ticketId: string }
  | { status: "HELD_FOR_CREDIT"; reservationId: string }
  | { status: "RELEASE_REFUSED"; reservationId: string; release: Exclude<ReleaseTicketResult, { status: "OK" }> }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_VOLUME" };

export async function createManualBooking(input: ManualBookingInput, actor: ReleaseActor): Promise<ManualBookingResult> {
  // createManualRelease refuses this too, but the domain function is what
  // writes a CONFIRMED, fully approved row, so it must not rely on its
  // one caller (audit of f955650, N1).
  if (!Number.isFinite(input.volumeM3) || input.volumeM3 <= 0) return { status: "INVALID_VOLUME" };
  const now = new Date();
  const booked = await withSequentialNumber(
    "RES",
    (yr) => prisma.reservation.count({ where: { createdAt: yr } }),
    (reservationNumber) =>
      prisma.$transaction(async (tx) => {
        const credit = await evaluateProjectCredit(tx, input.projectId, { kind: "NEW_BOOKING", mixId: input.mixId, siteId: input.siteId, volumeM3: input.volumeM3 });
        if (!credit) return null;
        const held = credit.status === "OVER_LIMIT";
        const reservation = await tx.reservation.create({
          data: {
            reservationNumber,
            projectId: input.projectId,
            siteId: input.siteId,
            mixId: input.mixId,
            requestedVolumeM3: input.volumeM3,
            originalVolumeM3: input.volumeM3,
            pourWindowStart: now,
            status: held ? "ON_HOLD" : "CONFIRMED",
            initialApprovedAt: now,
            initialApprovedById: actor.id,
            ...(held ? {} : { finalApprovedAt: now, finalApprovedById: actor.id }),
          },
        });
        await writeAudit(tx, { id: actor.id, role: actor.role }, {
          module: "Reservations",
          recordId: reservation.id,
          afterValue: `${input.volumeM3} m3`,
          reasonCode: held ? "MANUAL_BOOKING_CREDIT_HOLD" : "MANUAL_BOOKING_CREATED",
        });
        return { reservationId: reservation.id, held };
      }),
  );
  if (!booked) return { status: "NOT_FOUND" };
  if (booked.held) return { status: "HELD_FOR_CREDIT", reservationId: booked.reservationId };

  const release = await releaseTicketForReservation(booked.reservationId, input.volumeM3, input.plantId, actor);
  if (release.status !== "OK") return { status: "RELEASE_REFUSED", reservationId: booked.reservationId, release };
  return { status: "RELEASED", reservationId: booked.reservationId, ticketId: release.ticket.id };
}
