"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isPlantInScope, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { logTransferIfChanged } from "@/lib/transferAudit";
import { revalidatePath } from "next/cache";

function refresh() {
  revalidatePath("/equipment");
  revalidatePath("/");
}

// --- Mixer trucks -----------------------------------------------------

// Registered by Plant code, not a specific Station — a truck moves between
// a plant's own lines as work demands, same reasoning as Employees/pump
// crew (see resolvePlantIdForSite in siteScope.ts). The form submits
// siteId; this resolves it down to one concrete Plant row.
export async function createTruck(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "createTruck");

  const siteId = String(formData.get("siteId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const drumCapacityM3 = Number(formData.get("drumCapacityM3") ?? 0);
  const maxAgitationRpm = Number(formData.get("maxAgitationRpm") ?? 0) || null;
  const gpsDeviceId = String(formData.get("gpsDeviceId") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const licenseValidFromRaw = String(formData.get("licenseValidFrom") ?? "");
  const periodicInspectionDueAtRaw = String(formData.get("periodicInspectionDueAt") ?? "");
  const operatingCardExpiryRaw = String(formData.get("operatingCardExpiry") ?? "");
  const insurancePolicyExpiryRaw = String(formData.get("insurancePolicyExpiry") ?? "");
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;

  if (!siteId || !code || !drumCapacityM3) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;

  const truck = await prisma.truck.create({
    data: {
      plantId,
      code,
      drumCapacityM3,
      maxAgitationRpm,
      gpsDeviceId,
      year,
      chassisNumber,
      plateNumber,
      licenseValidFrom: licenseValidFromRaw ? new Date(licenseValidFromRaw) : null,
      periodicInspectionDueAt: periodicInspectionDueAtRaw ? new Date(periodicInspectionDueAtRaw) : null,
      operatingCardExpiry: operatingCardExpiryRaw ? new Date(operatingCardExpiryRaw) : null,
      insurancePolicyExpiry: insurancePolicyExpiryRaw ? new Date(insurancePolicyExpiryRaw) : null,
      defaultDriverId,
    },
  });

  await logAudit({ module: "Equipment", recordId: truck.id, afterValue: code, reasonCode: "TRUCK_CREATED" });
  refresh();
}

export async function updateTruck(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "updateTruck");

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const drumCapacityM3 = Number(formData.get("drumCapacityM3") ?? 0);
  const maxAgitationRpm = Number(formData.get("maxAgitationRpm") ?? 0) || null;
  const gpsDeviceId = String(formData.get("gpsDeviceId") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const licenseValidFromRaw = String(formData.get("licenseValidFrom") ?? "");
  const periodicInspectionDueAtRaw = String(formData.get("periodicInspectionDueAt") ?? "");
  const operatingCardExpiryRaw = String(formData.get("operatingCardExpiry") ?? "");
  const insurancePolicyExpiryRaw = String(formData.get("insurancePolicyExpiry") ?? "");
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;
  // status change (active/idle/maintenance/out-of-service) and plant
  // transfer both go through this same edit form — a plant transfer is
  // just picking a different siteId here, no separate action needed.
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !siteId || !code || !drumCapacityM3) return;
  const scopeSiteId = effectiveSiteId(user);
  if (!isSiteInScope(siteId, scopeSiteId)) return;
  const existing = await prisma.truck.findUnique({ where: { id }, select: { plantId: true } });
  if (!existing || !(await isPlantInScope(existing.plantId, scopeSiteId))) return;
  const plantId = await resolvePlantIdForSite(siteId, existing.plantId);
  if (!plantId) return;

  await prisma.truck.update({
    where: { id },
    data: {
      plantId,
      code,
      drumCapacityM3,
      maxAgitationRpm,
      gpsDeviceId,
      year,
      chassisNumber,
      plateNumber,
      licenseValidFrom: licenseValidFromRaw ? new Date(licenseValidFromRaw) : null,
      periodicInspectionDueAt: periodicInspectionDueAtRaw ? new Date(periodicInspectionDueAtRaw) : null,
      operatingCardExpiry: operatingCardExpiryRaw ? new Date(operatingCardExpiryRaw) : null,
      insurancePolicyExpiry: insurancePolicyExpiryRaw ? new Date(insurancePolicyExpiryRaw) : null,
      defaultDriverId,
      status,
    },
  });
  await logTransferIfChanged("Equipment", id, existing.plantId, plantId);

  await logAudit({ module: "Equipment", recordId: id, afterValue: code, reasonCode: "TRUCK_UPDATED" });
  refresh();
}

// Resets the trip-count clock src/lib/maintenance.ts reads — kept separate
// from the status field since "serviced" and "currently available" are
// different facts (a truck can be serviced without ever going to
// MAINTENANCE status, if the service happened during idle time).
export async function markTruckServiced(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "markTruckServiced");

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const truck = await prisma.truck.findUnique({ where: { id }, select: { plantId: true } });
  if (!truck || !(await isPlantInScope(truck.plantId, effectiveSiteId(user)))) return;

  await prisma.truck.update({ where: { id }, data: { lastMaintenanceAt: new Date() } });

  await logAudit({ module: "Equipment", recordId: id, reasonCode: "TRUCK_MARKED_SERVICED" });
  refresh();
}

// --- Pumps --------------------------------------------------------------

// Registered by Plant code, not a specific Station — same reasoning as
// createTruck above.
export async function createPump(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "createPump");

  const siteId = String(formData.get("siteId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const pumpType = String(formData.get("pumpType") ?? "BOOM");
  const reachM = Number(formData.get("reachM") ?? 0) || null;
  const hourlyRate = Number(formData.get("hourlyRate") ?? 0);
  const standbyRate = Number(formData.get("standbyRate") ?? 0) || null;
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const licenseValidFromRaw = String(formData.get("licenseValidFrom") ?? "");
  const periodicInspectionDueAtRaw = String(formData.get("periodicInspectionDueAt") ?? "");
  const operatingCardExpiryRaw = String(formData.get("operatingCardExpiry") ?? "");
  const insurancePolicyExpiryRaw = String(formData.get("insurancePolicyExpiry") ?? "");
  const defaultOperatorId = String(formData.get("defaultOperatorId") ?? "") || null;
  const defaultAssistantId = String(formData.get("defaultAssistantId") ?? "") || null;

  if (!siteId || !code || !hourlyRate) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;

  const pump = await prisma.pump.create({
    data: {
      plantId,
      code,
      pumpType,
      reachM,
      hourlyRate,
      standbyRate,
      year,
      chassisNumber,
      plateNumber,
      licenseValidFrom: licenseValidFromRaw ? new Date(licenseValidFromRaw) : null,
      periodicInspectionDueAt: periodicInspectionDueAtRaw ? new Date(periodicInspectionDueAtRaw) : null,
      operatingCardExpiry: operatingCardExpiryRaw ? new Date(operatingCardExpiryRaw) : null,
      insurancePolicyExpiry: insurancePolicyExpiryRaw ? new Date(insurancePolicyExpiryRaw) : null,
      defaultOperatorId,
      defaultAssistantId,
    },
  });

  await logAudit({ module: "Equipment", recordId: pump.id, afterValue: code, reasonCode: "PUMP_CREATED" });
  refresh();
}

export async function updatePump(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "updatePump");

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const pumpType = String(formData.get("pumpType") ?? "BOOM");
  const reachM = Number(formData.get("reachM") ?? 0) || null;
  const hourlyRate = Number(formData.get("hourlyRate") ?? 0);
  const standbyRate = Number(formData.get("standbyRate") ?? 0) || null;
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const licenseValidFromRaw = String(formData.get("licenseValidFrom") ?? "");
  const periodicInspectionDueAtRaw = String(formData.get("periodicInspectionDueAt") ?? "");
  const operatingCardExpiryRaw = String(formData.get("operatingCardExpiry") ?? "");
  const insurancePolicyExpiryRaw = String(formData.get("insurancePolicyExpiry") ?? "");
  const defaultOperatorId = String(formData.get("defaultOperatorId") ?? "") || null;
  const defaultAssistantId = String(formData.get("defaultAssistantId") ?? "") || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !siteId || !code || !hourlyRate) return;
  const pumpSiteId = effectiveSiteId(user);
  if (!isSiteInScope(siteId, pumpSiteId)) return;
  const existingPump = await prisma.pump.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingPump || !(await isPlantInScope(existingPump.plantId, pumpSiteId))) return;
  const plantId = await resolvePlantIdForSite(siteId, existingPump.plantId);
  if (!plantId) return;

  await prisma.pump.update({
    where: { id },
    data: {
      plantId,
      code,
      pumpType,
      reachM,
      hourlyRate,
      standbyRate,
      year,
      chassisNumber,
      plateNumber,
      licenseValidFrom: licenseValidFromRaw ? new Date(licenseValidFromRaw) : null,
      periodicInspectionDueAt: periodicInspectionDueAtRaw ? new Date(periodicInspectionDueAtRaw) : null,
      operatingCardExpiry: operatingCardExpiryRaw ? new Date(operatingCardExpiryRaw) : null,
      insurancePolicyExpiry: insurancePolicyExpiryRaw ? new Date(insurancePolicyExpiryRaw) : null,
      defaultOperatorId,
      defaultAssistantId,
      status,
    },
  });
  await logTransferIfChanged("Equipment", id, existingPump.plantId, plantId);

  await logAudit({ module: "Equipment", recordId: id, afterValue: code, reasonCode: "PUMP_UPDATED" });
  refresh();
}

export async function markPumpServiced(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "markPumpServiced");

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const pump = await prisma.pump.findUnique({ where: { id }, select: { plantId: true } });
  if (!pump || !(await isPlantInScope(pump.plantId, effectiveSiteId(user)))) return;

  await prisma.pump.update({ where: { id }, data: { lastMaintenanceAt: new Date() } });

  await logAudit({ module: "Equipment", recordId: id, reasonCode: "PUMP_MARKED_SERVICED" });
  refresh();
}

export async function schedulePump(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "schedulePump");

  const pumpId = String(formData.get("pumpId") ?? "");
  const reservationId = String(formData.get("reservationId") ?? "");
  const scheduledStartRaw = String(formData.get("scheduledStart") ?? "");

  if (!pumpId || !reservationId || !scheduledStartRaw) return;
  const scheduleSiteId = effectiveSiteId(user);
  const pumpForSchedule = await prisma.pump.findUnique({ where: { id: pumpId }, select: { plantId: true } });
  if (!pumpForSchedule || !(await isPlantInScope(pumpForSchedule.plantId, scheduleSiteId))) return;

  const assignment = await prisma.pumpAssignment.create({
    data: { pumpId, reservationId, scheduledStart: new Date(scheduledStartRaw) },
  });

  await logAudit({
    module: "Equipment",
    recordId: assignment.id,
    afterValue: `pump ${pumpId} -> reservation ${reservationId}`,
    reasonCode: "PUMP_SCHEDULED",
  });

  refresh();
}

export async function updateAssignmentStatus(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "updateAssignmentStatus");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const billedHours = Number(formData.get("billedHours") ?? 0) || null;
  if (!id || !status) return;

  const before = await prisma.pumpAssignment.findUnique({ where: { id }, include: { pump: { select: { plantId: true } } } });
  if (!before || !(await isPlantInScope(before.pump.plantId, effectiveSiteId(user)))) return;
  await prisma.pumpAssignment.update({ where: { id }, data: { status, billedHours } });

  await logAudit({
    module: "Equipment",
    recordId: id,
    field: "status",
    beforeValue: before?.status,
    afterValue: status,
    reasonCode: "PUMP_ASSIGNMENT_UPDATED",
  });

  refresh();
}

// --- Support vehicles (cement bulkers, water tankers, loaders) ----------
// One model, one pair of actions for all three — see the SupportVehicle
// comment in schema.prisma for why they're not three separate models.

// Registered by Plant code, not a specific Station — same reasoning as
// createTruck above.
export async function createSupportVehicle(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "createSupportVehicle");

  const siteId = String(formData.get("siteId") ?? "");
  const type = String(formData.get("type") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const licenseValidFromRaw = String(formData.get("licenseValidFrom") ?? "");
  const periodicInspectionDueAtRaw = String(formData.get("periodicInspectionDueAt") ?? "");
  const operatingCardExpiryRaw = String(formData.get("operatingCardExpiry") ?? "");
  const insurancePolicyExpiryRaw = String(formData.get("insurancePolicyExpiry") ?? "");
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;

  if (!siteId || !type || !code) return;
  if (!["BULKER", "WATER_TANKER", "LOADER"].includes(type)) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;

  const vehicle = await prisma.supportVehicle.create({
    data: {
      plantId,
      type,
      code,
      year,
      chassisNumber,
      plateNumber,
      licenseValidFrom: licenseValidFromRaw ? new Date(licenseValidFromRaw) : null,
      periodicInspectionDueAt: periodicInspectionDueAtRaw ? new Date(periodicInspectionDueAtRaw) : null,
      operatingCardExpiry: operatingCardExpiryRaw ? new Date(operatingCardExpiryRaw) : null,
      insurancePolicyExpiry: insurancePolicyExpiryRaw ? new Date(insurancePolicyExpiryRaw) : null,
      defaultDriverId,
    },
  });

  await logAudit({ module: "Equipment", recordId: vehicle.id, afterValue: code, reasonCode: "SUPPORT_VEHICLE_CREATED" });
  refresh();
}

export async function updateSupportVehicle(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "equipment", "updateSupportVehicle");

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const licenseValidFromRaw = String(formData.get("licenseValidFrom") ?? "");
  const periodicInspectionDueAtRaw = String(formData.get("periodicInspectionDueAt") ?? "");
  const operatingCardExpiryRaw = String(formData.get("operatingCardExpiry") ?? "");
  const insurancePolicyExpiryRaw = String(formData.get("insurancePolicyExpiry") ?? "");
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !siteId || !code) return;
  const vehicleSiteId = effectiveSiteId(user);
  if (!isSiteInScope(siteId, vehicleSiteId)) return;
  const existingVehicle = await prisma.supportVehicle.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingVehicle || !(await isPlantInScope(existingVehicle.plantId, vehicleSiteId))) return;
  const plantId = await resolvePlantIdForSite(siteId, existingVehicle.plantId);
  if (!plantId) return;

  await prisma.supportVehicle.update({
    where: { id },
    data: {
      plantId,
      code,
      year,
      chassisNumber,
      plateNumber,
      licenseValidFrom: licenseValidFromRaw ? new Date(licenseValidFromRaw) : null,
      periodicInspectionDueAt: periodicInspectionDueAtRaw ? new Date(periodicInspectionDueAtRaw) : null,
      operatingCardExpiry: operatingCardExpiryRaw ? new Date(operatingCardExpiryRaw) : null,
      insurancePolicyExpiry: insurancePolicyExpiryRaw ? new Date(insurancePolicyExpiryRaw) : null,
      defaultDriverId,
      status,
    },
  });
  await logTransferIfChanged("Equipment", id, existingVehicle.plantId, plantId);

  await logAudit({ module: "Equipment", recordId: id, afterValue: code, reasonCode: "SUPPORT_VEHICLE_UPDATED" });
  refresh();
}
