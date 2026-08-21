"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
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

export async function updatePlant(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();
  if (!id || !name || !city) return;

  const before = await prisma.plant.findUnique({ where: { id } });
  await prisma.plant.update({ where: { id }, data: { name, city, currency, timezone } });

  await logAudit({
    module: "PlantManagement",
    recordId: id,
    field: "name/city/currency/timezone",
    beforeValue: `${before?.name} / ${before?.city} / ${before?.currency} / ${before?.timezone}`,
    afterValue: `${name} / ${city} / ${currency} / ${timezone}`,
    reasonCode: "PLANT_UPDATED",
  });

  revalidatePath("/plants");
}

export async function updatePlantThresholds(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const drumTimerLimitMinutes = Number(formData.get("drumTimerLimitMinutes") ?? 90);
  const returnAbsorptionThresholdM3 = Number(formData.get("returnAbsorptionThresholdM3") ?? 0.2);
  const maintenanceIntervalTrips = Number(formData.get("maintenanceIntervalTrips") ?? 150);
  if (!id) return;

  const before = await prisma.plant.findUnique({ where: { id } });
  await prisma.plant.update({
    where: { id },
    data: { drumTimerLimitMinutes, returnAbsorptionThresholdM3, maintenanceIntervalTrips },
  });

  await logAudit({
    module: "PlantManagement",
    recordId: id,
    field: "thresholds",
    beforeValue: `${before?.drumTimerLimitMinutes}min / ${before?.returnAbsorptionThresholdM3}m3 / ${before?.maintenanceIntervalTrips}trips`,
    afterValue: `${drumTimerLimitMinutes}min / ${returnAbsorptionThresholdM3}m3 / ${maintenanceIntervalTrips}trips`,
    reasonCode: "TOLERANCE_UPDATED",
  });

  revalidatePath("/plants");
}
