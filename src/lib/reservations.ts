import { prisma } from "@/lib/prisma";

const VOLUME_EPSILON_M3 = 0.01;

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
    select: { volumeM3: true },
  });
  return tickets.reduce((sum, t) => sum + t.volumeM3, 0);
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
export async function isReservationFullyDelivered(reservationId: string): Promise<boolean> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { batchTickets: { where: { status: { not: "CANCELLED" } }, include: { trip: true } } },
  });
  if (!reservation) return false;

  const released = reservation.batchTickets.reduce((sum, t) => sum + t.volumeM3, 0);
  if (released < reservation.requestedVolumeM3 - VOLUME_EPSILON_M3) return false;

  return reservation.batchTickets.every((t) => t.trip?.status === "CLOSED");
}
