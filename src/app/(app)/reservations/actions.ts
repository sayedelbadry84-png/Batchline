"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getRemainingVolumeM3 } from "@/lib/reservations";
import { revalidatePath } from "next/cache";

// Shared by create and update — the pour-order details captured at intake,
// separate from the core project/mix/volume/window fields.
function readPourDetails(formData: FormData) {
  return {
    slumpRequestedMm: Number(formData.get("slumpRequestedMm") ?? 0) || null,
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

export async function createReservation(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const requestedVolumeM3 = Number(formData.get("requestedVolumeM3") ?? 0);
  const pourWindowStartRaw = String(formData.get("pourWindowStart") ?? "");

  if (!projectId || !mixId || !requestedVolumeM3 || !pourWindowStartRaw) return;

  // Credit check: requested project's customer credit limit must cover
  // the standing balance implied by this reservation (simplified for Phase 1
  // — a real implementation would sum outstanding invoices, not just flag).
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { customer: true } });
  const overCreditLimit = project ? project.customer.creditLimit <= 0 : false;

  const reservation = await prisma.reservation.create({
    data: {
      projectId,
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

// Only editable before any volume has been dispatched — once a batch ticket
// has been released against it, changing the mix or requested volume would
// silently invalidate tickets/tolerances already computed off the old
// numbers, so the action re-checks this server-side rather than trusting
// the UI to only show Edit when it's safe.
export async function updateReservation(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const requestedVolumeM3 = Number(formData.get("requestedVolumeM3") ?? 0);
  const pourWindowStartRaw = String(formData.get("pourWindowStart") ?? "");

  if (!id || !projectId || !mixId || !requestedVolumeM3 || !pourWindowStartRaw) return;

  const reservation = await prisma.reservation.findUnique({ where: { id } });
  if (!reservation) return;
  if (!["REQUESTED", "CONFIRMED", "ON_HOLD"].includes(reservation.status)) return;

  const remaining = await getRemainingVolumeM3(id, reservation.requestedVolumeM3);
  if (remaining < reservation.requestedVolumeM3) return; // something has already been released

  await prisma.reservation.update({
    where: { id },
    data: {
      projectId,
      mixId,
      requestedVolumeM3,
      pourWindowStart: new Date(pourWindowStartRaw),
      ...readPourDetails(formData),
    },
  });

  await logAudit({
    module: "Reservations",
    recordId: id,
    afterValue: `${requestedVolumeM3} m3`,
    reasonCode: "RESERVATION_UPDATED",
  });

  revalidatePath("/reservations");
}
