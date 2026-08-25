"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function updateIncentivePolicy(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const freeTripsThreshold = Number(formData.get("freeTripsThreshold") ?? 10);
  const tier2Threshold = Number(formData.get("tier2Threshold") ?? 15);
  const tier2RateSar = Number(formData.get("tier2RateSar") ?? 0);
  const tier3Threshold = Number(formData.get("tier3Threshold") ?? 20);
  const tier3RateSar = Number(formData.get("tier3RateSar") ?? 0);
  const beyondRateSar = Number(formData.get("beyondRateSar") ?? 0);
  if (!siteId || !role) return;

  const before = await prisma.driverIncentivePolicy.findUnique({ where: { siteId_role: { siteId, role } } });

  await prisma.driverIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
    update: { freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
  });

  await logAudit({
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "driverIncentivePolicy",
    beforeValue: before ? JSON.stringify(before) : undefined,
    afterValue: JSON.stringify({ role, freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar }),
    reasonCode: "INCENTIVE_POLICY_UPDATED",
  });

  revalidatePath("/incentives");
  revalidatePath("/reports");
}

// --- Volume-based incentive (target + reach-bracket or flat rate — see
// calculateVolumeIncentivePayout in src/lib/incentives.ts). Generalized by
// role: PumpIncentivePolicy is no longer pump-operator-only. ---

export async function updatePumpIncentivePolicy(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const freeVolumeM3 = Number(formData.get("freeVolumeM3") ?? 0) || 0;
  if (!siteId || !role) return;

  await prisma.pumpIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeVolumeM3 },
    update: { freeVolumeM3 },
  });

  await logAudit({
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "pumpIncentivePolicy",
    afterValue: `freeVolumeM3=${freeVolumeM3}`,
    reasonCode: "PUMP_INCENTIVE_POLICY_UPDATED",
  });

  revalidatePath("/incentives");
  revalidatePath("/reports");
}

export async function addPumpRateBracket(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const minReachM = Number(formData.get("minReachM") ?? 0);
  const maxReachM = Number(formData.get("maxReachM") ?? 0) || null;
  const ratePerM3Sar = Number(formData.get("ratePerM3Sar") ?? 0);
  if (!siteId || !role || !ratePerM3Sar) return;

  const policy = await prisma.pumpIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeVolumeM3: 0 },
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
  revalidatePath("/reports");
}

export async function deletePumpRateBracket(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.pumpReachRateBracket.delete({ where: { id } });

  await logAudit({ module: "Fleet", recordId: id, reasonCode: "PUMP_RATE_BRACKET_REMOVED" });
  revalidatePath("/incentives");
  revalidatePath("/reports");
}

// A non-reach role (any VOLUME_M3 role other than PUMP_OPERATOR/
// PUMP_ASSISTANT — see isReachBasedRole in src/lib/incentives.ts) only
// ever needs one rate, not a bracket table: this replaces the policy's
// entire bracket set with a single catch-all row (minReachM 0, maxReachM
// null) rather than exposing the add/delete bracket UI for a case where
// there's only ever one row.
export async function setFlatVolumeRate(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const ratePerM3Sar = Number(formData.get("ratePerM3Sar") ?? 0);
  if (!siteId || !role) return;

  const policy = await prisma.pumpIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeVolumeM3: 0 },
    update: {},
  });

  await prisma.$transaction([
    prisma.pumpReachRateBracket.deleteMany({ where: { policyId: policy.id } }),
    prisma.pumpReachRateBracket.create({ data: { policyId: policy.id, minReachM: 0, maxReachM: null, ratePerM3Sar } }),
  ]);

  await logAudit({
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "flatVolumeRate",
    afterValue: `${ratePerM3Sar}`,
    reasonCode: "FLAT_VOLUME_RATE_SET",
  });

  revalidatePath("/incentives");
  revalidatePath("/reports");
}

// Which calculation a role uses — see IncentiveMethod in schema.prisma
// and DEFAULT_INCENTIVE_METHOD in src/lib/incentives.ts for the fallback.
export async function setIncentiveMethod(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const method = String(formData.get("method") ?? "").trim();
  if (!siteId || !role || (method !== "TRIP_COUNT" && method !== "VOLUME_M3")) return;

  await prisma.incentiveMethod.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, method },
    update: { method },
  });

  await logAudit({
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "incentiveMethod",
    afterValue: method,
    reasonCode: "INCENTIVE_METHOD_SET",
  });

  revalidatePath("/incentives");
  revalidatePath("/reports");
}
