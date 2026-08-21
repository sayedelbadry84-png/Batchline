"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function createSilo(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const materialType = String(formData.get("materialType") ?? "").trim();
  const capacityTons = Number(formData.get("capacityTons") ?? 0);
  const currentLevelTons = Number(formData.get("currentLevelTons") ?? 0);
  const minThresholdPct = Number(formData.get("minThresholdPct") ?? 15);

  if (!plantId || !name || !materialType || !capacityTons) return;

  const silo = await prisma.silo.create({
    data: { plantId, name, materialType, capacityTons, currentLevelTons, minThresholdPct },
  });

  await logAudit({
    module: "Silos",
    recordId: silo.id,
    afterValue: `${name} / ${materialType} / ${capacityTons}t`,
    reasonCode: "SILO_CREATED",
  });

  revalidatePath("/silos");
}

export async function updateSilo(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const materialType = String(formData.get("materialType") ?? "").trim();
  const capacityTons = Number(formData.get("capacityTons") ?? 0);
  const minThresholdPct = Number(formData.get("minThresholdPct") ?? 15);

  if (!id || !plantId || !name || !materialType || !capacityTons) return;

  await prisma.silo.update({
    where: { id },
    data: { plantId, name, materialType, capacityTons, minThresholdPct },
  });

  await logAudit({
    module: "Silos",
    recordId: id,
    afterValue: `${name} / ${materialType} / ${capacityTons}t`,
    reasonCode: "SILO_UPDATED",
  });

  revalidatePath("/silos");
}

export async function updateSiloLevel(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const currentLevelTons = Number(formData.get("currentLevelTons") ?? 0);
  if (!id) return;

  const before = await prisma.silo.findUnique({ where: { id } });
  await prisma.silo.update({ where: { id }, data: { currentLevelTons } });

  await logAudit({
    module: "Silos",
    recordId: id,
    field: "currentLevelTons",
    beforeValue: String(before?.currentLevelTons ?? ""),
    afterValue: String(currentLevelTons),
    reasonCode: "MANUAL_LEVEL_READING",
  });

  revalidatePath("/silos");
}
