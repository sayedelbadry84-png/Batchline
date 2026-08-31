"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { CO2E_FACTOR_KG_PER_KG } from "@/lib/carbon";
import { revalidatePath } from "next/cache";

export async function createSupplier(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "createSupplier");

  const name = String(formData.get("name") ?? "").trim();
  const materialCatalog = String(formData.get("materialCatalog") ?? "").trim();
  const leadTimeDays = Number(formData.get("leadTimeDays") ?? 0) || null;
  if (!name) return;

  const supplier = await prisma.supplier.create({
    data: { name, materialCatalog, leadTimeDays },
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
  if (!name || !type) return;

  const material = await prisma.material.create({
    data: { supplierId, name, type, brand, specificGravity, absorptionPct, lastUnitCost, co2FactorKgPerKg },
  });

  await logAudit({ module: "Suppliers", recordId: material.id, afterValue: name, reasonCode: "MATERIAL_CREATED" });
  revalidatePath("/purchasing");
}

export async function updateSupplier(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "purchasing", "updateSupplier");

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const materialCatalog = String(formData.get("materialCatalog") ?? "").trim();
  const leadTimeDays = Number(formData.get("leadTimeDays") ?? 0) || null;
  if (!id || !name) return;

  await prisma.supplier.update({ where: { id }, data: { name, materialCatalog, leadTimeDays } });

  await logAudit({ module: "Suppliers", recordId: id, afterValue: name, reasonCode: "SUPPLIER_UPDATED" });
  revalidatePath("/purchasing");
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
  if (!id || !name || !type) return;

  await prisma.material.update({
    where: { id },
    data: { supplierId, name, type, brand, specificGravity, absorptionPct, lastUnitCost, co2FactorKgPerKg },
  });

  await logAudit({ module: "Suppliers", recordId: id, afterValue: name, reasonCode: "MATERIAL_UPDATED" });
  revalidatePath("/purchasing");
}
