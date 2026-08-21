"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function createPump(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const pumpType = String(formData.get("pumpType") ?? "BOOM");
  const reachM = Number(formData.get("reachM") ?? 0) || null;
  const hourlyRate = Number(formData.get("hourlyRate") ?? 0);
  const standbyRate = Number(formData.get("standbyRate") ?? 0) || null;

  if (!plantId || !code || !hourlyRate) return;

  const pump = await prisma.pump.create({
    data: { plantId, code, pumpType, reachM, hourlyRate, standbyRate },
  });

  await logAudit({ module: "Pumps", recordId: pump.id, afterValue: code, reasonCode: "PUMP_CREATED" });
  revalidatePath("/pumps");
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
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !plantId || !code || !hourlyRate) return;

  await prisma.pump.update({
    where: { id },
    data: { plantId, code, pumpType, reachM, hourlyRate, standbyRate, status },
  });

  await logAudit({ module: "Pumps", recordId: id, afterValue: code, reasonCode: "PUMP_UPDATED" });
  revalidatePath("/pumps");
}

// A reusable roster (see RhinoMaster comparison) — picking a name from here
// on the trip-start form prevents typos and lets an operator's history be
// tracked across many pump jobs, while Trip still stores a plain name too
// (see startTrip) so a crew member can be typed off-roster without being
// forced into master data first.
export async function createPumpCrewMember(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "OPERATOR");
  const phone = String(formData.get("phone") ?? "").trim() || null;
  if (!plantId || !name) return;

  const member = await prisma.pumpCrewMember.create({ data: { plantId, name, role, phone } });

  await logAudit({ module: "Pumps", recordId: member.id, afterValue: name, reasonCode: "PUMP_CREW_CREATED" });
  revalidatePath("/pumps");
}

export async function updatePumpCrewMember(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "OPERATOR");
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const status = String(formData.get("status") ?? "ACTIVE");
  if (!id || !name) return;

  await prisma.pumpCrewMember.update({ where: { id }, data: { name, role, phone, status } });

  await logAudit({ module: "Pumps", recordId: id, afterValue: name, reasonCode: "PUMP_CREW_UPDATED" });
  revalidatePath("/pumps");
}

export async function schedulePump(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const pumpId = String(formData.get("pumpId") ?? "");
  const reservationId = String(formData.get("reservationId") ?? "");
  const scheduledStartRaw = String(formData.get("scheduledStart") ?? "");

  if (!pumpId || !reservationId || !scheduledStartRaw) return;

  const assignment = await prisma.pumpAssignment.create({
    data: { pumpId, reservationId, scheduledStart: new Date(scheduledStartRaw) },
  });

  await logAudit({
    module: "Pumps",
    recordId: assignment.id,
    afterValue: `pump ${pumpId} -> reservation ${reservationId}`,
    reasonCode: "PUMP_SCHEDULED",
  });

  revalidatePath("/pumps");
}

export async function updateAssignmentStatus(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const billedHours = Number(formData.get("billedHours") ?? 0) || null;
  if (!id || !status) return;

  const before = await prisma.pumpAssignment.findUnique({ where: { id } });
  await prisma.pumpAssignment.update({ where: { id }, data: { status, billedHours } });

  await logAudit({
    module: "Pumps",
    recordId: id,
    field: "status",
    beforeValue: before?.status,
    afterValue: status,
    reasonCode: "PUMP_ASSIGNMENT_UPDATED",
  });

  revalidatePath("/pumps");
}
