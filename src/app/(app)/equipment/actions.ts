"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isPlantActive, isPlantInScope } from "@/lib/siteScope";
import { logTransferIfChanged } from "@/lib/transferAudit";
import { revalidatePath } from "next/cache";

function refresh() {
  revalidatePath("/equipment");
  revalidatePath("/");
}

// --- Mixer trucks -----------------------------------------------------

export async function createTruck(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const drumCapacityM3 = Number(formData.get("drumCapacityM3") ?? 0);
  const maxAgitationRpm = Number(formData.get("maxAgitationRpm") ?? 0) || null;
  const gpsDeviceId = String(formData.get("gpsDeviceId") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;

  if (!plantId || !code || !drumCapacityM3) return;
  if (!(await isPlantInScope(plantId, effectiveSiteId(user)))) return;
  if (!(await isPlantActive(plantId))) return;

  const truck = await prisma.truck.create({
    data: { plantId, code, drumCapacityM3, maxAgitationRpm, gpsDeviceId, year, chassisNumber, plateNumber, defaultDriverId },
  });

  await logAudit({ module: "Equipment", recordId: truck.id, afterValue: code, reasonCode: "TRUCK_CREATED" });
  refresh();
}

export async function updateTruck(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const drumCapacityM3 = Number(formData.get("drumCapacityM3") ?? 0);
  const maxAgitationRpm = Number(formData.get("maxAgitationRpm") ?? 0) || null;
  const gpsDeviceId = String(formData.get("gpsDeviceId") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;
  // status change (active/idle/maintenance/out-of-service) and plant
  // transfer both go through this same edit form — a plant transfer is
  // just picking a different plantId here, no separate action needed.
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !plantId || !code || !drumCapacityM3) return;
  const siteId = effectiveSiteId(user);
  const existing = await prisma.truck.findUnique({ where: { id }, select: { plantId: true } });
  if (!existing || !(await isPlantInScope(existing.plantId, siteId)) || !(await isPlantInScope(plantId, siteId))) return;

  await prisma.truck.update({
    where: { id },
    data: { plantId, code, drumCapacityM3, maxAgitationRpm, gpsDeviceId, year, chassisNumber, plateNumber, defaultDriverId, status },
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
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const truck = await prisma.truck.findUnique({ where: { id }, select: { plantId: true } });
  if (!truck || !(await isPlantInScope(truck.plantId, effectiveSiteId(user)))) return;

  await prisma.truck.update({ where: { id }, data: { lastMaintenanceAt: new Date() } });

  await logAudit({ module: "Equipment", recordId: id, reasonCode: "TRUCK_MARKED_SERVICED" });
  refresh();
}

// --- Pumps --------------------------------------------------------------

export async function createPump(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const pumpType = String(formData.get("pumpType") ?? "BOOM");
  const reachM = Number(formData.get("reachM") ?? 0) || null;
  const hourlyRate = Number(formData.get("hourlyRate") ?? 0);
  const standbyRate = Number(formData.get("standbyRate") ?? 0) || null;
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const defaultOperatorId = String(formData.get("defaultOperatorId") ?? "") || null;
  const defaultAssistantId = String(formData.get("defaultAssistantId") ?? "") || null;

  if (!plantId || !code || !hourlyRate) return;
  if (!(await isPlantInScope(plantId, effectiveSiteId(user)))) return;
  if (!(await isPlantActive(plantId))) return;

  const pump = await prisma.pump.create({
    data: { plantId, code, pumpType, reachM, hourlyRate, standbyRate, year, chassisNumber, plateNumber, defaultOperatorId, defaultAssistantId },
  });

  await logAudit({ module: "Equipment", recordId: pump.id, afterValue: code, reasonCode: "PUMP_CREATED" });
  refresh();
}

export async function updatePump(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const pumpType = String(formData.get("pumpType") ?? "BOOM");
  const reachM = Number(formData.get("reachM") ?? 0) || null;
  const hourlyRate = Number(formData.get("hourlyRate") ?? 0);
  const standbyRate = Number(formData.get("standbyRate") ?? 0) || null;
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const defaultOperatorId = String(formData.get("defaultOperatorId") ?? "") || null;
  const defaultAssistantId = String(formData.get("defaultAssistantId") ?? "") || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !plantId || !code || !hourlyRate) return;
  const pumpSiteId = effectiveSiteId(user);
  const existingPump = await prisma.pump.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingPump || !(await isPlantInScope(existingPump.plantId, pumpSiteId)) || !(await isPlantInScope(plantId, pumpSiteId))) return;

  await prisma.pump.update({
    where: { id },
    data: { plantId, code, pumpType, reachM, hourlyRate, standbyRate, year, chassisNumber, plateNumber, defaultOperatorId, defaultAssistantId, status },
  });
  await logTransferIfChanged("Equipment", id, existingPump.plantId, plantId);

  await logAudit({ module: "Equipment", recordId: id, afterValue: code, reasonCode: "PUMP_UPDATED" });
  refresh();
}

export async function markPumpServiced(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

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
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

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
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

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

export async function createSupportVehicle(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const type = String(formData.get("type") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;

  if (!plantId || !type || !code) return;
  if (!["BULKER", "WATER_TANKER", "LOADER"].includes(type)) return;
  if (!(await isPlantInScope(plantId, effectiveSiteId(user)))) return;
  if (!(await isPlantActive(plantId))) return;

  const vehicle = await prisma.supportVehicle.create({
    data: { plantId, type, code, year, chassisNumber, plateNumber, defaultDriverId },
  });

  await logAudit({ module: "Equipment", recordId: vehicle.id, afterValue: code, reasonCode: "SUPPORT_VEHICLE_CREATED" });
  refresh();
}

export async function updateSupportVehicle(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const year = Number(formData.get("year") ?? 0) || null;
  const chassisNumber = String(formData.get("chassisNumber") ?? "").trim() || null;
  const plateNumber = String(formData.get("plateNumber") ?? "").trim() || null;
  const defaultDriverId = String(formData.get("defaultDriverId") ?? "") || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !plantId || !code) return;
  const vehicleSiteId = effectiveSiteId(user);
  const existingVehicle = await prisma.supportVehicle.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingVehicle || !(await isPlantInScope(existingVehicle.plantId, vehicleSiteId)) || !(await isPlantInScope(plantId, vehicleSiteId))) return;

  await prisma.supportVehicle.update({
    where: { id },
    data: { plantId, code, year, chassisNumber, plateNumber, defaultDriverId, status },
  });
  await logTransferIfChanged("Equipment", id, existingVehicle.plantId, plantId);

  await logAudit({ module: "Equipment", recordId: id, afterValue: code, reasonCode: "SUPPORT_VEHICLE_UPDATED" });
  refresh();
}
