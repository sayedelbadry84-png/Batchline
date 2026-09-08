import "server-only";
import { prisma } from "@/lib/prisma";
import { reconcileReservationDeliveryState } from "@/lib/reservations";
import { lockPlantSiteId } from "@/lib/siteScope";

// See the same note on production/actions.ts's own TX_OPTIONS — a close
// can touch the Trip row, a DrumReturn, a WasteIncidentMemo, an
// AuditEvent, and (via reconcileReservationDeliveryState) the Reservation
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
export const DELAY_REASONS = new Set(["TRAFFIC", "BREAKDOWN", "WEATHER", "ACCIDENT", "OTHER"]);

type OwnershipOpts = { allowedSiteId: string | null; requireOwnDriverEmployeeId?: string | null };

export type AdvanceableTripStatus = "LOADING" | "IN_TRANSIT" | "ON_SITE";

export type AdvanceTripResult = { status: "OK"; next: string } | { status: "NOT_FOUND" } | { status: "STALE_STATE" } | { status: "NO_NEXT_STATE" };

// Extracted out of advanceTrip (trips/actions.ts) — a pure domain
// function, no session/formData access, so it's callable from tests
// directly. Locks the row first and re-reads inside that lock, same
// pattern as closeReservationForId, so the read-compute-write sequence
// is atomic — that alone stops a STALE overwrite/regression (PL-P1-05),
// but it does not stop a genuine DUPLICATE request from applying twice:
// request A locks a LOADING trip and advances it to IN_TRANSIT; request
// B (a double-click, a retry, a replayed offline action) waits on the
// same row, then — once A commits — sees the now-current IN_TRANSIT and
// advances that same stale user intent again, straight to ON_SITE
// (PL-R2-P1-01, second production-lifecycle review).
//
// expectedStatus makes the caller's own intended source state part of
// the command, compared against the freshly LOCKED row — never trusted
// as authority on its own (a hidden form field is not a permission), just
// an optimistic-concurrency token: if the trip has already moved on from
// what the caller believed it was acting on, this returns STALE_STATE
// instead of silently advancing past the state the caller actually meant
// to act on.
export async function advanceTripState(
  tripId: string,
  expectedStatus: AdvanceableTripStatus,
  opts: OwnershipOpts & { actorId: string; actorRole: string },
): Promise<AdvanceTripResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, select: { status: true, driverId: true, batchTicket: { select: { plantId: true } } } });
    // Locked, not just joined — see lockPlantSiteId's own comment
    // (siteScope.ts) for why (PL-R2-P1-03, second production-lifecycle
    // review).
    const plantSiteId = await lockPlantSiteId(tx, trip.batchTicket.plantId);
    // Out-of-scope and "not your own trip" both resolve to NOT_FOUND —
    // same "a scope mismatch behaves like not-found" convention as every
    // other domain function in this app (closeReservationForId,
    // releaseTicketForReservation): never disclose whether the record
    // exists to a caller with no authority over it.
    if (opts.allowedSiteId !== null && plantSiteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (opts.requireOwnDriverEmployeeId && trip.driverId !== opts.requireOwnDriverEmployeeId) return { status: "NOT_FOUND" as const };

    if (trip.status !== expectedStatus) return { status: "STALE_STATE" as const };
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
// reconcileReservationDeliveryState), instead of a later, separate,
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

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, include: { batchTicket: true } });
    // Locked, not just joined (PL-R2-P1-03).
    const plantSiteId = await lockPlantSiteId(tx, trip.batchTicket.plantId);
    if (opts.allowedSiteId !== null && plantSiteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
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
    // The driver's own confirmation event, in the SAME transaction as the
    // close (PL-R6-P2-01, sixth production-lifecycle review) — used to be
    // a second logAudit call written by the driver Server Action AFTER
    // this transaction had already committed, so a failure on it left an
    // already-closed trip with no confirmation record, and a caller could
    // see a "failed" result for a close that had, in fact, already
    // succeeded. Only written when a signature is actually present — the
    // desktop/operator close path never sets deliverySignedBy.
    if (opts.deliverySignedBy) {
      await tx.auditEvent.create({
        data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: tripId, afterValue: opts.deliverySignedBy, reasonCode: "DELIVERY_CONFIRMED_FULL" },
      });
    }

    await reconcileReservationDeliveryState(tx, trip.batchTicket.reservationId);
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
  // A reason is mandatory for every returned quantity (the owner's own
  // recommended default, Round 1 section 6) — the domain used to accept
  // a null reasonCode as valid, and the database CHECK explicitly
  // permitted it too (PL-R2-P2-04, second production-lifecycle review).
  if (opts.reasonCode === null || !RETURN_REASON_CODES.has(opts.reasonCode)) return { status: "INVALID_REASON_CODE" };
  if (opts.fate !== null && !RETURN_FATES.has(opts.fate)) return { status: "INVALID_FATE" };

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, include: { batchTicket: { include: { plant: true } } } });
    // Locked, not just joined (PL-R2-P1-03).
    const plantSiteId = await lockPlantSiteId(tx, trip.batchTicket.plantId);
    if (opts.allowedSiteId !== null && plantSiteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
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
    // Same in-transaction driver-confirmation event as closeTripFullForId
    // above (PL-R6-P2-01) — was a second post-commit logAudit call.
    if (opts.deliverySignedBy) {
      await tx.auditEvent.create({
        data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: tripId, afterValue: opts.deliverySignedBy, reasonCode: "DELIVERY_CONFIRMED_WITH_RETURN" },
      });
    }

    await reconcileReservationDeliveryState(tx, trip.batchTicket.reservationId);
    return { status: "OK" as const };
  }, TX_OPTIONS);
}

export type DecideWasteIncidentMemoResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "ALREADY_DECIDED" };

// Extracted out of approveWasteMemo (quality/actions.ts) — the OTHER
// half of the PL-P1-06 fix, now a single command owning memo state, Trip
// volume, Reservation state, and audit atomically (PL-R2-P1-02, second
// production-lifecycle review — the review's own recommended shape).
// closeTripWithReturnForId above never reduces Trip.volumeDeliveredM3
// for a quality rejection any more; APPROVE here is the one place that
// now does, atomically with Quality (or Admin) actually approving the
// WasteIncidentMemo that rejection created. DENY leaves the delivered
// volume unchanged — a real denial path where a false suspicion can
// actually be resolved (previously PENDING was the only reachable
// non-APPROVED state, with no way out of it). Never decides the same
// memo twice (the `status !== "PENDING"` guard is the atomic claim: a
// second decision attempt, or one racing a denial, simply finds the
// memo already decided) — and either decision reconciles the owning
// Reservation's delivery state in the SAME transaction, so a single-
// ticket reservation that was finalized DELIVERED on the strength of a
// full provisional volume never sits DELIVERED-but-short with no way to
// release the shortfall once Quality actually approves the rejection.
export async function decideWasteIncidentMemo(
  memoId: string,
  decision: "APPROVE" | "DENY",
  opts: { allowedSiteId: string | null; actorId: string; actorRole: string; decisionNote: string },
): Promise<DecideWasteIncidentMemoResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WasteIncidentMemo" WHERE "id" = ${memoId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const memo = await tx.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memoId }, include: { batchTicket: { include: { trip: true } } } });
    // Locked, not just joined (PL-R2-P1-03).
    const plantSiteId = await lockPlantSiteId(tx, memo.batchTicket.plantId);
    if (opts.allowedSiteId !== null && plantSiteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (memo.status !== "PENDING") return { status: "ALREADY_DECIDED" as const };

    await tx.wasteIncidentMemo.update({
      where: { id: memoId },
      data: { status: decision === "APPROVE" ? "APPROVED" : "REJECTED", approvalNote: opts.decisionNote, approvedAt: new Date(), approvedById: opts.actorId },
    });

    if (decision === "APPROVE") {
      // The actual customer-billing reduction, deferred until exactly
      // this moment rather than applied the instant a driver logged the
      // return. Clamped at 0 and computed off the trip's OWN current
      // volumeDeliveredM3 (not a fresh recompute from the ticket) so this
      // stays correct even if it somehow runs more than once in sequence
      // for a ticket with more than one wasted-volume memo over its life.
      const trip = memo.batchTicket.trip;
      if (trip) {
        const reduced = Math.max(0, (trip.volumeDeliveredM3 ?? memo.batchTicket.volumeM3) - memo.wastedVolumeM3);
        await tx.trip.update({ where: { id: trip.id }, data: { volumeDeliveredM3: reduced } });
      }
    }
    // DENY: the delivered volume stays exactly as the trip close already
    // set it — a denied suspicion never reduces billed volume.

    // Either decision resolves this memo out of PENDING, which is what
    // was blocking finalization (see reconcileReservationDeliveryState's
    // own comment) — reconciling here lets a single-ticket reservation
    // finalize (deny) or reopen for the shortfall (approve) atomically
    // with the decision itself. Runs BEFORE the audit insert (PL-R4-P2-01,
    // fourth production-lifecycle review): the audit write used to be
    // last-but-one, so a failure-injection test aimed at it never actually
    // exercised reconciliation's own write, making its rollback claim
    // false. The audit insert is still the true last write, so it still
    // proves the whole transaction — memo, Trip, AND reconciliation —
    // rolls back together.
    await reconcileReservationDeliveryState(tx, memo.batchTicket.reservationId);

    await tx.auditEvent.create({
      data: {
        actorId: opts.actorId,
        role: opts.actorRole,
        module: "Quality",
        recordId: memoId,
        afterValue: `${memo.wastedVolumeM3} m3 — ${memo.reasonCode} — ${opts.decisionNote}`,
        reasonCode: decision === "APPROVE" ? "WASTE_MEMO_APPROVED" : "WASTE_MEMO_REJECTED",
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

    const drumReturn = await tx.drumReturn.findUniqueOrThrow({ where: { id: drumReturnId }, include: { trip: { include: { batchTicket: true } } } });
    // Locked, not just joined (PL-R2-P1-03).
    const plantSiteId = await lockPlantSiteId(tx, drumReturn.trip.batchTicket.plantId);
    if (opts.allowedSiteId !== null && plantSiteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
    if (drumReturn.disposition === "FULL_WASTE") return { status: "NOT_ELIGIBLE" as const };
    if (drumReturn.consumedAt) return { status: "ALREADY_CONSUMED" as const };
    if (drumReturn.fate) return { status: "ALREADY_SET" as const };

    await tx.drumReturn.update({ where: { id: drumReturnId }, data: { fate } });
    await tx.auditEvent.create({ data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: drumReturnId, field: "fate", afterValue: fate, reasonCode: "DRUM_RETURN_FATE_SET" } });

    return { status: "OK" as const };
  });
}

// PL-R8-P1-04, eighth production-lifecycle review: driver/actions.ts's
// own requireOwnTrip checked trip.driverId with a plain, unlocked read
// BEFORE either of these two actions opened their own (Round-7) audit-
// atomic transaction — a dispatch reassignment landing in that exact gap
// let the FORMER driver still attach a delay report or replace the
// delivery photo on a trip no longer theirs. Both commands below lock
// the Trip row first and re-verify ownership against that fresh,
// locked read — the SAME pattern closeTripFullForId/
// closeTripWithReturnForId already used for their own
// requireOwnDriverEmployeeId check, which this round's review confirmed
// was already correct.

export type ReportTripDelayResult =
  | { status: "OK"; reservationNumber: string; ticketNumber: string; projectName: string }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_REASON" };

export async function reportTripDelayForId(
  tripId: string,
  opts: { requireOwnDriverEmployeeId: string; reason: string; note: string | null; actorId: string; actorRole: string },
): Promise<ReportTripDelayResult> {
  if (!DELAY_REASONS.has(opts.reason)) return { status: "INVALID_REASON" };

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const trip = await tx.trip.findUniqueOrThrow({
      where: { id: tripId },
      include: { batchTicket: { select: { ticketNumber: true, reservation: { select: { reservationNumber: true, project: { select: { name: true } } } } } } },
    });
    // Fresh, locked read — not the Server Action's own pre-transaction
    // check — so a reassignment that lands in the gap before this lock
    // is acquired is exactly what this re-check catches.
    if (trip.driverId !== opts.requireOwnDriverEmployeeId) return { status: "NOT_FOUND" as const };

    await tx.tripDelayReport.create({ data: { tripId, reason: opts.reason, note: opts.note } });
    await tx.auditEvent.create({
      data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: tripId, afterValue: opts.reason, reasonCode: "TRIP_DELAY_REPORTED" },
    });

    return {
      status: "OK" as const,
      reservationNumber: trip.batchTicket.reservation.reservationNumber,
      ticketNumber: trip.batchTicket.ticketNumber,
      projectName: trip.batchTicket.reservation.project.name,
    };
  });
}

export type AttachDeliveryPhotoResult = { status: "OK"; oldUrl: string | null } | { status: "NOT_FOUND" };

// The blob itself is uploaded by the caller BEFORE this runs — external
// object storage isn't part of the Postgres transaction below and can't
// be — so this only ever receives the already-uploaded url to attach.
// Reading deliveryPhotoUrl AFTER acquiring the Trip lock (not before,
// and not from a separate pre-transaction read) is what makes a genuine
// two-upload race safe: whichever transaction's lock wins reads the
// OTHER's already-committed new URL as "old" once it's this one's turn,
// so the caller always deletes the exact intermediate blob it should,
// and only the truly final URL is ever left referenced.
export async function attachDeliveryPhotoForId(
  tripId: string,
  opts: { requireOwnDriverEmployeeId: string; url: string; actorId: string; actorRole: string },
): Promise<AttachDeliveryPhotoResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
    if (locked.length === 0) return { status: "NOT_FOUND" as const };

    const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, select: { driverId: true, deliveryPhotoUrl: true } });
    if (trip.driverId !== opts.requireOwnDriverEmployeeId) return { status: "NOT_FOUND" as const };

    const oldUrl = trip.deliveryPhotoUrl;
    await tx.trip.update({ where: { id: tripId }, data: { deliveryPhotoUrl: opts.url } });
    await tx.auditEvent.create({ data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: tripId, reasonCode: "DELIVERY_PHOTO_CAPTURED" } });

    return { status: "OK" as const, oldUrl };
  });
}
