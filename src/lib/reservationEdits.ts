import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { getReleasedVolumeM3 } from "@/lib/reservations";
import { isSiteInScope, reservationSiteScopeWhere } from "@/lib/siteScope";
import { evaluateProjectCredit } from "@/lib/creditPolicy";

// Domain functions behind the reservation edit, final-approval and cancel
// actions (reservations/actions.ts). No session access: the caller passes
// the actor and effectiveSiteId(user) in, so tests exercise the real logic.
//
// All three take the Reservation row lock that releaseTicketForReservation
// and closeReservationForId take, in the same order (lock, then read and
// validate), so an edit and a release against the same reservation can
// never interleave: whichever locks first commits first, and the other
// re-reads the result. updateReservation used to read the row, check it
// against a separately read released volume, and then write by primary
// key, so a ticket released in between let a reservation's project, mix
// or site change after concrete had already been produced for it.

export type ReservationActor = { id: string; role: string; allowedSiteId: string | null };

type Tx = Prisma.TransactionClient;

// Every status a reservation can hold, and who may move it where. The
// edit form used to post any string as the new status, so a user with
// edit permission could move ON_HOLD to CONFIRMED (skipping the credit
// check that put it on hold), or straight to DELIVERED or CANCELLED
// (skipping the close and cancel workflows and their locks). Each
// transition now belongs to one server path:
//
//   ON_HOLD / REQUESTED -> CONFIRMED  final approval, which re-checks credit
//   CONFIRMED -> IN_PRODUCTION        releasing the first ticket
//   * -> DELIVERED                    closeReservation / trip reconciliation
//   pre-production -> CANCELLED       cancelReservation, only with nothing released
//   REQUESTED / CONFIRMED -> ON_HOLD  the edit form (the only change it may make)
//
// Placing a hold is the one status change the edit form keeps, because it
// only ever restricts: an ON_HOLD reservation cannot be released. It also
// withdraws the final approval, so the hold can only be lifted through
// final approval and its credit check, never by editing the status back.
export const RESERVATION_STATUSES = ["REQUESTED", "CONFIRMED", "ON_HOLD", "IN_PRODUCTION", "DELIVERED", "CANCELLED"] as const;

export function allowedEditStatuses(current: string): string[] {
  if (current === "REQUESTED" || current === "CONFIRMED") return [current, "ON_HOLD"];
  return [current];
}

// Statuses from which a reservation may be cancelled, provided nothing
// has been released against it. IN_PRODUCTION is included for the case
// where every ticket released against it was itself cancelled.
const CANCELLABLE_STATUSES = new Set(["REQUESTED", "CONFIRMED", "ON_HOLD", "IN_PRODUCTION"]);

class Abort<R> extends Error {
  constructor(public result: R) {
    super("reservation edit refused");
  }
}

async function lockAndRead(tx: Tx, id: string, allowedSiteId: string | null) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Reservation" WHERE "id" = ${id} FOR UPDATE`;
  if (locked.length === 0) return null;
  // Scoped AFTER the lock, from the row as it now is: a reservation moved
  // to another site while this waited is indistinguishable from one that
  // does not exist.
  return tx.reservation.findFirst({ where: { id, ...reservationSiteScopeWhere(allowedSiteId) } });
}

async function hasPriceOnFile(tx: Tx, customerId: string, mixId: string): Promise<boolean> {
  return !!(await tx.priceListEntry.findUnique({ where: { customerId_mixId: { customerId, mixId } } }));
}

// ---- Edit ---------------------------------------------------------------

export type ReservationPourDetails = Omit<Prisma.ReservationUncheckedUpdateInput, "id" | "status" | "projectId" | "siteId" | "mixId" | "requestedVolumeM3" | "pourWindowStart">;

export type UpdateReservationInput = {
  projectId: string;
  siteId: string;
  mixId: string;
  requestedVolumeM3: number;
  pourWindowStart: Date;
  // Omitted means "leave the status as it is".
  status?: string;
  pourDetails: ReservationPourDetails;
};

export type UpdateReservationResult =
  | { status: "OK" }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_INPUT" }
  | { status: "TERMINAL" }
  | { status: "STATUS_NOT_ALLOWED" }
  | { status: "NO_PRICE_ON_FILE" }
  | { status: "BELOW_RELEASED" }
  | { status: "FROZEN_AFTER_RELEASE" };

export async function updateReservationForId(id: string, input: UpdateReservationInput, actor: ReservationActor): Promise<UpdateReservationResult> {
  if (!Number.isFinite(input.requestedVolumeM3) || input.requestedVolumeM3 <= 0 || Number.isNaN(input.pourWindowStart.getTime())) {
    return { status: "INVALID_INPUT" };
  }
  // The destination site is form data: it must be one the actor may book
  // at. Reported like an unknown reservation, so it confirms nothing.
  if (!isSiteInScope(input.siteId, actor.allowedSiteId)) return { status: "NOT_FOUND" };

  try {
    await prisma.$transaction(async (tx) => {
      const reservation = await lockAndRead(tx, id, actor.allowedSiteId);
      if (!reservation) throw new Abort<UpdateReservationResult>({ status: "NOT_FOUND" });
      if (reservation.status === "CANCELLED") throw new Abort<UpdateReservationResult>({ status: "TERMINAL" });

      const nextStatus = input.status ?? reservation.status;
      if (nextStatus !== reservation.status && !allowedEditStatuses(reservation.status).includes(nextStatus)) {
        throw new Abort<UpdateReservationResult>({ status: "STATUS_NOT_ALLOWED" });
      }

      const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { customerId: true } });
      if (!project) throw new Abort<UpdateReservationResult>({ status: "INVALID_INPUT" });
      // Grandfather in a reservation's existing customer+mix pair (it may
      // predate the price-on-file rule, or its PriceListEntry may since
      // have been removed): only a pair actually being changed to has to
      // clear the gate.
      const currentProject =
        reservation.projectId === input.projectId ? project : await tx.project.findUnique({ where: { id: reservation.projectId }, select: { customerId: true } });
      const isSamePair = reservation.mixId === input.mixId && currentProject?.customerId === project.customerId;
      if (!isSamePair && !(await hasPriceOnFile(tx, project.customerId, input.mixId))) {
        throw new Abort<UpdateReservationResult>({ status: "NO_PRICE_ON_FILE" });
      }

      // Read under the lock release also takes, so it includes every
      // ticket that will ever have been released before this write.
      const released = await getReleasedVolumeM3(id, tx);
      if (input.requestedVolumeM3 < released) throw new Abort<UpdateReservationResult>({ status: "BELOW_RELEASED" });

      // Once any concrete has been produced against this booking, its
      // project, mix and site are what a real batch ticket says it was
      // made for. Changing them would rewrite that ticket's meaning after
      // the fact instead of being the new booking it actually is.
      const identityChanged = input.projectId !== reservation.projectId || input.mixId !== reservation.mixId || input.siteId !== reservation.siteId;
      if (released > 0 && identityChanged) throw new Abort<UpdateReservationResult>({ status: "FROZEN_AFTER_RELEASE" });

      // A meaningful change to what was signed off on invalidates the
      // sign-off. Placing a hold withdraws the final approval only, so the
      // hold is lifted through final approval and its credit check.
      const volumeChanged = input.requestedVolumeM3 !== reservation.requestedVolumeM3;
      const approvalsInvalidated = (identityChanged || volumeChanged) && (reservation.initialApprovedAt || reservation.finalApprovedAt);
      const placingHold = nextStatus === "ON_HOLD" && reservation.status !== "ON_HOLD";

      await tx.reservation.update({
        where: { id },
        data: {
          ...input.pourDetails,
          projectId: input.projectId,
          siteId: input.siteId,
          mixId: input.mixId,
          requestedVolumeM3: input.requestedVolumeM3,
          pourWindowStart: input.pourWindowStart,
          status: nextStatus,
          ...(approvalsInvalidated
            ? { initialApprovedAt: null, initialApprovedById: null, finalApprovedAt: null, finalApprovedById: null }
            : placingHold
              ? { finalApprovedAt: null, finalApprovedById: null }
              : {}),
        },
      });

      const auditActor = { id: actor.id, role: actor.role };
      if (approvalsInvalidated) {
        await writeAudit(tx, auditActor, { module: "Reservations", recordId: id, field: "approvals", reasonCode: "RESERVATION_APPROVALS_INVALIDATED_ON_EDIT" });
      }
      if (placingHold) {
        await writeAudit(tx, auditActor, { module: "Reservations", recordId: id, field: "status", beforeValue: reservation.status, afterValue: "ON_HOLD", reasonCode: "RESERVATION_PLACED_ON_HOLD" });
      }
      await writeAudit(tx, auditActor, {
        module: "Reservations",
        recordId: id,
        afterValue: `${input.requestedVolumeM3} m3, ${nextStatus}`,
        reasonCode: "RESERVATION_UPDATED",
      });
    });
    return { status: "OK" };
  } catch (e) {
    if (e instanceof Abort) return e.result as UpdateReservationResult;
    throw e;
  }
}

// ---- Final approval ---------------------------------------------------

export type ApproveFinalResult =
  | { status: "OK" }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_STATE" }
  | { status: "CREDIT_HOLD" };

// Final approval is the one path that may lift a hold, so it decides credit
// from the same transaction as its write. It used to read the balance,
// then update by primary key; the approval could land on a reservation
// whose state had changed in between.
export async function approveReservationFinalForId(id: string, actor: ReservationActor): Promise<ApproveFinalResult> {
  try {
    await prisma.$transaction(async (tx) => {
      const reservation = await lockAndRead(tx, id, actor.allowedSiteId);
      if (!reservation) throw new Abort<ApproveFinalResult>({ status: "NOT_FOUND" });
      if (!reservation.initialApprovedAt || reservation.finalApprovedAt) throw new Abort<ApproveFinalResult>({ status: "INVALID_STATE" });
      if (reservation.status === "DELIVERED" || reservation.status === "CANCELLED") throw new Abort<ApproveFinalResult>({ status: "INVALID_STATE" });

      // The reservation's own remaining volume is the proposal; whatever
      // else the customer has committed is the exposure it must fit beside.
      const credit = await evaluateProjectCredit(tx, reservation.projectId, { kind: "RESERVATION", reservationId: id });
      if (!credit || credit.status === "OVER_LIMIT") throw new Abort<ApproveFinalResult>({ status: "CREDIT_HOLD" });

      await tx.reservation.update({
        where: { id },
        data: {
          finalApprovedAt: new Date(),
          finalApprovedById: actor.id,
          status: reservation.status === "ON_HOLD" || reservation.status === "REQUESTED" ? "CONFIRMED" : reservation.status,
        },
      });
      await writeAudit(tx, { id: actor.id, role: actor.role }, { module: "Reservations", recordId: id, reasonCode: "RESERVATION_FINAL_APPROVED" });
    });
    return { status: "OK" };
  } catch (e) {
    if (e instanceof Abort) return e.result as ApproveFinalResult;
    throw e;
  }
}

// ---- Cancel -------------------------------------------------------------

export type CancelReservationResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "INVALID_STATE" } | { status: "HAS_RELEASED_VOLUME" };

// Cancelling used to be "pick CANCELLED in the edit form", with no check
// that nothing had been produced. A reservation with concrete released
// against it is closed (closeReservation), not cancelled.
export async function cancelReservationForId(id: string, actor: ReservationActor): Promise<CancelReservationResult> {
  try {
    await prisma.$transaction(async (tx) => {
      const reservation = await lockAndRead(tx, id, actor.allowedSiteId);
      if (!reservation) throw new Abort<CancelReservationResult>({ status: "NOT_FOUND" });
      if (!CANCELLABLE_STATUSES.has(reservation.status)) throw new Abort<CancelReservationResult>({ status: "INVALID_STATE" });
      const activeTickets = await tx.batchTicket.count({ where: { reservationId: id, status: { not: "CANCELLED" } } });
      if (activeTickets > 0) throw new Abort<CancelReservationResult>({ status: "HAS_RELEASED_VOLUME" });

      await tx.reservation.update({ where: { id }, data: { status: "CANCELLED" } });
      await writeAudit(tx, { id: actor.id, role: actor.role }, {
        module: "Reservations",
        recordId: id,
        field: "status",
        beforeValue: reservation.status,
        afterValue: "CANCELLED",
        reasonCode: "RESERVATION_CANCELLED",
      });
    });
    return { status: "OK" };
  } catch (e) {
    if (e instanceof Abort) return e.result as CancelReservationResult;
    throw e;
  }
}
