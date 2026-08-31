"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createMixDesign(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "mix-designs", "create");

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
  const user = await getCurrentUser();
  await requireActionPermission(user, "mix-designs", "update");

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
  const user = await getCurrentUser();
  await requireActionPermission(user, "mix-designs", "addComponent");

  const mixId = String(formData.get("mixId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const enteredValue = Number(formData.get("designMassKgPerM3") ?? 0);
  const tolerancePct = Number(formData.get("tolerancePct") ?? 2);
  const dosageUnit = String(formData.get("dosageUnit") ?? "KG");

  if (!mixId || !materialId || !enteredValue) return;

  // Chemical admixtures are conventionally dosed by volume on site — when
  // the operator enters liters, convert to the kg the yield-factor math
  // actually needs using the material's own specific gravity (the same
  // absolute-volume-method conversion already used for design volume);
  // designMassKgPerM3 stays the one stored figure either way.
  let designMassKgPerM3 = enteredValue;
  if (dosageUnit === "LITER") {
    const material = await prisma.material.findUnique({ where: { id: materialId } });
    if (material?.specificGravity) designMassKgPerM3 = enteredValue * material.specificGravity;
  }

  await prisma.mixComponent.upsert({
    where: { mixId_materialId: { mixId, materialId } },
    create: { mixId, materialId, designMassKgPerM3, tolerancePct, dosageUnit },
    update: { designMassKgPerM3, tolerancePct, dosageUnit },
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

// Freely removable at any mix status, including APPROVED — a mix design
// edited mid-production never touches tickets already released against
// it, since BatchTicket snapshots its own component targets at release
// time (see releaseBatchTicket in production/actions.ts).
export async function deleteComponent(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "mix-designs", "deleteComponent");

  const mixId = String(formData.get("mixId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  if (!mixId || !materialId) return;

  await prisma.mixComponent.delete({ where: { mixId_materialId: { mixId, materialId } } });

  await logAudit({
    module: "MixDesign",
    recordId: mixId,
    field: "component",
    afterValue: materialId,
    reasonCode: "COMPONENT_REMOVED",
  });

  revalidatePath(`/mix-designs/${mixId}`);
}

// Approving a mix design is the gate before it can be batched — restricted
// to the role that owns quality sign-off, per the RBAC matrix.
export async function setMixStatus(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "mix-designs", "setStatus");

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
