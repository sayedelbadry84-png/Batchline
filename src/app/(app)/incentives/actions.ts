"use server";

import { assertIncentiveRole, nonNegativeNumber, assertTripThresholds, assertReachRange } from "@/lib/incentiveValidation";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { revalidatePath } from "next/cache";

export async function updateIncentivePolicy(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "incentives", "updateIncentivePolicy");

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const freeTripsThreshold = nonNegativeNumber(formData, "freeTripsThreshold", 10);
  const tier2Threshold = nonNegativeNumber(formData, "tier2Threshold", 15);
  const tier2RateSar = nonNegativeNumber(formData, "tier2RateSar", 0);
  const tier3Threshold = nonNegativeNumber(formData, "tier3Threshold", 20);
  const tier3RateSar = nonNegativeNumber(formData, "tier3RateSar", 0);
  const beyondRateSar = nonNegativeNumber(formData, "beyondRateSar", 0);
  assertIncentiveRole(role);
  if (!siteId || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  assertTripThresholds(freeTripsThreshold, tier2Threshold, tier3Threshold);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(729432, hashtext(${siteId + ":" + role}))`;
  const before = await tx.driverIncentivePolicy.findUnique({ where: { siteId_role: { siteId, role } } });

  await tx.driverIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
    update: { freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
  });

  await writeAudit(tx, user, {
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "driverIncentivePolicy",
    beforeValue: before ? JSON.stringify(before) : undefined,
    afterValue: JSON.stringify({ role, freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar }),
    reasonCode: "INCENTIVE_POLICY_UPDATED",
  });

  }, { timeout: 15000, isolationLevel: "ReadCommitted" });
  revalidatePath("/incentives");
  revalidatePath("/reports");
}

// --- Volume-based incentive (target + reach-bracket or flat rate — see
// calculateVolumeIncentivePayout in src/lib/incentives.ts). Generalized by
// role: PumpIncentivePolicy is no longer pump-operator-only. ---

export async function updatePumpIncentivePolicy(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "incentives", "updatePumpIncentivePolicy");

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const freeVolumeM3 = nonNegativeNumber(formData, "freeVolumeM3", 0);
  assertIncentiveRole(role);
  if (!siteId || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(729432, hashtext(${siteId + ":" + role}))`;
  await tx.pumpIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeVolumeM3 },
    update: { freeVolumeM3 },
  });

  await writeAudit(tx, user, {
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "pumpIncentivePolicy",
    afterValue: `freeVolumeM3=${freeVolumeM3}`,
    reasonCode: "PUMP_INCENTIVE_POLICY_UPDATED",
  });

  }, { timeout: 15000, isolationLevel: "ReadCommitted" });
  revalidatePath("/incentives");
  revalidatePath("/reports");
}

export async function addPumpRateBracket(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "incentives", "addPumpRateBracket");

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const minReachM = nonNegativeNumber(formData, "minReachM", 0);
  const maxReachM = (formData.get("maxReachM") === "" || formData.get("maxReachM") === null ? null : nonNegativeNumber(formData, "maxReachM"));
  const ratePerM3Sar = nonNegativeNumber(formData, "ratePerM3Sar", 0);
  assertIncentiveRole(role);
  assertReachRange(minReachM, maxReachM);
  if (!siteId || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(729432, hashtext(${siteId + ":" + role}))`;
  const policy = await tx.pumpIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeVolumeM3: 0 },
    update: {},
  });

  await tx.$queryRaw`SELECT "id" FROM "PumpIncentivePolicy" WHERE "id" = ${policy.id} FOR UPDATE`;
  const overlap = await tx.pumpReachRateBracket.findFirst({ where: { policyId: policy.id, ...(maxReachM === null ? {} : { minReachM: { lte: maxReachM } }), OR: [{ maxReachM: null }, { maxReachM: { gte: minReachM } }] } });
  if (overlap) throw new Error("OVERLAPPING_REACH_BRACKET");
  const bracket = await tx.pumpReachRateBracket.create({
    data: { policyId: policy.id, minReachM, maxReachM, ratePerM3Sar },
  });

  await writeAudit(tx, user, {
    module: "Fleet",
    recordId: bracket.id,
    afterValue: `${minReachM}-${maxReachM ?? "∞"}m @ ${ratePerM3Sar}`,
    reasonCode: "PUMP_RATE_BRACKET_ADDED",
  });

  }, { timeout: 15000, isolationLevel: "ReadCommitted" });
  revalidatePath("/incentives");
  revalidatePath("/reports");
}

export async function deletePumpRateBracket(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "incentives", "deletePumpRateBracket");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.$transaction(async (tx) => {
  const bracket = await tx.pumpReachRateBracket.findUnique({
    where: { id }, select: { policyId: true, policy: { select: { siteId: true } } },
  });
  if (!bracket || !isSiteInScope(bracket.policy.siteId, effectiveSiteId(user))) return;
  await tx.$queryRaw`SELECT "id" FROM "PumpIncentivePolicy" WHERE "id" = ${bracket.policyId} FOR UPDATE`;
  await tx.pumpReachRateBracket.delete({ where: { id } });

  await writeAudit(tx, user, { module: "Fleet", recordId: id, reasonCode: "PUMP_RATE_BRACKET_REMOVED" });
  }, { timeout: 15000, isolationLevel: "ReadCommitted" });
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
  await requireActionPermission(user, "incentives", "setFlatVolumeRate");

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const ratePerM3Sar = nonNegativeNumber(formData, "ratePerM3Sar", 0);
  assertIncentiveRole(role);
  if (!siteId || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(729432, hashtext(${siteId + ":" + role}))`;
  const policy = await tx.pumpIncentivePolicy.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, freeVolumeM3: 0 },
    update: {},
  });

  await tx.$queryRaw`SELECT "id" FROM "PumpIncentivePolicy" WHERE "id" = ${policy.id} FOR UPDATE`;
  await tx.pumpReachRateBracket.deleteMany({ where: { policyId: policy.id } });
  await tx.pumpReachRateBracket.create({ data: { policyId: policy.id, minReachM: 0, maxReachM: null, ratePerM3Sar } });

  await writeAudit(tx, user, {
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "flatVolumeRate",
    afterValue: `${ratePerM3Sar}`,
    reasonCode: "FLAT_VOLUME_RATE_SET",
  });

  }, { timeout: 15000, isolationLevel: "ReadCommitted" });
  revalidatePath("/incentives");
  revalidatePath("/reports");
}

// Which calculation a role uses — see IncentiveMethod in schema.prisma
// and DEFAULT_INCENTIVE_METHOD in src/lib/incentives.ts for the fallback.
export async function setIncentiveMethod(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "incentives", "setIncentiveMethod");

  const siteId = String(formData.get("siteId") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const method = String(formData.get("method") ?? "").trim();
  assertIncentiveRole(role);
  if (!siteId || !role || (method !== "TRIP_COUNT" && method !== "VOLUME_M3")) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(729432, hashtext(${siteId + ":" + role}))`;
  await tx.incentiveMethod.upsert({
    where: { siteId_role: { siteId, role } },
    create: { siteId, role, method },
    update: { method },
  });

  await writeAudit(tx, user, {
    module: "Fleet",
    recordId: `${siteId}:${role}`,
    field: "incentiveMethod",
    afterValue: method,
    reasonCode: "INCENTIVE_METHOD_SET",
  });

  }, { timeout: 15000, isolationLevel: "ReadCommitted" });
  revalidatePath("/incentives");
  revalidatePath("/reports");
}
