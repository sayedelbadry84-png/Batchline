"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { getReleasedVolumeM3 } from "@/lib/reservations";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
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

  if (!projectId || !siteId || !mixId || !requestedVolumeM3 || !pourWindowStartRaw) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  // Credit check: requested project's customer credit limit must cover
  // the standing balance implied by this reservation (simplified for Phase 1
  // — a real implementation would sum outstanding invoices, not just flag).
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { customer: true } });
  if (!project) return;
  const overCreditLimit = project.customer.creditLimit <= 0;

  const reservation = await prisma.reservation.create({
    data: {
      projectId,
      siteId,
      mixId,
      requestedVolumeM3,
      pourWindowStart: new Date(pourWindowStartRaw),
      status: overCreditLimit ? "ON_HOLD" : "CONFIRMED",
      ...readPourDetails(formData),
    },
  });

  await logAudit({
    module: "Reservations",
    recordId: reservation.id,
    afterValue: `${requestedVolumeM3} m3`,
    reasonCode: overCreditLimit ? "CREDIT_HOLD" : "RESERVATION_CREATED",
  });

  revalidatePath("/reservations");
}

// Editable at any point in the delivery lifecycle short of DELIVERED or
// CANCELLED — including after partial release, so a site's actual pour
// can be scaled up or down mid-job. The one hard rule: requested volume
// can never drop below what's already gone out as a batch ticket, since
// that concrete is already real and can't un-happen.
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
  if (["DELIVERED", "CANCELLED"].includes(reservation.status)) return;
  const effSiteId = effectiveSiteId(user);
  if (!isSiteInScope(reservation.siteId, effSiteId) || !isSiteInScope(siteId, effSiteId)) return;

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

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation || !reservation.initialApprovedAt || reservation.finalApprovedAt) return;

  // ON_HOLD is an automatic flag set at creation (see createReservation's
  // credit-limit check) — it's a "needs review" marker, not a separate
  // veto that survives review. Final approval IS that review completing
  // successfully, so it clears the hold too; otherwise an approved
  // reservation would sit invisible to Production forever; the listing
  // there only ever shows CONFIRMED/IN_PRODUCTION (see readyReservationsRaw
  // in production/page.tsx).
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
