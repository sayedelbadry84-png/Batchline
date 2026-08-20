"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createMixDesign(formData: FormData) {
  const code = String(formData.get("code") ?? "").trim();
  const grade = String(formData.get("grade") ?? "").trim();
  const exposureClass = String(formData.get("exposureClass") ?? "").trim();
  const slumpTargetMm = Number(formData.get("slumpTargetMm") ?? 0);
  const wcRatio = Number(formData.get("wcRatio") ?? 0);
  const yieldTargetM3 = Number(formData.get("yieldTargetM3") ?? 1);

  if (!code || !grade) return;

  const mix = await prisma.mixDesign.create({
    data: { code, grade, exposureClass, slumpTargetMm, wcRatio, yieldTargetM3, status: "DRAFT" },
  });

  await logAudit({ module: "MixDesign", recordId: mix.id, afterValue: code, reasonCode: "MIX_CREATED" });
  revalidatePath("/mix-designs");
  redirect(`/mix-designs/${mix.id}`);
}

export async function updateMixDesign(formData: FormData) {
  const mixId = String(formData.get("mixId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const grade = String(formData.get("grade") ?? "").trim();
  const exposureClass = String(formData.get("exposureClass") ?? "").trim();
  const slumpTargetMm = Number(formData.get("slumpTargetMm") ?? 0);
  const wcRatio = Number(formData.get("wcRatio") ?? 0);
  const yieldTargetM3 = Number(formData.get("yieldTargetM3") ?? 1);
  const standardCost = Number(formData.get("standardCost") ?? 0) || null;

  if (!mixId || !code || !grade) return;

  await prisma.mixDesign.update({
    where: { id: mixId },
    data: { code, grade, exposureClass, slumpTargetMm, wcRatio, yieldTargetM3, standardCost },
  });

  await logAudit({ module: "MixDesign", recordId: mixId, afterValue: code, reasonCode: "MIX_UPDATED" });
  revalidatePath(`/mix-designs/${mixId}`);
  revalidatePath("/mix-designs");
}

export async function addComponent(formData: FormData) {
  const mixId = String(formData.get("mixId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const designMassKgPerM3 = Number(formData.get("designMassKgPerM3") ?? 0);
  const tolerancePct = Number(formData.get("tolerancePct") ?? 2);

  if (!mixId || !materialId || !designMassKgPerM3) return;

  await prisma.mixComponent.upsert({
    where: { mixId_materialId: { mixId, materialId } },
    create: { mixId, materialId, designMassKgPerM3, tolerancePct },
    update: { designMassKgPerM3, tolerancePct },
  });

  await logAudit({
    module: "MixDesign",
    recordId: mixId,
    field: "component",
    afterValue: `${materialId}: ${designMassKgPerM3} kg/m3`,
    reasonCode: "COMPONENT_UPDATED",
  });

  revalidatePath(`/mix-designs/${mixId}`);
}

// Approving a mix design is the gate before it can be batched — restricted
// to the role that owns quality sign-off, per the RBAC matrix.
export async function setMixStatus(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

  const mixId = String(formData.get("mixId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!mixId || !status) return;

  const before = await prisma.mixDesign.findUnique({ where: { id: mixId } });
  await prisma.mixDesign.update({ where: { id: mixId }, data: { status } });

  await logAudit({
    module: "MixDesign",
    recordId: mixId,
    field: "status",
    beforeValue: before?.status,
    afterValue: status,
    reasonCode: "STATUS_CHANGE",
  });

  revalidatePath(`/mix-designs/${mixId}`);
}
