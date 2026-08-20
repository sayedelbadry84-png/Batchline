"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createPlant(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const currency = String(formData.get("currency") ?? "EGP").trim();
  const timezone = String(formData.get("timezone") ?? "Africa/Cairo").trim();

  if (!name || !city) return;

  const plant = await prisma.plant.create({
    data: { name, city, currency, timezone },
  });

  await logAudit({
    module: "PlantManagement",
    recordId: plant.id,
    afterValue: name,
    reasonCode: "PLANT_CREATED",
  });

  revalidatePath("/plants");
}

export async function updatePlantThresholds(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const drumTimerLimitMinutes = Number(formData.get("drumTimerLimitMinutes") ?? 90);
  const returnAbsorptionThresholdM3 = Number(formData.get("returnAbsorptionThresholdM3") ?? 0.2);
  if (!id) return;

  const before = await prisma.plant.findUnique({ where: { id } });
  await prisma.plant.update({ where: { id }, data: { drumTimerLimitMinutes, returnAbsorptionThresholdM3 } });

  await logAudit({
    module: "PlantManagement",
    recordId: id,
    field: "thresholds",
    beforeValue: `${before?.drumTimerLimitMinutes}min / ${before?.returnAbsorptionThresholdM3}m3`,
    afterValue: `${drumTimerLimitMinutes}min / ${returnAbsorptionThresholdM3}m3`,
    reasonCode: "TOLERANCE_UPDATED",
    role: "PLANT_OPERATOR",
  });

  revalidatePath("/plants");
}
