"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isPlantActive, isPlantInScope, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { revalidatePath } from "next/cache";

export async function createSilo(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "createSilo");

  const plantId = String(formData.get("plantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const materialType = String(formData.get("materialType") ?? "").trim();
  const capacityTons = Number(formData.get("capacityTons") ?? 0);
  const currentLevelTons = Number(formData.get("currentLevelTons") ?? 0);
  const minThresholdPct = Number(formData.get("minThresholdPct") ?? 15);
  const sharedAcrossPlants = formData.get("sharedAcrossPlants") === "on";

  if (!plantId || !name || !materialType || !capacityTons) return;
  if (!(await isPlantInScope(plantId, effectiveSiteId(user)))) return;
  if (!(await isPlantActive(plantId))) return;

  const silo = await prisma.silo.create({
    data: { plantId, name, materialType, capacityTons, currentLevelTons, minThresholdPct, sharedAcrossPlants },
  });

  await logAudit({
    module: "Silos",
    recordId: silo.id,
    afterValue: `${name} / ${materialType} / ${capacityTons}t`,
    reasonCode: "SILO_CREATED",
  });

  revalidatePath("/warehouses");
}

export async function updateSilo(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "updateSilo");

  const id = String(formData.get("id") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const materialType = String(formData.get("materialType") ?? "").trim();
  const capacityTons = Number(formData.get("capacityTons") ?? 0);
  const minThresholdPct = Number(formData.get("minThresholdPct") ?? 15);

  if (!id || !plantId || !name || !materialType || !capacityTons) return;
  const siteId = effectiveSiteId(user);
  const existing = await prisma.silo.findUnique({ where: { id }, select: { plantId: true } });
  if (!existing || !(await isPlantInScope(existing.plantId, siteId)) || !(await isPlantInScope(plantId, siteId))) return;

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

  revalidatePath("/warehouses");
}

// Toggled independently of the level reading — sharing is a
// configuration fact, not a measurement (see findMatchingSilo in
// production/actions.ts for how this actually changes consumption).
export async function setSiloSharing(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "setSiloSharing");

  const id = String(formData.get("id") ?? "");
  const sharedAcrossPlants = formData.get("sharedAcrossPlants") === "on";
  if (!id) return;
  const silo = await prisma.silo.findUnique({ where: { id }, select: { plantId: true } });
  if (!silo || !(await isPlantInScope(silo.plantId, effectiveSiteId(user)))) return;

  await prisma.silo.update({ where: { id }, data: { sharedAcrossPlants } });

  await logAudit({
    module: "Silos",
    recordId: id,
    field: "sharedAcrossPlants",
    afterValue: String(sharedAcrossPlants),
    reasonCode: "SILO_SHARING_CHANGED",
  });

  revalidatePath("/warehouses");
}

export async function updateSiloLevel(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "updateSiloLevel");

  const id = String(formData.get("id") ?? "");
  const currentLevelTons = Number(formData.get("currentLevelTons") ?? 0);
  if (!id) return;

  const before = await prisma.silo.findUnique({ where: { id } });
  if (!before || !(await isPlantInScope(before.plantId, effectiveSiteId(user)))) return;
  await prisma.silo.update({ where: { id }, data: { currentLevelTons } });

  await logAudit({
    module: "Silos",
    recordId: id,
    field: "currentLevelTons",
    beforeValue: String(before?.currentLevelTons ?? ""),
    afterValue: String(currentLevelTons),
    reasonCode: "MANUAL_LEVEL_READING",
  });

  revalidatePath("/warehouses");
}

// --- Hoppers (aggregate heaps — SAND, COARSE_AGGREGATE, and now WATER;
// see completeBatch in production/actions.ts for how each is consumed).
// Registered by Site rather than by a specific line: a sand/aggregate/
// water heap is physically one pile in the yard serving every line at
// that site, unlike a cement silo (still line-specific — see createSilo
// above). The form submits siteId; resolvePlantIdForSite picks a concrete
// Plant row for the required FK, same pattern as Employees' site-code
// registration. ---

export async function createHopper(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "createHopper");

  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const aggregateType = String(formData.get("aggregateType") ?? "").trim();
  const capacityTons = Number(formData.get("capacityTons") ?? 0);
  const currentLevelTons = Number(formData.get("currentLevelTons") ?? 0);
  const minThresholdPct = Number(formData.get("minThresholdPct") ?? 15);
  const sharedAcrossPlants = formData.get("sharedAcrossPlants") === "on";

  if (!siteId || !name || !aggregateType || !capacityTons) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;
  if (!(await isPlantActive(plantId))) return;

  const hopper = await prisma.hopper.create({
    data: { plantId, name, aggregateType, capacityTons, currentLevelTons, minThresholdPct, sharedAcrossPlants },
  });

  await logAudit({ module: "Silos", recordId: hopper.id, afterValue: `${name} / ${aggregateType}`, reasonCode: "HOPPER_CREATED" });
  revalidatePath("/warehouses");
}

// Toggled independently of the level reading — sharing is a
// configuration fact, not a measurement (see findMatchingHopper in
// production/actions.ts for how this actually changes consumption).
export async function setHopperSharing(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "setHopperSharing");

  const id = String(formData.get("id") ?? "");
  const sharedAcrossPlants = formData.get("sharedAcrossPlants") === "on";
  if (!id) return;
  const hopper = await prisma.hopper.findUnique({ where: { id }, select: { plantId: true } });
  if (!hopper || !(await isPlantInScope(hopper.plantId, effectiveSiteId(user)))) return;

  await prisma.hopper.update({ where: { id }, data: { sharedAcrossPlants } });

  await logAudit({
    module: "Silos",
    recordId: id,
    field: "sharedAcrossPlants",
    afterValue: String(sharedAcrossPlants),
    reasonCode: "HOPPER_SHARING_CHANGED",
  });

  revalidatePath("/warehouses");
}

export async function updateHopperLevel(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "updateHopperLevel");

  const id = String(formData.get("id") ?? "");
  const currentLevelTons = Number(formData.get("currentLevelTons") ?? 0);
  if (!id) return;

  const before = await prisma.hopper.findUnique({ where: { id } });
  if (!before || !(await isPlantInScope(before.plantId, effectiveSiteId(user)))) return;
  await prisma.hopper.update({ where: { id }, data: { currentLevelTons } });

  await logAudit({
    module: "Silos",
    recordId: id,
    field: "currentLevelTons",
    beforeValue: String(before?.currentLevelTons ?? ""),
    afterValue: String(currentLevelTons),
    reasonCode: "MANUAL_LEVEL_READING",
  });

  revalidatePath("/warehouses");
}

// --- Chemical tanks (liquid admixtures — see completeBatch in
// production/actions.ts for the consumption side of this). ---

export async function createChemicalTank(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "createChemicalTank");

  const plantId = String(formData.get("plantId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const capacityLiters = Number(formData.get("capacityLiters") ?? 0) || null;
  const currentLevelLiters = Number(formData.get("currentLevelLiters") ?? 0);
  const minThresholdPct = Number(formData.get("minThresholdPct") ?? 15);

  if (!plantId || !materialId || !name) return;
  if (!(await isPlantInScope(plantId, effectiveSiteId(user)))) return;

  const tank = await prisma.chemicalTank.upsert({
    where: { plantId_materialId: { plantId, materialId } },
    create: { plantId, materialId, name, capacityLiters, currentLevelLiters, minThresholdPct },
    update: { name, capacityLiters, currentLevelLiters, minThresholdPct },
  });

  await logAudit({ module: "Silos", recordId: tank.id, afterValue: name, reasonCode: "CHEMICAL_TANK_CREATED" });
  revalidatePath("/warehouses");
}

export async function updateChemicalTankLevel(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "warehouses", "updateChemicalTankLevel");

  const id = String(formData.get("id") ?? "");
  const currentLevelLiters = Number(formData.get("currentLevelLiters") ?? 0);
  if (!id) return;

  const before = await prisma.chemicalTank.findUnique({ where: { id } });
  if (!before || !(await isPlantInScope(before.plantId, effectiveSiteId(user)))) return;
  await prisma.chemicalTank.update({ where: { id }, data: { currentLevelLiters } });

  await logAudit({
    module: "Silos",
    recordId: id,
    field: "currentLevelLiters",
    beforeValue: String(before?.currentLevelLiters ?? ""),
    afterValue: String(currentLevelLiters),
    reasonCode: "MANUAL_TANK_READING",
  });

  revalidatePath("/warehouses");
}
