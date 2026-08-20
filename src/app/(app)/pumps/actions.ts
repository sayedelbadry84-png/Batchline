"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createPump(formData: FormData) {
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

export async function schedulePump(formData: FormData) {
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
