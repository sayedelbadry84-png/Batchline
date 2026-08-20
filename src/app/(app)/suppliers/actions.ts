"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createSupplier(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const materialCatalog = String(formData.get("materialCatalog") ?? "").trim();
  const leadTimeDays = Number(formData.get("leadTimeDays") ?? 0) || null;
  if (!name) return;

  const supplier = await prisma.supplier.create({
    data: { name, materialCatalog, leadTimeDays },
  });

  await logAudit({ module: "Suppliers", recordId: supplier.id, afterValue: name, reasonCode: "SUPPLIER_CREATED" });
  revalidatePath("/suppliers");
}

export async function createMaterial(formData: FormData) {
  const supplierId = String(formData.get("supplierId") ?? "") || null;
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  const specificGravity = Number(formData.get("specificGravity") ?? 0) || null;
  const absorptionPct = Number(formData.get("absorptionPct") ?? 0) || null;
  if (!name || !type) return;

  const material = await prisma.material.create({
    data: { supplierId, name, type, specificGravity, absorptionPct },
  });

  await logAudit({ module: "Suppliers", recordId: material.id, afterValue: name, reasonCode: "MATERIAL_CREATED" });
  revalidatePath("/suppliers");
}
