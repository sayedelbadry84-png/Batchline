"use server";

import { prisma } from "@/lib/prisma";
import { logAudit, writeAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { CO2E_FACTOR_KG_PER_KG } from "@/lib/carbon";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Purchasing procedure P/QM/008 §7.5 banding, applied to the weighted score.
function bandCategory(weightedScorePct: number): string {
  if (weightedScorePct >= 95) return "A";
  if (weightedScorePct >= 90) return "B";
  return "C";
}

export async function createSupplier(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "createSupplier");

  const name = String(formData.get("name") ?? "").trim();
  const materialCatalog = String(formData.get("materialCatalog") ?? "").trim();
  const leadTimeDays = Number(formData.get("leadTimeDays") ?? 0) || null;
  const address = String(formData.get("address") ?? "").trim() || null;
  const contactMethod = String(formData.get("contactMethod") ?? "").trim() || null;
  if (!name) return;

  const supplier = await prisma.supplier.create({
    // approvedOn is the register's own "Date on" — set to the moment this
    // supplier is actually added, never backdated (see schema comment).
    data: { name, materialCatalog, leadTimeDays, address, contactMethod, approvedOn: new Date() },
  });

  await logAudit({ module: "Suppliers", recordId: supplier.id, afterValue: name, reasonCode: "SUPPLIER_CREATED" });
  revalidatePath("/purchasing");
  // Also reachable from Material Receiving's own intake form (an inline
  // "+ add supplier" so a weighbridge operator never has to leave that
  // screen) — revalidated here too so the new supplier shows up in its
  // picker without a separate save.
  revalidatePath("/warehouses");
}

export async function createMaterial(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "createMaterial");

  const supplierId = String(formData.get("supplierId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim() || null;
  const specificGravity = Number(formData.get("specificGravity") ?? 0) || null;
  const absorptionPct = Number(formData.get("absorptionPct") ?? 0) || null;
  const lastUnitCost = Number(formData.get("lastUnitCost") ?? 0) || null;
  // Explicit 0 is a real, meaningful override (e.g. a recycled/by-product
  // material with no attributed footprint) — only an entirely blank field
  // falls back to the standard published default for this material type.
  const co2FactorRaw = String(formData.get("co2FactorKgPerKg") ?? "").trim();
  const co2FactorKgPerKg = co2FactorRaw ? Number(co2FactorRaw) : (CO2E_FACTOR_KG_PER_KG[type] ?? null);
  // Inverted on purpose (a "not tracked" checkbox, unchecked by default)
  // — an HTML checkbox that's off simply isn't present in formData at
  // all, so a normal "inventoryTracked" checkbox would silently default
  // new materials to untracked unless every form remembered to check it.
  const inventoryTracked = formData.get("notInventoryTracked") !== "on";
  if (!name || !type) return;

  const material = await prisma.material.create({
    data: { supplierId, name, type, brand, specificGravity, absorptionPct, lastUnitCost, co2FactorKgPerKg, inventoryTracked },
  });

  await logAudit({ module: "Suppliers", recordId: material.id, afterValue: name, reasonCode: "MATERIAL_CREATED" });
  revalidatePath("/purchasing");
}

// The saved edit has to be SEEN to count as saved. This used to write the
// row and revalidate /purchasing, but the page was still addressed with
// `&editSupplier=<id>`, so it re-rendered the same open edit form — the
// catalog row with the new values never appeared, and an end-to-end pass
// correctly reported the edit as not persisted. Leaving edit mode on
// success is what puts the stored values back in front of the user.
//
// Also: the write is a conditional updateMany rather than update(), so an
// id that no longer exists is a quiet refusal instead of an unhandled
// P2025; a lead time that is not a whole number of days is refused
// rather than silently cleared; and the audit row carries the before
// value and commits with the change.
export async function updateSupplier(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "updateSupplier");

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const materialCatalog = String(formData.get("materialCatalog") ?? "").trim() || null;
  const leadTimeRaw = String(formData.get("leadTimeDays") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim() || null;
  const contactMethod = String(formData.get("contactMethod") ?? "").trim() || null;
  if (!id || !name) return;

  let leadTimeDays: number | null = null;
  if (leadTimeRaw !== "") {
    const parsed = Number(leadTimeRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) return;
    leadTimeDays = parsed;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.supplier.findUnique({ where: { id }, select: { name: true, materialCatalog: true, leadTimeDays: true, address: true, contactMethod: true } });
    if (!before) return false;
    const claim = await tx.supplier.updateMany({ where: { id }, data: { name, materialCatalog, leadTimeDays, address, contactMethod } });
    if (claim.count !== 1) return false;
    await writeAudit(tx, { id: user!.id, role: user!.role }, {
      module: "Suppliers",
      recordId: id,
      field: "name/catalog/leadTime/address/contact",
      beforeValue: `${before.name} / ${before.materialCatalog ?? ""} / ${before.leadTimeDays ?? ""} / ${before.address ?? ""} / ${before.contactMethod ?? ""}`,
      afterValue: `${name} / ${materialCatalog ?? ""} / ${leadTimeDays ?? ""} / ${address ?? ""} / ${contactMethod ?? ""}`,
      reasonCode: "SUPPLIER_UPDATED",
    });
    return true;
  });
  if (!updated) return;

  revalidatePath("/purchasing");
  redirect("/purchasing?tab=suppliers");
}

export async function updateMaterial(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "updateMaterial");

  const id = String(formData.get("id") ?? "");
  const supplierId = String(formData.get("supplierId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim() || null;
  const specificGravity = Number(formData.get("specificGravity") ?? 0) || null;
  const absorptionPct = Number(formData.get("absorptionPct") ?? 0) || null;
  const lastUnitCost = Number(formData.get("lastUnitCost") ?? 0) || null;
  const co2FactorKgPerKg = Number(formData.get("co2FactorKgPerKg") ?? 0) || null;
  const inventoryTracked = formData.get("notInventoryTracked") !== "on";
  if (!id || !name || !type) return;

  await prisma.material.update({
    where: { id },
    data: { supplierId, name, type, brand, specificGravity, absorptionPct, lastUnitCost, co2FactorKgPerKg, inventoryTracked },
  });

  await logAudit({ module: "Suppliers", recordId: id, afterValue: name, reasonCode: "MATERIAL_UPDATED" });
  revalidatePath("/purchasing");
  // Same defect as updateSupplier above: without leaving edit mode the
  // saved values never replace the open form.
  redirect("/purchasing?tab=suppliers");
}

export async function createSupplierEvaluation(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "createSupplierEvaluation");

  const supplierId = String(formData.get("supplierId") ?? "");
  const periodYear = Number(formData.get("periodYear") ?? 0);
  const specComplianceScorePct = Number(formData.get("specComplianceScorePct") ?? NaN);
  const shelfLifeScorePct = Number(formData.get("shelfLifeScorePct") ?? NaN);
  const onTimeDeliveryScorePct = Number(formData.get("onTimeDeliveryScorePct") ?? NaN);
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (
    !supplierId ||
    !periodYear ||
    !Number.isFinite(specComplianceScorePct) ||
    !Number.isFinite(shelfLifeScorePct) ||
    !Number.isFinite(onTimeDeliveryScorePct)
  )
    return;

  // Real weights 40/20/20 (see schema comment on SupplierEvaluation for why
  // the form's own fourth line is excluded), renormalized to sum to 100.
  const weightedScorePct =
    specComplianceScorePct * 0.5 + shelfLifeScorePct * 0.25 + onTimeDeliveryScorePct * 0.25;
  const category = bandCategory(weightedScorePct);

  const evaluation = await withSequentialNumber(
    "SEV",
    (yr) => prisma.supplierEvaluation.count({ where: { createdAt: yr } }),
    (evaluationNumber) =>
      prisma.supplierEvaluation.create({
        data: {
          evaluationNumber,
          supplierId,
          periodYear,
          specComplianceScorePct,
          shelfLifeScorePct,
          onTimeDeliveryScorePct,
          weightedScorePct,
          category,
          notes,
          evaluatedById: user!.id,
        },
      }),
  );

  await logAudit({
    module: "Suppliers",
    recordId: evaluation.id,
    afterValue: `${category} (${weightedScorePct.toFixed(1)}%)`,
    reasonCode: "SUPPLIER_EVALUATION_CREATED",
  });
  revalidatePath("/purchasing");
}

// Certified Suppliers' Register (F/QM/008/2/1) status flip — "Date off"
// when discontinuing, cleared on reactivation (approvedOn/"Date on" is left
// as originally set, not refreshed). Discontinuing requires a written
// reason on file, same "no note, no status change" discipline as CAPA
// close, waste memo approval, and the incoming-inspection finding.
export async function setSupplierStatus(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "setSupplierStatus");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!id || (status !== "ACTIVE" && status !== "DISCONTINUED")) return;
  if (status === "DISCONTINUED" && !note) return;

  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) return;

  await prisma.supplier.update({
    where: { id },
    data: {
      status,
      discontinuedOn: status === "DISCONTINUED" ? new Date() : null,
      notes: note || supplier.notes,
    },
  });

  await logAudit({
    module: "Suppliers",
    recordId: id,
    field: "status",
    beforeValue: supplier.status,
    afterValue: status,
    reasonCode: status === "DISCONTINUED" ? "SUPPLIER_DISCONTINUED" : "SUPPLIER_REACTIVATED",
  });
  revalidatePath("/purchasing");
}
