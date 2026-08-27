"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";

const PURCHASING_ROLES = ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"];

export async function createPurchaseOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const supplierId = String(formData.get("supplierId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const expectedDateRaw = String(formData.get("expectedDate") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const materialIds = formData.getAll("materialId").map(String);
  const massValues = formData.getAll("orderedMassKg").map(Number);
  const priceValues = formData.getAll("unitPrice").map(Number);
  const lines = materialIds
    .map((materialId, i) => ({ materialId, orderedMassKg: massValues[i] || 0, unitPrice: priceValues[i] || 0 }))
    .filter((l) => l.materialId && l.orderedMassKg > 0 && l.unitPrice > 0)
    .map((l) => ({ ...l, lineTotal: l.orderedMassKg * l.unitPrice }));

  if (!supplierId || !siteId || lines.length === 0) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const plantId = await resolvePlantIdForSite(siteId);
  const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId } }) : null;
  const currency = plant?.currency ?? "EGP";
  const taxRatePct = plant?.taxRatePct ?? 0;

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const taxAmount = subtotal * (taxRatePct / 100);
  const total = subtotal + taxAmount;

  const po = await withSequentialNumber(
    "PO",
    () => prisma.purchaseOrder.count(),
    (poNumber) =>
      prisma.purchaseOrder.create({
        data: {
          poNumber,
          supplierId,
          siteId,
          expectedDate: expectedDateRaw ? new Date(expectedDateRaw) : null,
          currency,
          subtotal,
          taxRatePct,
          taxAmount,
          total,
          notes,
          createdById: actor!.id,
          lines: { create: lines },
        },
      }),
  );

  await logAudit({ module: "Purchasing", recordId: po.id, afterValue: `${po.poNumber} — ${total} ${currency}`, reasonCode: "PO_CREATED" });
  revalidatePath("/purchasing");
}

// Header fields only, and only while DRAFT — once a PO has gone out
// (markPurchaseOrderSent) the supplier is already working off those exact
// numbers, same reasoning as Quote/updateQuote in the Sales module.
export async function updatePurchaseOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const id = String(formData.get("id") ?? "");
  const expectedDateRaw = String(formData.get("expectedDate") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!id) return;

  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po || po.status !== "DRAFT") return;
  if (!isSiteInScope(po.siteId, effectiveSiteId(actor))) return;

  await prisma.purchaseOrder.update({
    where: { id },
    data: { expectedDate: expectedDateRaw ? new Date(expectedDateRaw) : null, notes },
  });

  await logAudit({ module: "Purchasing", recordId: id, reasonCode: "PO_UPDATED" });
  revalidatePath("/purchasing");
}

export async function markPurchaseOrderSent(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po || po.status !== "DRAFT") return;

  await prisma.purchaseOrder.update({ where: { id }, data: { status: "SENT" } });

  await logAudit({ module: "Purchasing", recordId: id, afterValue: "SENT", reasonCode: "PO_SENT" });
  revalidatePath("/purchasing");
}

// Refused once anything has been received against it (RECEIVED/
// PARTIALLY_RECEIVED) — a delivery already happened, so cancelling the
// order retroactively would misrepresent real inventory history.
export async function cancelPurchaseOrder(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po || !["DRAFT", "SENT"].includes(po.status)) return;

  await prisma.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Purchasing", recordId: id, afterValue: "CANCELLED", reasonCode: "PO_CANCELLED" });
  revalidatePath("/purchasing");
}

export async function createSupplierContract(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const supplierId = String(formData.get("supplierId") ?? "");
  const materialId = String(formData.get("materialId") ?? "") || null;
  const startDateRaw = String(formData.get("startDate") ?? "");
  const endDateRaw = String(formData.get("endDate") ?? "");
  const pricePerUnit = Number(formData.get("pricePerUnit") ?? 0) || null;
  const paymentTerms = String(formData.get("paymentTerms") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!supplierId || !startDateRaw) return;

  const contract = await withSequentialNumber(
    "SC",
    () => prisma.supplierContract.count(),
    (contractNumber) =>
      prisma.supplierContract.create({
        data: {
          contractNumber,
          supplierId,
          materialId,
          startDate: new Date(startDateRaw),
          endDate: endDateRaw ? new Date(endDateRaw) : null,
          pricePerUnit,
          paymentTerms,
          notes,
        },
      }),
  );

  await logAudit({ module: "Purchasing", recordId: contract.id, afterValue: contract.contractNumber, reasonCode: "SUPPLIER_CONTRACT_CREATED" });
  revalidatePath("/purchasing");
}

export async function terminateSupplierContract(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.supplierContract.update({ where: { id }, data: { status: "TERMINATED" } });

  await logAudit({ module: "Purchasing", recordId: id, afterValue: "TERMINATED", reasonCode: "SUPPLIER_CONTRACT_TERMINATED" });
  revalidatePath("/purchasing");
}
