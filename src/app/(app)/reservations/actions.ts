"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { getReleasedVolumeM3 } from "@/lib/reservations";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { getCustomerOutstandingBalance } from "@/lib/billing";
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

  if (!projectId || !siteId || !mixId || !requestedVolumeM3 || !pourWindowStartRaw) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  // Credit check: the customer's real outstanding balance (unpaid invoice
  // total, see getCustomerOutstandingBalance) must still be under their
  // credit limit — a reservation booked while already over goes ON_HOLD
  // instead of straight to CONFIRMED, same shape as the "no balance"
  // cancel-pending state seen in the Dynamics comparison data.
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { customer: true } });
  if (!project) return;
  if (!(await hasPriceOnFile(project.customer.id, mixId))) return;
  const outstandingBalance = await getCustomerOutstandingBalance(project.customer.id);
  const overCreditLimit = outstandingBalance >= project.customer.creditLimit;

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
    if (!(await isPumpAvailable(prisma, row.pumpId, pourWindowStart))) return;
  }

  const reservation = await withSequentialNumber(
    "RES",
    () => prisma.reservation.count(),
    (reservationNumber) =>
      prisma.reservation.create({
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

  await logAudit({
    module: "Reservations",
    recordId: reservation.id,
    afterValue: `${requestedVolumeM3} m3`,
    reasonCode: overCreditLimit ? "CREDIT_HOLD" : "RESERVATION_CREATED",
  });

  revalidatePath("/reservations");
}

// Editable at any point in the delivery lifecycle short of CANCELLED —
// including after partial release, so a site's actual pour can be scaled
// up or down mid-job, AND after DELIVERED, so a detail can still be fixed
// after the fact (e.g. from the grouped delivery log in Production). The
// one hard rule: requested volume can never drop below what's already
// gone out as a batch ticket, since that concrete is already real and
// can't un-happen.
export async function updateReservation(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "reservations", "edit");

  const id = String(formData.get("id") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const requestedVolumeM3 = Number(formData.get("requestedVolumeM3") ?? 0);
  const pourWindowStartRaw = String(formData.get("pourWindowStart") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!id || !projectId || !siteId || !mixId || !requestedVolumeM3 || !pourWindowStartRaw || !status) return;

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation) return;
  if (reservation.status === "CANCELLED") return;
  const effSiteId = effectiveSiteId(user);
  if (!isSiteInScope(reservation.siteId, effSiteId) || !isSiteInScope(siteId, effSiteId)) return;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { customerId: true } });
  if (!project) return;
  // Grandfather in a reservation's existing customer+mix pair (it may
  // predate the price-on-file rule, or its PriceListEntry may since have
  // been removed) — only a pair actually being changed to has to clear
  // the gate; editing volume/status/dates on an old booking must never
  // get silently blocked by a rule that didn't exist when it was made.
  const currentProject = reservation.projectId === projectId ? project : await prisma.project.findUnique({ where: { id: reservation.projectId }, select: { customerId: true } });
  const isSamePair = reservation.mixId === mixId && currentProject?.customerId === project.customerId;
  if (!isSamePair && !(await hasPriceOnFile(project.customerId, mixId))) return;

  const released = await getReleasedVolumeM3(id);
  if (requestedVolumeM3 < released) return; // can't shrink below what's already gone out

  await prisma.reservation.update({
    where: { id },
    data: {
      projectId,
      siteId,
      mixId,
      requestedVolumeM3,
      pourWindowStart: new Date(pourWindowStartRaw),
      status,
      ...readPourDetails(formData),
    },
  });

  await logAudit({
    module: "Reservations",
    recordId: id,
    afterValue: `${requestedVolumeM3} m3, ${status}`,
    reasonCode: "RESERVATION_UPDATED",
  });

  revalidatePath("/reservations");
  revalidatePath("/production");
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

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation) return;
  if (["DELIVERED", "CANCELLED"].includes(reservation.status)) return;
  const effSiteId = effectiveSiteId(user);
  if (!isSiteInScope(reservation.siteId, effSiteId)) return;

  await prisma.reservation.update({
    where: { id },
    data: {
      status: "DELIVERED",
      closedAt: new Date(),
      closedById: user!.id,
      closeReasonCode,
      closeNote,
    },
  });

  await logAudit({
    module: "Reservations",
    recordId: id,
    afterValue: `DELIVERED (closed early — ${closeReasonCode})`,
    reasonCode: "RESERVATION_CLOSED",
  });

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

  const reservation = await prisma.reservation.findUnique({ where: { id }, include: { project: { include: { customer: true } } } });
  if (!reservation || !reservation.initialApprovedAt || reservation.finalApprovedAt) return;
  if (!isSiteInScope(reservation.siteId, effectiveSiteId(user))) return;

  // ON_HOLD is an automatic flag set at creation (see createReservation's
  // credit-limit check) — it's a "needs review" marker, not a separate
  // veto that survives review. Final approval IS that review completing
  // successfully, so it clears the hold too; otherwise an approved
  // reservation would sit invisible to Production forever; the listing
  // there only ever shows CONFIRMED/IN_PRODUCTION (see readyReservationsRaw
  // in production/page.tsx). But that credit check was only ever run once,
  // at creation — clearing the hold here used to trust that stale flag
  // outright rather than re-checking whether the customer is still over
  // limit right now (their balance can only have grown in the meantime, or
  // stayed the same; it never falls without a real payment being
  // recorded). If they're still over, refuse the final approval entirely
  // rather than silently rubber-stamping past a still-real credit problem
  // — a real payment recorded in Finance is what should unblock this, not
  // a click here.
  if (reservation.status === "ON_HOLD") {
    const outstandingBalance = await getCustomerOutstandingBalance(reservation.project.customer.id);
    if (outstandingBalance >= reservation.project.customer.creditLimit) return;
  }

  await prisma.reservation.update({
    where: { id },
    data: {
      finalApprovedAt: new Date(),
      finalApprovedById: user!.id,
      status: reservation.status === "ON_HOLD" ? "CONFIRMED" : reservation.status,
    },
  });

  await logAudit({ module: "Reservations", recordId: id, reasonCode: "RESERVATION_FINAL_APPROVED" });
  revalidatePath("/reservations");
  revalidatePath("/production");
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

  await prisma.reservation.update({ where: { id }, data: { reminderSentAt: new Date() } });
  await logAudit({ module: "Reservations", recordId: id, reasonCode: "RESERVATION_REMINDER_SENT" });
  revalidatePath("/reservations");
}
