"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function updateIncentivePolicy(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const freeTripsThreshold = Number(formData.get("freeTripsThreshold") ?? 10);
  const tier2Threshold = Number(formData.get("tier2Threshold") ?? 15);
  const tier2RateSar = Number(formData.get("tier2RateSar") ?? 0);
  const tier3Threshold = Number(formData.get("tier3Threshold") ?? 20);
  const tier3RateSar = Number(formData.get("tier3RateSar") ?? 0);
  const beyondRateSar = Number(formData.get("beyondRateSar") ?? 0);
  if (!plantId) return;

  const before = await prisma.driverIncentivePolicy.findUnique({ where: { plantId } });

  await prisma.driverIncentivePolicy.upsert({
    where: { plantId },
    create: { plantId, freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
    update: { freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar },
  });

  await logAudit({
    module: "Fleet",
    recordId: plantId,
    field: "driverIncentivePolicy",
    beforeValue: before ? JSON.stringify(before) : undefined,
    afterValue: JSON.stringify({ freeTripsThreshold, tier2Threshold, tier2RateSar, tier3Threshold, tier3RateSar, beyondRateSar }),
    reasonCode: "INCENTIVE_POLICY_UPDATED",
  });

  revalidatePath("/incentives");
}
