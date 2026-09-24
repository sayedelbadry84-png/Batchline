"use server";

import { prisma } from "@/lib/prisma";
import { logAudit, writeAudit } from "@/lib/audit";
import { canPerformAction } from "@/lib/permissions";
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

// Specific gravity is a property of the MATERIAL, not of the mix — the same
// admixture has the same SG in every design that uses it — so it is stored
// on Material and shown per component row. What this action adds is the
// ability to supply it from the mix design form when the material has
// none, because that is exactly when it is needed.
//
// It was needed and silently missing before. A dose entered in liters is
// converted to kg by multiplying by SG; when the material had no SG the
// conversion was skipped and the LITER figure was stored as if it were
// kilograms. An admixture at SG 1.2 dosed at 5 L/m³ was recorded as 5 kg
// instead of 6 — a 17% under-dose in the batching target, with nothing on
// screen to say so. A liter dose now requires an SG, from the material or
// from this form, and is refused with a visible message otherwise.
export async function addComponent(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "mix-designs", "addComponent");

  const mixId = String(formData.get("mixId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const enteredValue = Number(formData.get("designMassKgPerM3") ?? 0);
  const tolerancePct = Number(formData.get("tolerancePct") ?? 2);
  const dosageUnit = String(formData.get("dosageUnit") ?? "KG");
  const sgRaw = String(formData.get("specificGravity") ?? "").trim();

  if (!mixId || !materialId || !Number.isFinite(enteredValue) || enteredValue <= 0) return;
  if (dosageUnit !== "KG" && dosageUnit !== "LITER") return;
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0 || tolerancePct > 100) return;

  const back = (error: string) => `/mix-designs/${mixId}?componentError=${error}&editComponent=${encodeURIComponent(materialId)}`;

  const material = await prisma.material.findUnique({ where: { id: materialId }, select: { specificGravity: true } });
  if (!material) return;

  let specificGravity = material.specificGravity;
  let fillMaterialSg: number | null = null;
  if (sgRaw !== "") {
    const entered = Number(sgRaw);
    // Plausible range for concrete materials: lightweight aggregate ~0.6,
    // Portland cement ~3.15. Outside it is a typo, not a material.
    if (!Number.isFinite(entered) || entered < 0.5 || entered > 4) redirect(back("SG_INVALID"));
    // Only ever FILLS a gap. A material that already has an SG keeps it:
    // changing an existing value would silently rescale every other mix
    // using that material, which is a Purchasing decision, not this form's.
    if (specificGravity == null) {
      fillMaterialSg = entered;
      specificGravity = entered;
    }
  }

  if (dosageUnit === "LITER" && !specificGravity) redirect(back("SG_REQUIRED"));
  if (fillMaterialSg !== null && !(await canPerformAction(user!.role, "purchasing", "updateMaterial"))) redirect(back("SG_NOT_PERMITTED"));

  const designMassKgPerM3 = dosageUnit === "LITER" ? enteredValue * specificGravity! : enteredValue;
  const actor = { id: user!.id, role: user!.role };

  await prisma.$transaction(async (tx) => {
    if (fillMaterialSg !== null) {
      // Conditional on still being empty, so two people filling it at once
      // cannot overwrite each other.
      const filled = await tx.material.updateMany({ where: { id: materialId, specificGravity: null }, data: { specificGravity: fillMaterialSg } });
      if (filled.count === 1) {
        await writeAudit(tx, actor, {
          module: "Suppliers",
          recordId: materialId,
          field: "specificGravity",
          afterValue: String(fillMaterialSg),
          reasonCode: "MATERIAL_SG_SET_FROM_MIX_DESIGN",
        });
      }
    }

    await tx.mixComponent.upsert({
      where: { mixId_materialId: { mixId, materialId } },
      create: { mixId, materialId, designMassKgPerM3, tolerancePct, dosageUnit },
      update: { designMassKgPerM3, tolerancePct, dosageUnit },
    });

    await writeAudit(tx, actor, {
      module: "MixDesign",
      recordId: mixId,
      field: "component",
      afterValue: `${materialId}: ${designMassKgPerM3} kg/m3${dosageUnit === "LITER" ? ` (${enteredValue} L at SG ${specificGravity})` : ""}`,
      reasonCode: "COMPONENT_UPDATED",
    });
  });

  revalidatePath(`/mix-designs/${mixId}`);
  redirect(`/mix-designs/${mixId}`);
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
