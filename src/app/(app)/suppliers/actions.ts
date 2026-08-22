"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function createSupplier(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"]);

  const name = String(formData.get("name") ?? "").trim();
  const materialCatalog = String(formData.get("materialCatalog") ?? "").trim();
  const leadTimeDays = Number(formData.get("leadTimeDays") ?? 0) || null;
  if (!name) return;

  const supplier = await prisma.supplier.create({
    data: { name, materialCatalog, leadTimeDays },
  });

  await logAudit({ module: "Suppliers", recordId: supplier.id, afterValue: name, reasonCode: "SUPPLIER_CREATED" });
  revalidatePath("/suppliers");
  // Also reachable from Material Receiving's own intake form (an inline
  // "+ add supplier" so a weighbridge operator never has to leave that
  // screen) — revalidated here too so the new supplier shows up in its
  // picker without a separate save.
  revalidatePath("/material-receiving");
}

export async function createMaterial(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"]);

  const supplierId = String(formData.get("supplierId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim() || null;
  const specificGravity = Number(formData.get("specificGravity") ?? 0) || null;
  const absorptionPct = Number(formData.get("absorptionPct") ?? 0) || null;
  if (!name || !type) return;

  const material = await prisma.material.create({
    data: { supplierId, name, type, brand, specificGravity, absorptionPct },
  });

  await logAudit({ module: "Suppliers", recordId: material.id, afterValue: name, reasonCode: "MATERIAL_CREATED" });
  revalidatePath("/suppliers");
}

export async function updateSupplier(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const materialCatalog = String(formData.get("materialCatalog") ?? "").trim();
  const leadTimeDays = Number(formData.get("leadTimeDays") ?? 0) || null;
  if (!id || !name) return;

  await prisma.supplier.update({ where: { id }, data: { name, materialCatalog, leadTimeDays } });

  await logAudit({ module: "Suppliers", recordId: id, afterValue: name, reasonCode: "SUPPLIER_UPDATED" });
  revalidatePath("/suppliers");
}

export async function updateMaterial(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const supplierId = String(formData.get("supplierId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim() || null;
  const specificGravity = Number(formData.get("specificGravity") ?? 0) || null;
  const absorptionPct = Number(formData.get("absorptionPct") ?? 0) || null;
  if (!id || !name || !type) return;

  await prisma.material.update({
    where: { id },
    data: { supplierId, name, type, brand, specificGravity, absorptionPct },
  });

  await logAudit({ module: "Suppliers", recordId: id, afterValue: name, reasonCode: "MATERIAL_UPDATED" });
  revalidatePath("/suppliers");
}
