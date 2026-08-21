"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function createTruck(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const drumCapacityM3 = Number(formData.get("drumCapacityM3") ?? 0);
  const maxAgitationRpm = Number(formData.get("maxAgitationRpm") ?? 0) || null;
  const gpsDeviceId = String(formData.get("gpsDeviceId") ?? "").trim();

  if (!plantId || !code || !drumCapacityM3) return;

  const truck = await prisma.truck.create({
    data: { plantId, code, drumCapacityM3, maxAgitationRpm, gpsDeviceId },
  });

  await logAudit({ module: "Fleet", recordId: truck.id, afterValue: code, reasonCode: "TRUCK_CREATED" });
  revalidatePath("/fleet");
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
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !plantId || !code || !drumCapacityM3) return;

  await prisma.truck.update({
    where: { id },
    data: { plantId, code, drumCapacityM3, maxAgitationRpm, gpsDeviceId, status },
  });

  await logAudit({ module: "Fleet", recordId: id, afterValue: code, reasonCode: "TRUCK_UPDATED" });
  revalidatePath("/fleet");
}

export async function setTruckStatus(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !status) return;

  const before = await prisma.truck.findUnique({ where: { id } });
  await prisma.truck.update({ where: { id }, data: { status } });

  await logAudit({
    module: "Fleet",
    recordId: id,
    field: "status",
    beforeValue: before?.status,
    afterValue: status,
    reasonCode: "TRUCK_STATUS_CHANGE",
  });

  revalidatePath("/fleet");
}
