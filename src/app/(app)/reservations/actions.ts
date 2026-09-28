"use server";

import { prisma } from "@/lib/prisma";
import { logAudit, writeAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { closeReservationForId } from "@/lib/reservations";
import { effectiveSiteId, isSiteInScope, reservationSiteScopeWhere } from "@/lib/siteScope";
import { evaluateCustomerCredit } from "@/lib/creditPolicy";
import { updateReservationForId, approveReservationFinalForId, cancelReservationForId } from "@/lib/reservationEdits";
import { redirect } from "next/navigation";
import { isPumpAvailable } from "@/lib/pumpSchedule";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";

// Shared by create and update — the pour-order details captured at intake,
// separate from the core project/mix/volume/window fields.
function readPourDetails(formData: FormData) {
  return {
    slumpRequestedMm: Number(formData.get("slumpRequestedMm") ?? 0) || null,
    slumpToleranceMm: Number(formData.get("slumpToleranceMm") ?? 0) || null,
    cementType: String(formData.get("cementType") ?? "").trim() || null,
    temperatureC: Number(formData.get("temperatureC") ?? 0) || null,
    siteLocation: String(formData.get("siteLocation") ?? "").trim() || null,
    siteLocationUrl: String(formData.get("siteLocationUrl") ?? "").trim() || null,
    siteContactName: String(formData.get("siteContactName") ?? "").trim() || null,
    siteContactPhone: String(formData.get("siteContactPhone") ?? "").trim() || null,
    deliveryMethod: String(formData.get("deliveryMethod") ?? "CHUTE"),
    structuralElement: String(formData.get("structuralElement") ?? "").trim() || null,
    structureType: String(formData.get("structureType") ?? "").trim() || null,
    minPumpReachM: Number(formData.get("minPumpReachM") ?? 0) || null,
    labTechnicianRequired: formData.get("labTechnicianRequired") === "on",
  };
}

// A reservation can only be opened for a customer+mix pair that already
// has a price on file — PriceListEntry now tracks the customer's last
// approved, still-valid quote automatically (see markQuoteSent in the
// Sales module), so its mere existence *is* "present in the customer's
// valid price offer"; there's no separate expiry to check here.
async function hasPriceOnFile(customerId: string, mixId: string): Promise<boolean> {
  const entry = await prisma.priceListEntry.findUnique({ where: { customerId_mixId: { customerId, mixId } } });
  return !!entry;
}

// A reservation is booked against a Plant (factory — see the model
// comment in schema.prisma), never a specific Station: which station
// actually produces it is decided later, at batch-ticket release time in
// Production. So the only site-scope guard needed here is on the
// submitted siteId directly.
export async function createReservation(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "create");

  const projectId = String(formData.get("projectId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const requestedVolumeM3 = Number(formData.get("requestedVolumeM3") ?? 0);
  const pourWindowStartRaw = String(formData.get("pourWindowStart") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!projectId || !siteId || !mixId || !pourWindowStartRaw) return;
  // `!requestedVolumeM3` let -1 and Infinity through (audit of f955650,
  // N1): a negative booking was stored CONFIRMED and consumed no credit.
  if (!Number.isFinite(requestedVolumeM3) || requestedVolumeM3 <= 0) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { customer: true } });
  if (!project) return;
  if (!(await hasPriceOnFile(project.customer.id, mixId))) return;

  const pourWindowStart = new Date(pourWindowStartRaw);

  // Pump(s) reserved for this job right now, from the New Booking modal's
  // repeatable pump rows (PumpBookingRows) — each row posts under the same
  // three field names, read back here as parallel arrays. A row where the
  // pump was never actually picked (still on its placeholder) is skipped
  // rather than creating an empty assignment.
  const pumpIds = formData.getAll("pumpId").map(String);
  const pumpOperatorIds = formData.getAll("pumpOperatorId").map(String);
  const pumpAssistantIds = formData.getAll("pumpAssistantId").map(String);
  const pumpRows = pumpIds
    .map((pumpId, i) => ({
      pumpId,
      pumpOperatorId: pumpOperatorIds[i] || null,
      pumpAssistantId: pumpAssistantIds[i] || null,
    }))
    .filter((row) => row.pumpId);

  // Nothing before this checked that a chosen pump isn't already
  // committed to another job around the same time — the exact same
  // double-booking risk truck/reservation-volume races already had
  // elsewhere, just for a pump instead. Refuses the whole booking rather
  // than silently dropping the conflicting pump row, since a PUMP
  // delivery method with no pump actually booked isn't a state this form
  // should produce.
  const pumpIdSet = new Set<string>();
  for (const row of pumpRows) {
    if (pumpIdSet.has(row.pumpId)) return;
    pumpIdSet.add(row.pumpId);
  }

  // Serializable, and the availability check re-run INSIDE the same
  // transaction that creates the assignments: a plain check-then-create
  // (what this used to be) lets two concurrent bookings for the same pump
  // and overlapping window both read "available" before either commits,
  // double-booking it. Under Serializable, Postgres detects the
  // read-write conflict and aborts one with P2034, which falls through to
  // the silent-return below like every other rejected submission here.
  //
  // Credit is decided in the same transaction (creditPolicy.ts): a
  // booking that does not fit under the customer's limit, counting
  // everything already committed, gets an ON_HOLD reservation, which
  // only final approval, re-checking credit, can clear. The audit row
  // commits with the reservation; it used to be written afterwards.
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const row of pumpRows) {
          if (!(await isPumpAvailable(tx, row.pumpId, pourWindowStart))) throw new Error("PUMP_UNAVAILABLE");
        }
        const credit = await evaluateCustomerCredit(tx, project.customer.id, { kind: "NEW_BOOKING", mixId, siteId, volumeM3: requestedVolumeM3 });
        if (!credit) throw new Error("CUSTOMER_NOT_FOUND");
        const overCreditLimit = credit.status === "OVER_LIMIT";
        const reservation = await withSequentialNumber(
          "RES",
          (yr) => tx.reservation.count({ where: { createdAt: yr } }),
          (reservationNumber) =>
            tx.reservation.create({
              data: {
                reservationNumber,
                projectId,
                siteId,
                mixId,
                requestedVolumeM3,
                originalVolumeM3: requestedVolumeM3,
                pourWindowStart,
                notes,
                status: overCreditLimit ? "ON_HOLD" : "CONFIRMED",
                ...readPourDetails(formData),
                pumpAssignments: pumpRows.length
                  ? { create: pumpRows.map((row) => ({ ...row, scheduledStart: pourWindowStart })) }
                  : undefined,
              },
            }),
        );
        await writeAudit(tx, { id: user!.id, role: user!.role }, {
          module: "Reservations",
          recordId: reservation.id,
          afterValue: `${requestedVolumeM3} m3`,
          reasonCode: overCreditLimit ? "CREDIT_HOLD" : "RESERVATION_CREATED",
        });
      },
      { isolationLevel: "Serializable" },
    );
  } catch {
    return;
  }

  revalidatePath("/reservations");
}

// Editable at any point in the delivery lifecycle short of CANCELLED —
// including after partial release, so a site's actual pour can be scaled
// up or down mid-job, AND after DELIVERED, so a detail can still be fixed
// after the fact. What the edit may NOT do is change the status, except to
// place a hold: see allowedEditStatuses and updateReservationForId in
// src/lib/reservationEdits.ts, which also carries the rule that requested
// volume never drops below what has been released and that a released
// reservation's project, mix and site are frozen, all checked under the
// Reservation row lock release takes.
//
// A refusal used to reload the page as if it had worked. Each result now
// comes back as a banner on the reservations page.
function reservationsResultPath(code: string) {
  return `/reservations?${new URLSearchParams({ reservationResult: code }).toString()}`;
}

export async function updateReservation(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "edit");

  const id = String(formData.get("id") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const requestedVolumeM3 = Number(formData.get("requestedVolumeM3") ?? 0);
  const pourWindowStartRaw = String(formData.get("pourWindowStart") ?? "");
  const statusRaw = formData.get("status");
  if (!id || !projectId || !siteId || !mixId || !pourWindowStartRaw) redirect(reservationsResultPath("INVALID_INPUT"));

  const result = await updateReservationForId(
    id,
    {
      projectId,
      siteId,
      mixId,
      requestedVolumeM3,
      pourWindowStart: new Date(pourWindowStartRaw),
      status: typeof statusRaw === "string" && statusRaw !== "" ? statusRaw : undefined,
      pourDetails: readPourDetails(formData),
    },
    { id: user!.id, role: user!.role, allowedSiteId: effectiveSiteId(user) },
  );

  revalidatePath("/reservations");
  revalidatePath("/production");
  if (result.status !== "OK") redirect(reservationsResultPath(result.status));
}

// The only way to cancel a booking. It used to be "pick CANCELLED in the
// edit form", with nothing checking that no concrete had been released.
export async function cancelReservation(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "cancel");

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const result = await cancelReservationForId(id, { id: user!.id, role: user!.role, allowedSiteId: effectiveSiteId(user) });

  revalidatePath("/reservations");
  revalidatePath("/production");
  redirect(reservationsResultPath(result.status === "OK" ? "CANCELLED" : result.status));
}

// One-click "end this reservation now" for a booking that's done in
// practice even though the requested volume was never fully delivered
// (e.g. the site decided they don't need the rest of the pour). Doesn't
// touch requestedVolumeM3, so there's no released-volume floor to check —
// unlike updateReservation, which blocks shrinking the volume below what
// already went out, closing early has nothing to shrink.
export async function closeReservation(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "edit");

  const id = String(formData.get("id") ?? "");
  const closeReasonCode = String(formData.get("closeReasonCode") ?? "").trim();
  const closeNote = String(formData.get("closeNote") ?? "").trim() || null;
  if (!id || !closeReasonCode) return;

  // Scope is still checked here too, up front, from the picker's own
  // listed options — a cheap, informative reject before ever taking the
  // row lock. But that alone isn't enough (RMR-R5-P1-01): this read and
  // the lock closeReservationForId takes are two separate round trips,
  // and the reservation could be reassigned to a different site in that
  // gap. The allowedSiteId passed below is re-checked AFTER the lock,
  // against the same freshly-read row the terminal-state check itself
  // uses — this is the actual authoritative check; the one here is only
  // a fast, friendly pre-reject.
  const allowedSiteId = effectiveSiteId(user);
  const reservation = await prisma.reservation.findUnique({ where: { id }, select: { siteId: true } });
  if (!reservation) return;
  if (!isSiteInScope(reservation.siteId, allowedSiteId)) return;

  await closeReservationForId(id, { actorId: user!.id, actorRole: user!.role, allowedSiteId, closeReasonCode, closeNote });

  revalidatePath("/reservations");
  revalidatePath("/production");
}

// "مسئول الحجوزات" — the reservations officer confirming the booking
// itself (project, mix, volume, site details) is correct and ready to
// move forward. First of the two required sign-offs.
export async function approveReservationInitial(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "approveInitial");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation || reservation.initialApprovedAt) return;
  if (!isSiteInScope(reservation.siteId, effectiveSiteId(user))) return;

  await prisma.reservation.update({
    where: { id },
    data: { initialApprovedAt: new Date(), initialApprovedById: user!.id },
  });

  await logAudit({ module: "Reservations", recordId: id, reasonCode: "RESERVATION_INITIAL_APPROVED" });
  revalidatePath("/reservations");
  revalidatePath("/production");
}

// "مدير التشغيل" — operations management's final clearance. Only
// meaningful once the initial approval is already on file; a reservation
// only becomes releasable in Production once both are set (see
// isReservationApproved in src/lib/reservations.ts). Whether the same
// person may clear both stages of one reservation is a permissions
// question, not a rule hardcoded here — requireActionPermission above is
// the only gate: a role granted both approveInitial and approveFinal (see
// the Permissions screen) may complete both on the same record.
export async function approveReservationFinal(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "approveFinal");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // ON_HOLD is a "needs review" marker, set when the customer was at or
  // over their credit limit at booking, or placed by hand. Final approval
  // IS that review, so it clears the hold, but only after deciding credit
  // again, unconditionally and inside its own transaction: a reservation
  // that started CONFIRMED has never had its credit re-checked since, and
  // the balance can only have grown. A real payment recorded in Finance is
  // what unblocks an over-limit customer, not a click here. See
  // approveReservationFinalForId (src/lib/reservationEdits.ts).
  const result = await approveReservationFinalForId(id, { id: user!.id, role: user!.role, allowedSiteId: effectiveSiteId(user) });

  revalidatePath("/reservations");
  revalidatePath("/production");
  if (result.status !== "OK") redirect(reservationsResultPath(result.status));
}

// Fired from the "due for reminder" panel's send button — the WhatsApp
// message itself is opened client-side via a wa.me link (no WhatsApp
// Business API account is wired up, see WhatsAppShareButton), so all this
// records is that a human actually clicked send, taking the reservation
// out of reservationsDueForReminder's list. Same "edit" permission as the
// rest of the booking, since this is just another field on the record.
export async function markReservationReminderSent(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "edit");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // BL-CR-P1-02, external-review validation: role permission is not site
  // permission. Without the scope in this write's own WHERE clause, a
  // reservations user at one site could stamp another site's reservation
  // as "reminder sent" and suppress the reminder its own customer was
  // owed. A miss writes nothing and reports nothing, exactly like an id
  // that does not exist.
  const marked = await prisma.reservation.updateMany({
    where: { id, ...reservationSiteScopeWhere(effectiveSiteId(user)) },
    data: { reminderSentAt: new Date() },
  });
  if (marked.count !== 1) return;
  await logAudit({ module: "Reservations", recordId: id, reasonCode: "RESERVATION_REMINDER_SENT" });
  revalidatePath("/reservations");
}
