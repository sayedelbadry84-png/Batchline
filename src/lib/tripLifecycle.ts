import "server-only";
import { prisma } from "@/lib/prisma";
import { finalizeReservationIfDelivered } from "@/lib/reservations";

// See the same note on production/actions.ts's own TX_OPTIONS — a close
// can touch the Trip row, a DrumReturn, a WasteIncidentMemo, an
// AuditEvent, and (via finalizeReservationIfDelivered) the Reservation
// row plus a fresh read of every one of its sibling tickets/trips, all in
// one transaction. 15s gives real headroom on a cold Neon connection.
const TX_OPTIONS = { timeout: 15000 };

const NEXT_STATUS: Record<string, string> = {
  LOADING: "IN_TRANSIT",
  IN_TRANSIT: "ON_SITE",
  ON_SITE: "DISCHARGING",
};

// The allow-lists the UI itself already offers (see trips/page.tsx and
// the returnReasons/returnFates i18n dictionaries) — PL-P2-04, first
// production-lifecycle review flagged that the server accepted ANY
// non-empty string for either field, meaning a crafted request could
// write an arbitrary reasonCode/fate that no report or downstream logic
// was ever built to recognize.
export const RETURN_REASON_CODES = new Set(["CUSTOMER_CANCELLED", "SITE_NOT_READY", "OVER_ORDERED", "ACCESS_BLOCKED", "QUALITY_REJECTED", "TRAFFIC_DELAY", "OTHER"]);
export const RETURN_FATES = new Set(["DUMPED", "RECLAIMED"]);

type OwnershipOpts = { allowedSiteId: string | null; requireOwnDriverEmployeeId?: string | null };

export type AdvanceTripResult = { status: "OK"; next: string } | { status: "NOT_FOUND" } | { status: "NO_NEXT_STATE" };

// Extracted out of advanceTrip (trips/actions.ts) — a pure domain
// function, no session/formData access, so it's callable from tests
// directly. The old version read the trip's status, computed `next`, and
// wrote an unconditional update by ID with no row lock between the read
// and the write — a stale request racing a concurrent advance/close
// could overwrite a newer state (PL-P1-05). Locking the row first and
// re-reading inside that lock, same pattern as closeReservationForId,
// makes the read-compute-write sequence atomic instead.
export async function advanceTripState(tripId: string, opts: OwnershipOpts & { actorId: string; actorRole: string }): Promise<AdvanceTripResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, include: { batchTicket: { select: { plant: { select: { siteId: true } } } } } });
    // Out-of-scope and "not your own trip" both resolve to NOT_FOUND —
    // same "a scope mismatch behaves like not-found" convention as every
    // other domain function in this app (closeReservationForId,
    // releaseTicketForReservation): never disclose whether the record
    // exists to a caller with no authority over it.
    if (opts.allowedSiteId !== null && trip.batchTicket.plant.siteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (opts.requireOwnDriverEmployeeId && trip.driverId !== opts.requireOwnDriverEmployeeId) return { status: "NOT_FOUND" as const };

    const next = NEXT_STATUS[trip.status];
    if (!next) return { status: "NO_NEXT_STATE" as const };

    const timestampField = next === "IN_TRANSIT" ? "departTime" : next === "ON_SITE" ? "arriveTime" : "dischargeStart";
    await tx.trip.update({ where: { id: tripId }, data: { status: next, [timestampField]: new Date() } });
    await tx.auditEvent.create({ data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: tripId, field: "status", afterValue: next, reasonCode: "TRIP_ADVANCED" } });

    return { status: "OK" as const, next };
  }, TX_OPTIONS);
}

export type CloseTripFullResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "NOT_DISCHARGING" };

// Extracted out of closeTripFull (trips/actions.ts). Two real gaps this
// closes (PL-P1-05): the old version accepted a close from ANY status
// except CLOSED — the UI only ever shows the button once DISCHARGING,
// but nothing stopped a crafted request from closing straight out of
// LOADING — and the reservation finalization that follows now happens
// INSIDE the same transaction as the trip's own status flip (see
// finalizeReservationIfDelivered), instead of a later, separate,
// unconditional update that could overwrite an already-terminal
// (CANCELLED) reservation or race a sibling trip's own concurrent close.
//
// deliverySignedBy, when given, is written atomically with the close
// itself — the driver app used to stamp deliverySignedBy/deliverySignedAt
// in its OWN separate write before calling this at all, so a signature
// could land on file with no actual close if this half then refused.
export async function closeTripFullForId(
  tripId: string,
  opts: OwnershipOpts & { actorId: string; actorRole: string; deliverySignedBy?: string | null },
): Promise<CloseTripFullResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, include: { batchTicket: { include: { plant: true } } } });
    if (opts.allowedSiteId !== null && trip.batchTicket.plant.siteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (opts.requireOwnDriverEmployeeId && trip.driverId !== opts.requireOwnDriverEmployeeId) return { status: "NOT_FOUND" as const };
    // Recommended default (section 6 of the review): only a trip actually
    // at DISCHARGING may close as a full load — matches what the UI's own
    // picker already restricts this button to.
    if (trip.status !== "DISCHARGING") return { status: "NOT_DISCHARGING" as const };

    await tx.trip.update({
      where: { id: tripId },
      data: {
        status: "CLOSED",
        dischargeEnd: new Date(),
        volumeDeliveredM3: trip.batchTicket.volumeM3,
        ...(opts.deliverySignedBy ? { deliverySignedBy: opts.deliverySignedBy, deliverySignedAt: new Date() } : {}),
      },
    });
    await tx.auditEvent.create({
      data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: tripId, field: "status", afterValue: "CLOSED", reasonCode: "TRIP_CLOSED_FULL_LOAD" },
    });

    await finalizeReservationIfDelivered(tx, trip.batchTicket.reservationId);
    return { status: "OK" as const };
  }, TX_OPTIONS);
}

export type CloseTripWithReturnResult =
  | { status: "OK" }
  | { status: "NOT_FOUND" }
  | { status: "NOT_DISCHARGING" }
  | { status: "INVALID_VOLUME" }
  | { status: "RETURN_EXCEEDS_TICKET_VOLUME" }
  | { status: "INVALID_REASON_CODE" }
  | { status: "INVALID_FATE" };

// Extracted out of closeTripWithReturn (trips/actions.ts). Besides the
// same DISCHARGING-boundary and atomic-reservation-finalization fixes as
// closeTripFullForId above, this closes two more real gaps:
//
// PL-P1-06 — the old version reduced Trip.volumeDeliveredM3 (the
// customer's billed/accepted volume) the INSTANT a QUALITY_REJECTED
// return was logged, and this action allows DRIVER — meaning a driver
// could self-authorize an immediate billing reduction with no Quality
// sign-off at all. The full ticket volume is always billed here now;
// only Quality (or Admin) actually approving the resulting
// WasteIncidentMemo reduces it, atomically with that approval — see
// approveWasteMemo in quality/actions.ts.
//
// PL-P2-04 — reasonCode/fate are checked against the same closed
// allow-lists the UI's own dropdowns already offer (RETURN_REASON_CODES/
// RETURN_FATES above), rather than accepting any non-empty string.
export async function closeTripWithReturnForId(
  tripId: string,
  opts: OwnershipOpts & {
    actorId: string;
    actorRole: string;
    returnedVolumeM3: number;
    reasonCode: string | null;
    fate: string | null;
    deliverySignedBy?: string | null;
  },
): Promise<CloseTripWithReturnResult> {
  if (!Number.isFinite(opts.returnedVolumeM3) || opts.returnedVolumeM3 <= 0) return { status: "INVALID_VOLUME" };
  if (opts.reasonCode !== null && !RETURN_REASON_CODES.has(opts.reasonCode)) return { status: "INVALID_REASON_CODE" };
  if (opts.fate !== null && !RETURN_FATES.has(opts.fate)) return { status: "INVALID_FATE" };

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, include: { batchTicket: { include: { plant: true } } } });
    if (opts.allowedSiteId !== null && trip.batchTicket.plant.siteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (opts.requireOwnDriverEmployeeId && trip.driverId !== opts.requireOwnDriverEmployeeId) return { status: "NOT_FOUND" as const };
    if (trip.status !== "DISCHARGING") return { status: "NOT_DISCHARGING" as const };
    // A truck can't return more concrete than the ticket loaded it with —
    // an unbounded value here (typo, or a bad-faith over-claim) would flow
    // straight into disposition math.
    if (opts.returnedVolumeM3 > trip.batchTicket.volumeM3) return { status: "RETURN_EXCEEDS_TICKET_VOLUME" as const };

    const now = new Date();
    const minutesSinceBatch = Math.round((now.getTime() - trip.batchTime.getTime()) / 60000);
    const plant = trip.batchTicket.plant;

    // Return & discount policy from the design spec: full waste past the
    // drum timer window; no charge under the absorption threshold;
    // partial credit above it (pending accountant approval) otherwise. A
    // load rejected on quality grounds is the plant's own failure, not
    // the customer's — never charge for it regardless of how long it sat
    // in the drum.
    let disposition: string;
    if (opts.reasonCode === "QUALITY_REJECTED") disposition = "NO_CHARGE";
    else if (minutesSinceBatch > plant.drumTimerLimitMinutes) disposition = "FULL_WASTE";
    else if (opts.returnedVolumeM3 <= plant.returnAbsorptionThresholdM3) disposition = "NO_CHARGE";
    else disposition = "PARTIAL_CREDIT";

    await tx.trip.update({
      where: { id: tripId },
      data: {
        status: "CLOSED",
        dischargeEnd: now,
        // Always the full ticket volume now (PL-P1-06) — see this
        // function's own comment above for why a provisional quality
        // rejection no longer reduces this on its own.
        volumeDeliveredM3: trip.batchTicket.volumeM3,
        ...(opts.deliverySignedBy ? { deliverySignedBy: opts.deliverySignedBy, deliverySignedAt: now } : {}),
      },
    });
    const drumReturn = await tx.drumReturn.create({
      data: { tripId, returnedVolumeM3: opts.returnedVolumeM3, minutesSinceBatch, disposition, reasonCode: opts.reasonCode, fate: opts.fate },
    });
    // A quality rejection needs a formal, approvable incident record —
    // not just the disposition above — since "approved by Quality" is a
    // real state transition someone has to sign off on. Still PENDING
    // until that happens; see approveWasteMemo (quality/actions.ts) for
    // where the actual billing reduction now lives.
    if (opts.reasonCode === "QUALITY_REJECTED") {
      await tx.wasteIncidentMemo.create({
        data: { drumReturnId: drumReturn.id, batchTicketId: trip.batchTicketId, wastedVolumeM3: opts.returnedVolumeM3, reasonCode: opts.reasonCode },
      });
    }

    // PL-P1-06: the real authenticated actor and their real role, always
    // — never an impersonated "ACCOUNTANT"/"QUALITY_SUPERVISOR" the way
    // this used to log regardless of who actually closed the trip.
    // `reasonCode: disposition` is what actually flags which department
    // needs to review this, without borrowing their identity to do it.
    await tx.auditEvent.create({
      data: {
        actorId: opts.actorId,
        role: opts.actorRole,
        module: "Fleet",
        recordId: tripId,
        field: "drumReturn",
        afterValue: `${opts.returnedVolumeM3} m3 @ ${minutesSinceBatch}min`,
        reasonCode: disposition,
      },
    });

    await finalizeReservationIfDelivered(tx, trip.batchTicket.reservationId);
    return { status: "OK" as const };
  }, TX_OPTIONS);
}

export type ApproveWasteIncidentMemoResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "ALREADY_DECIDED" };

// Extracted out of approveWasteMemo (quality/actions.ts) — the OTHER half
// of the PL-P1-06 fix. closeTripWithReturnForId above never reduces
// Trip.volumeDeliveredM3 for a quality rejection any more; this is the
// one place that now does, atomically with Quality (or Admin) actually
// approving the WasteIncidentMemo that rejection created — never before
// that approval exists, and never twice for the same memo (the `status
// !== "PENDING"` guard is the atomic claim: a second approval attempt,
// or one racing a reject, simply finds the memo already decided).
export async function approveWasteIncidentMemo(
  memoId: string,
  opts: { allowedSiteId: string | null; actorId: string; actorRole: string; approvalNote: string },
): Promise<ApproveWasteIncidentMemoResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WasteIncidentMemo" WHERE "id" = ${memoId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const memo = await tx.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memoId }, include: { batchTicket: { include: { plant: true, trip: true } } } });
    if (opts.allowedSiteId !== null && memo.batchTicket.plant.siteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (memo.status !== "PENDING") return { status: "ALREADY_DECIDED" as const };

    await tx.wasteIncidentMemo.update({
      where: { id: memoId },
      data: { status: "APPROVED", approvalNote: opts.approvalNote, approvedAt: new Date(), approvedById: opts.actorId },
    });

    // The actual customer-billing reduction, deferred until exactly this
    // moment rather than applied the instant a driver logged the return.
    // Clamped at 0 and computed off the trip's OWN current
    // volumeDeliveredM3 (not a fresh recompute from the ticket) so this
    // stays correct even if it somehow runs more than once in sequence
    // for a ticket with more than one wasted-volume memo over its life.
    const trip = memo.batchTicket.trip;
    if (trip) {
      const reduced = Math.max(0, (trip.volumeDeliveredM3 ?? memo.batchTicket.volumeM3) - memo.wastedVolumeM3);
      await tx.trip.update({ where: { id: trip.id }, data: { volumeDeliveredM3: reduced } });
    }

    await tx.auditEvent.create({
      data: {
        actorId: opts.actorId,
        role: opts.actorRole,
        module: "Quality",
        recordId: memoId,
        afterValue: `${memo.wastedVolumeM3} m3 — ${memo.reasonCode} — ${opts.approvalNote}`,
        reasonCode: "WASTE_MEMO_APPROVED",
      },
    });

    return { status: "OK" as const };
  });
}

export type SetDrumReturnFateResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "INVALID_FATE" } | { status: "NOT_ELIGIBLE" } | { status: "ALREADY_CONSUMED" } | { status: "ALREADY_SET" };

// Extracted out of markDrumReturnFate (trips/actions.ts) — PL-P2-04. The
// old version accepted any non-empty string and could overwrite an
// already-set fate any number of times, including after the returned
// material had already been physically reused in a later trip
// (DrumReturn.consumedAt/consumedInTripId — see that model's own
// comment). fate is now a one-way decision (null -> a real value, never
// changed again) and is refused outright once consumedAt is set.
export async function setDrumReturnFateForId(
  drumReturnId: string,
  fate: string,
  opts: { allowedSiteId: string | null; actorId: string; actorRole: string },
): Promise<SetDrumReturnFateResult> {
  if (!RETURN_FATES.has(fate)) return { status: "INVALID_FATE" };

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DrumReturn" WHERE "id" = ${drumReturnId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const drumReturn = await tx.drumReturn.findUniqueOrThrow({ where: { id: drumReturnId }, include: { trip: { include: { batchTicket: { include: { plant: true } } } } } });
    if (opts.allowedSiteId !== null && drumReturn.trip.batchTicket.plant.siteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (drumReturn.disposition === "FULL_WASTE") return { status: "NOT_ELIGIBLE" as const };
    if (drumReturn.consumedAt) return { status: "ALREADY_CONSUMED" as const };
    if (drumReturn.fate) return { status: "ALREADY_SET" as const };

    await tx.drumReturn.update({ where: { id: drumReturnId }, data: { fate } });
    await tx.auditEvent.create({ data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: drumReturnId, field: "fate", afterValue: fate, reasonCode: "DRUM_RETURN_FATE_SET" } });

    return { status: "OK" as const };
  });
}
