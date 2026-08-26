import { prisma } from "@/lib/prisma";

const VOLUME_EPSILON_M3 = 0.01;

/**
 * A ticket's own volumeM3 is what got LOADED, not necessarily what the
 * customer actually ended up accepting — a load closed with a quality
 * rejection has its billed/accepted amount reduced on the trip itself
 * (Trip.volumeDeliveredM3, set by closeTripWithReturn in
 * trips/actions.ts), while every other return reason still bills the full
 * ticket volume. This is the one shared rule every "how much of this
 * reservation is actually released/delivered" figure — Production's
 * release form, the Reservations progress column, the grouped delivery
 * log, the demand outlook, the fully-delivered check below — must use, so
 * a quality-rejected load doesn't silently overstate what the customer
 * received. Falls back to the full ticket volume for a still-open trip
 * (volumeDeliveredM3 is only set at close time), matching the existing
 * "counts the moment it's released, not once delivered" behavior for a
 * normal ticket.
 */
export function sumAcceptedVolumeM3(tickets: { volumeM3: number; trip?: { volumeDeliveredM3: number | null } | null }[]): number {
  return tickets.reduce((sum, t) => sum + (t.trip?.volumeDeliveredM3 ?? t.volumeM3), 0);
}

/**
 * A large reservation (e.g. 200 m³) can't go out as one truck load — it's
 * dispatched as many partial batch tickets, each deducting from what's left.
 * This is the one place that sums "already released" so Production's
 * release form, the Reservations progress display, and the
 * fully-delivered check below can't drift out of sync with each other.
 */
export async function getReleasedVolumeM3(reservationId: string): Promise<number> {
  const tickets = await prisma.batchTicket.findMany({
    where: { reservationId, status: { not: "CANCELLED" } },
    select: { volumeM3: true, trip: { select: { volumeDeliveredM3: true } } },
  });
  return sumAcceptedVolumeM3(tickets);
}

export async function getRemainingVolumeM3(reservationId: string, requestedVolumeM3: number): Promise<number> {
  const released = await getReleasedVolumeM3(reservationId);
  return Math.max(0, requestedVolumeM3 - released);
}

/**
 * A reservation is fully delivered only once every m³ requested has been
 * released as a ticket AND every one of those tickets' trips has actually
 * closed — closing trip 1 of 25 on a split load must not mark the whole
 * reservation DELIVERED.
 */
// A reservation only counts as activated — releasable in Production —
// once both sign-offs are on file. Checked both where the release form
// decides what to show (production/page.tsx) and again inside
// releaseBatchTicket itself, same defense-in-depth pattern as every other
// "the picker only offered valid options" re-check in this app.
export function isReservationApproved(reservation: { initialApprovedAt: Date | null; finalApprovedAt: Date | null }): boolean {
  return reservation.initialApprovedAt != null && reservation.finalApprovedAt != null;
}

export async function isReservationFullyDelivered(reservationId: string): Promise<boolean> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { batchTickets: { where: { status: { not: "CANCELLED" } }, include: { trip: true } } },
  });
  if (!reservation) return false;

  const released = sumAcceptedVolumeM3(reservation.batchTickets);
  if (released < reservation.requestedVolumeM3 - VOLUME_EPSILON_M3) return false;

  return reservation.batchTickets.every((t) => t.trip?.status === "CLOSED");
}
