import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { reservationSiteScopeWhere } from "@/lib/siteScope";

type Db = Prisma.TransactionClient | typeof prisma;

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
// Accepts an optional transaction client (defaulting to the plain
// singleton) so a caller that needs the read and the ticket-create it
// gates to be atomic — see releaseTicketForReservation in
// production/actions.ts — can pass its own `tx` through.
export async function getReleasedVolumeM3(reservationId: string, db: Db = prisma): Promise<number> {
  const tickets = await db.batchTicket.findMany({
    where: { reservationId, status: { not: "CANCELLED" } },
    select: { volumeM3: true, trip: { select: { volumeDeliveredM3: true } } },
  });
  return sumAcceptedVolumeM3(tickets);
}

export async function getRemainingVolumeM3(reservationId: string, requestedVolumeM3: number, db: Db = prisma): Promise<number> {
  const released = await getReleasedVolumeM3(reservationId, db);
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

// How far ahead of the pour a reminder becomes "due" — wide enough that a
// reservations officer checking the board once every hour or two won't miss
// one, narrow enough that the list stays a same-day, actionable set rather
// than tomorrow's whole schedule.
export const REMINDER_WINDOW_HOURS = 3;

/**
 * Reservations whose pour is coming up soon and haven't had their WhatsApp
 * reminder sent yet — the "automatic" half of the reminder feature: no
 * WhatsApp Business API account is wired up (see WhatsAppShareButton), so
 * the actual send is a manual wa.me click, but detecting which bookings
 * need that click is what this computes on every page load instead of
 * relying on someone remembering to check. A reservation with no
 * siteContactPhone on file is still included (nothing to send to, but it
 * should surface as a gap rather than silently vanish from the list).
 */
export async function reservationsDueForReminder(siteId: string | null) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000);
  return prisma.reservation.findMany({
    where: {
      ...reservationSiteScopeWhere(siteId),
      status: { in: ["CONFIRMED", "IN_PRODUCTION"] },
      pourWindowStart: { gte: now, lte: windowEnd },
      reminderSentAt: null,
    },
    orderBy: { pourWindowStart: "asc" },
    include: { project: { include: { customer: true } }, site: true, mix: true },
  });
}

const TERMINAL_RESERVATION_STATUSES = new Set(["DELIVERED", "CANCELLED"]);

export type CloseReservationResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "INVALID_STATE" };

// Extracted out of closeReservation (reservations/actions.ts), matching
// the releaseTicketForReservation extraction — a pure domain function,
// no session/formData access, callable directly from tests. The old
// version was a plain findUnique + unconditional update, entirely
// outside a transaction, with no lock: closing a reservation and
// releasing a ticket against that same reservation (production/actions.ts)
// could interleave with no coordination at all between them
// (RMR-R4-P1-01).
//
// Takes the exact same row lock releaseTicketForReservation takes on
// this Reservation, in the same order (lock first, then read/validate) —
// that's what actually makes the two mutually exclusive: whichever
// reaches the row first blocks the other until it commits, and the
// second one then re-reads guaranteed-fresh state instead of racing
// against a snapshot taken before the first one's write.
//
// allowedSiteId IS still session-derived data, not a session ACCESS —
// this function never calls getCurrentUser()/cookies() itself, the
// caller computes effectiveSiteId(user) and passes the plain value in
// (RMR-R5-P1-01). Keeping session access out of the domain function
// never meant authorization facts couldn't be inputs to it: the
// caller's own outer scope check (reservations/actions.ts) reads the
// reservation's siteId BEFORE this function ever takes its lock, so a
// site reassignment landing in that gap would otherwise let the old
// site's user close a reservation that had already moved to a site they
// have no authority over. Re-checked here, after the lock, against the
// SAME freshly-read row the terminal-state check itself uses — null
// means unrestricted (ADMIN), same convention as isSiteInScope.
export async function closeReservationForId(
  reservationId: string,
  opts: { actorId: string; actorRole: string; allowedSiteId: string | null; closeReasonCode: string; closeNote: string | null },
): Promise<CloseReservationResult> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
      if (locked.length === 0) return { status: "NOT_FOUND" as const };

      const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
      if (opts.allowedSiteId !== null && reservation.siteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
      if (TERMINAL_RESERVATION_STATUSES.has(reservation.status)) return { status: "INVALID_STATE" as const };

      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          status: "DELIVERED",
          closedAt: new Date(),
          closedById: opts.actorId,
          closeReasonCode: opts.closeReasonCode,
          closeNote: opts.closeNote,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorId: opts.actorId,
          role: opts.actorRole,
          module: "Reservations",
          recordId: reservationId,
          afterValue: `DELIVERED (closed early — ${opts.closeReasonCode})`,
          reasonCode: "RESERVATION_CLOSED",
        },
      });

      return { status: "OK" as const };
    },
    { timeout: 15000 },
  );
}

// Accepts an optional transaction client (see getReleasedVolumeM3's own
// comment) so a caller that needs this read and the reservation's own
// terminal-state update to be atomic — see finalizeReservationIfDelivered
// in src/lib/tripLifecycle.ts — can pass its own locked `tx` through
// instead of racing a plain snapshot read against a sibling trip's own
// concurrent close.
export async function isReservationFullyDelivered(reservationId: string, db: Db = prisma): Promise<boolean> {
  const reservation = await db.reservation.findUnique({
    where: { id: reservationId },
    include: { batchTickets: { where: { status: { not: "CANCELLED" } }, include: { trip: true } } },
  });
  if (!reservation) return false;

  const released = sumAcceptedVolumeM3(reservation.batchTickets);
  if (released < reservation.requestedVolumeM3 - VOLUME_EPSILON_M3) return false;

  return reservation.batchTickets.every((t) => t.trip?.status === "CLOSED");
}

// Shared by closeTripFullForId/closeTripWithReturnForId/
// decideWasteIncidentMemo (src/lib/tripLifecycle.ts) — folds the
// reservation-finalization step (PL-P1-05, first production-lifecycle
// review) into the SAME transaction as whatever trip close or quality
// decision might trigger it, rather than a separate, later, unconditional
// update against a plain snapshot read. Takes the Reservation row lock
// first: two sibling trips of the same split-load reservation closing
// concurrently each take this same lock in their own transaction, so
// whichever commits first is the only one that can see its own trip's
// fresh CLOSED status when it re-reads — the second one then sees BOTH
// trips closed (including the first's, already committed) and is the one
// that actually flips the reservation, exactly once. Never touches an
// already-CANCELLED reservation.
//
// PL-R2-P1-02, second production-lifecycle review — this used to be a
// one-way "flip to DELIVERED" only, which produced a real bug: a quality-
// rejected single-ticket reservation was finalized DELIVERED the instant
// its trip closed (full ticket volume, provisionally), and later Quality
// approval reduced the accepted volume without ever touching the
// reservation — leaving it DELIVERED and short, with no way to release
// the replacement quantity (releaseTicketForReservation only accepts
// CONFIRMED/IN_PRODUCTION). Two fixes close this:
//
// 1. A reservation is never finalized DELIVERED while any of its tickets
//    has a PENDING WasteIncidentMemo — the delivery decision is
//    genuinely unresolved until Quality decides, not just provisionally
//    complete.
// 2. If a reservation is ALREADY DELIVERED (via this same natural path —
//    closedAt null, i.e. never manually closed early by
//    closeReservationForId) but a later approved reduction now makes it
//    fall short of requestedVolumeM3, it's reopened to IN_PRODUCTION so
//    the shortfall can actually be released. A reservation that was
//    manually closed early (closedAt set) is never reopened this way —
//    that was a deliberate, accountable decision, not a side effect of
//    delivery-volume bookkeeping.
export async function reconcileReservationDeliveryState(tx: Prisma.TransactionClient, reservationId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
  if (locked.length === 0) return;

  const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { status: true, closedAt: true } });
  if (reservation.status === "CANCELLED") return;

  const hasPendingQualityMemo = await tx.wasteIncidentMemo.findFirst({ where: { status: "PENDING", batchTicket: { reservationId } } });
  const fullyDelivered = !hasPendingQualityMemo && (await isReservationFullyDelivered(reservationId, tx));

  if (fullyDelivered) {
    if (reservation.status !== "DELIVERED") await tx.reservation.update({ where: { id: reservationId }, data: { status: "DELIVERED" } });
    return;
  }

  if (reservation.status === "DELIVERED" && reservation.closedAt === null) {
    await tx.reservation.update({ where: { id: reservationId }, data: { status: "IN_PRODUCTION" } });
  }
}
