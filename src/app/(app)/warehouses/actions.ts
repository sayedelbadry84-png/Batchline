"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";

const WAREHOUSE_ROLES = ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"];
// Approving a requisition commits the company to actually buying it —
// tighter than the general warehouse roster, same reasoning as the Sales
// approval chains elsewhere this session.
const REQUISITION_APPROVAL_ROLES = ["ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER"];

// ---------------------------------------------------------------------------
// Spare Parts
// ---------------------------------------------------------------------------

export async function createSparePart(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, WAREHOUSE_ROLES);

  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "");
  const unitOfMeasure = String(formData.get("unitOfMeasure") ?? "");
  const reorderThreshold = Number(formData.get("reorderThreshold") ?? 0) || null;
  const defaultSupplierId = String(formData.get("defaultSupplierId") ?? "") || null;
  const lastUnitCost = Number(formData.get("lastUnitCost") ?? 0) || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!code || !name || !category || !unitOfMeasure) return;

  const part = await prisma.sparePart.create({
    data: { code, name, category, unitOfMeasure, reorderThreshold, defaultSupplierId, lastUnitCost, notes },
  });

  await logAudit({ module: "Warehouses", recordId: part.id, afterValue: `${part.code} — ${name}`, reasonCode: "SPARE_PART_CREATED" });
  revalidatePath("/warehouses");
}

// Mirrors postReceiptToPurchaseOrderLine in material-receiving/actions.ts
// exactly, just against orderedQty/receivedQty (the spare-part-line
// fields) instead of orderedMassKg/receivedMassKg.
async function postReceiptToSparePartLine(purchaseOrderLineId: string, quantity: number) {
  const line = await prisma.purchaseOrderLine.update({
    where: { id: purchaseOrderLineId },
    data: { receivedQty: { increment: quantity } },
    include: { purchaseOrder: { include: { lines: true } } },
  });

  const allReceived = line.purchaseOrder.lines.every((l) => {
    if (l.orderedQty == null) return true; // a material line — not this function's concern
    const received = l.id === line.id ? line.receivedQty : l.receivedQty;
    return (received ?? 0) >= l.orderedQty;
  });
  const newStatus = allReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
  if (line.purchaseOrder.status !== newStatus) {
    await prisma.purchaseOrder.update({ where: { id: line.purchaseOrder.id }, data: { status: newStatus } });
  }
}

export async function receiveSparePart(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, WAREHOUSE_ROLES);

  const sparePartId = String(formData.get("sparePartId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 0);
  const unitCost = Number(formData.get("unitCost") ?? 0);
  const supplierId = String(formData.get("supplierId") ?? "") || null;
  const serialNumbers = String(formData.get("serialNumbers") ?? "").trim() || null;
  // Optional link to a real Purchasing PurchaseOrderLine — same shape as
  // Material Receiving's own purchaseOrderLineId picker.
  const purchaseOrderLineId = String(formData.get("purchaseOrderLineId") ?? "") || null;
  if (!sparePartId || !siteId || !quantity || quantity <= 0 || !unitCost || unitCost <= 0) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const receipt = await withSequentialNumber(
    "GRN",
    () => prisma.sparePartReceipt.count(),
    (receiptNumber) =>
      prisma.sparePartReceipt.create({
        data: { receiptNumber, sparePartId, siteId, quantity, unitCost, supplierId, serialNumbers, purchaseOrderLineId, receivedById: actor!.id },
      }),
  );

  if (purchaseOrderLineId) await postReceiptToSparePartLine(purchaseOrderLineId, quantity);

  // Keeps the catalog's "last cost" current for future price suggestions —
  // same reasoning as SupplierContract.pricePerUnit feeding Purchasing's PO
  // line suggestions.
  await prisma.sparePart.update({ where: { id: sparePartId }, data: { lastUnitCost: unitCost } });

  await logAudit({ module: "Warehouses", recordId: receipt.id, afterValue: `${receipt.receiptNumber} — ${quantity} @ ${unitCost}`, reasonCode: "SPARE_PART_RECEIVED" });
  revalidatePath("/warehouses");
  revalidatePath("/maintenance");
  revalidatePath("/purchasing");
}

export async function approveSparePartsRequisition(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, REQUISITION_APPROVAL_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const requisition = await prisma.sparePartsRequisition.findUnique({ where: { id } });
  if (!requisition || requisition.status !== "PENDING_APPROVAL") return;

  await prisma.sparePartsRequisition.update({
    where: { id },
    data: { status: "APPROVED", approvedById: actor!.id, approvedAt: new Date() },
  });

  await logAudit({ module: "Warehouses", recordId: id, afterValue: "APPROVED", reasonCode: "SPARE_PARTS_REQUISITION_APPROVED" });
  revalidatePath("/warehouses");
  revalidatePath("/purchasing");
}

export async function rejectSparePartsRequisition(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, REQUISITION_APPROVAL_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const requisition = await prisma.sparePartsRequisition.findUnique({ where: { id } });
  if (!requisition || requisition.status !== "PENDING_APPROVAL") return;

  await prisma.sparePartsRequisition.update({
    where: { id },
    data: { status: "REJECTED", approvedById: actor!.id, approvedAt: new Date() },
  });

  await logAudit({ module: "Warehouses", recordId: id, afterValue: "REJECTED", reasonCode: "SPARE_PARTS_REQUISITION_REJECTED" });
  revalidatePath("/warehouses");
}

// Raw-material counterpart to the two actions above — same approval gate,
// same PENDING_APPROVAL-only guard, for MaterialRequisition rows
// auto-created by completeBatch (production/actions.ts) instead of raised
// by a person.
export async function approveMaterialRequisition(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, REQUISITION_APPROVAL_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const requisition = await prisma.materialRequisition.findUnique({ where: { id } });
  if (!requisition || requisition.status !== "PENDING_APPROVAL") return;

  await prisma.materialRequisition.update({
    where: { id },
    data: { status: "APPROVED", approvedById: actor!.id, approvedAt: new Date() },
  });

  await logAudit({ module: "Warehouses", recordId: id, afterValue: "APPROVED", reasonCode: "MATERIAL_REQUISITION_APPROVED" });
  revalidatePath("/warehouses");
  revalidatePath("/purchasing");
}

export async function rejectMaterialRequisition(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, REQUISITION_APPROVAL_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const requisition = await prisma.materialRequisition.findUnique({ where: { id } });
  if (!requisition || requisition.status !== "PENDING_APPROVAL") return;

  await prisma.materialRequisition.update({
    where: { id },
    data: { status: "REJECTED", approvedById: actor!.id, approvedAt: new Date() },
  });

  await logAudit({ module: "Warehouses", recordId: id, afterValue: "REJECTED", reasonCode: "MATERIAL_REQUISITION_REJECTED" });
  revalidatePath("/warehouses");
}

// ---------------------------------------------------------------------------
// Finished Goods
// ---------------------------------------------------------------------------

export async function createFinishedProduct(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, WAREHOUSE_ROLES);

  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const unitOfMeasure = String(formData.get("unitOfMeasure") ?? "").trim();
  const unitPrice = Number(formData.get("unitPrice") ?? 0) || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!code || !name || !unitOfMeasure) return;

  const product = await prisma.finishedProduct.create({
    data: { code, name, unitOfMeasure, unitPrice, notes },
  });

  await logAudit({ module: "Warehouses", recordId: product.id, afterValue: `${product.code} — ${name}`, reasonCode: "FINISHED_PRODUCT_CREATED" });
  revalidatePath("/warehouses");
}

export async function recordFinishedProductMovement(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, WAREHOUSE_ROLES);

  const productId = String(formData.get("productId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const direction = String(formData.get("direction") ?? "");
  const quantity = Number(formData.get("quantity") ?? 0);
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!productId || !siteId || !["IN", "OUT"].includes(direction) || !quantity || quantity <= 0) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const movement = await prisma.finishedProductMovement.create({
    data: { productId, siteId, direction, quantity, notes, recordedById: actor!.id },
  });

  await logAudit({ module: "Warehouses", recordId: movement.id, afterValue: `${direction} ${quantity}`, reasonCode: "FINISHED_PRODUCT_MOVEMENT_RECORDED" });
  revalidatePath("/warehouses");
}
