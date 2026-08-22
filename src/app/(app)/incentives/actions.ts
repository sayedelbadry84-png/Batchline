"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function updateIncentivePolicy(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const freeTripsThreshold = Number(formData.get("freeTripsThreshold") ?? 10);
  const tier2Threshold = Number(formData.get("tier2Threshold") ?? 15);
  const tier2RateSar = Number(formData.get("tier2RateSar") ?? 0);
  const tier3Threshold = Number(formData.get("tier3Threshold") ?? 20);
  const tier3RateSar = Number(formData.get("tier3RateSar") ?? 0);
  const beyondRateSar = Number(formData.get("beyondRateSar") ?? 0);
  if (!plantId || !role) return;

  const before = await prisma.driverIncentivePolicy.findUnique({ where: { plantId_role: { plantId, role } } });

  await prisma.driverIncentivePolicy.upsert({
    where: { plantId_role: { plantId, role } },
    create: { plantId, role, freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
    update: { freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
  });

  await logAudit({
    module: "Fleet",
    recordId: `${plantId}:${role}`,
    field: "driverIncentivePolicy",
    beforeValue: before ? JSON.stringify(before) : undefined,
    afterValue: JSON.stringify({ role, freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar }),
    reasonCode: "INCENTIVE_POLICY_UPDATED",
  });

  revalidatePath("/incentives");
}

// --- Pump operator incentive (volume + reach-priced — see
// calculatePumpOperatorPayout in src/lib/incentives.ts). ---

export async function updatePumpIncentivePolicy(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const freeVolumeM3 = Number(formData.get("freeVolumeM3") ?? 0) || 0;
  if (!plantId) return;

  await prisma.pumpIncentivePolicy.upsert({
    where: { plantId },
    create: { plantId, freeVolumeM3 },
    update: { freeVolumeM3 },
  });

  await logAudit({
    module: "Fleet",
    recordId: plantId,
    field: "pumpIncentivePolicy",
    afterValue: `freeVolumeM3=${freeVolumeM3}`,
    reasonCode: "PUMP_INCENTIVE_POLICY_UPDATED",
  });

  revalidatePath("/incentives");
}

export async function addPumpRateBracket(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const minReachM = Number(formData.get("minReachM") ?? 0);
  const maxReachM = Number(formData.get("maxReachM") ?? 0) || null;
  const ratePerM3Sar = Number(formData.get("ratePerM3Sar") ?? 0);
  if (!plantId || !ratePerM3Sar) return;

  const policy = await prisma.pumpIncentivePolicy.upsert({
    where: { plantId },
    create: { plantId, freeVolumeM3: 0 },
    update: {},
  });

  const bracket = await prisma.pumpReachRateBracket.create({
    data: { policyId: policy.id, minReachM, maxReachM, ratePerM3Sar },
  });

  await logAudit({
    module: "Fleet",
    recordId: bracket.id,
    afterValue: `${minReachM}-${maxReachM ?? "∞"}m @ ${ratePerM3Sar}`,
    reasonCode: "PUMP_RATE_BRACKET_ADDED",
  });

  revalidatePath("/incentives");
}

export async function deletePumpRateBracket(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.pumpReachRateBracket.delete({ where: { id } });

  await logAudit({ module: "Fleet", recordId: id, reasonCode: "PUMP_RATE_BRACKET_REMOVED" });
  revalidatePath("/incentives");
}
