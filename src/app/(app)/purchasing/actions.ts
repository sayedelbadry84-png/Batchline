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

// A market price move against a live contract is a new negotiated term,
// not a silent edit to the old one — so this closes the current contract
// today and opens a fresh one at the new price starting today, same
// supplier/material/payment terms carried over. One click covers both
// steps a manual terminate-then-recreate would otherwise take, while
// still keeping the old contract's own price and dates on record for
// cost history — same reasoning as Quote/Opportunity keeping their prior
// approval stamps instead of being overwritten in place.
export async function renewSupplierContract(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const id = String(formData.get("id") ?? "");
  const pricePerUnit = Number(formData.get("pricePerUnit") ?? 0);
  if (!id || !pricePerUnit || pricePerUnit <= 0) return;

  const old = await prisma.supplierContract.findUnique({ where: { id } });
  if (!old || old.status !== "ACTIVE") return;

  const today = new Date();
  const contract = await withSequentialNumber(
    "SC",
    () => prisma.supplierContract.count(),
    (contractNumber) =>
      prisma.$transaction(async (tx) => {
        await tx.supplierContract.update({ where: { id }, data: { status: "TERMINATED", endDate: today } });
        return tx.supplierContract.create({
          data: {
            contractNumber,
            supplierId: old.supplierId,
            materialId: old.materialId,
            startDate: today,
            endDate: null,
            pricePerUnit,
            paymentTerms: old.paymentTerms,
            notes: old.notes,
          },
        });
      }),
  );

  await logAudit({
    module: "Purchasing",
    recordId: contract.id,
    beforeValue: `${old.contractNumber} — ${old.pricePerUnit ?? "—"}`,
    afterValue: `${contract.contractNumber} — ${pricePerUnit}`,
    reasonCode: "SUPPLIER_CONTRACT_RENEWED",
  });
  revalidatePath("/purchasing");
}

// The Maintenance-to-Procurement loop's last hop before receiving: bundles
// one or more APPROVED SparePartsRequisition rows (see Warehouses' Spare
// Parts tab) into a single new PO, one line per requisition, and stamps
// each requisition ORDERED + its new line's id so the chain stays
// traceable end to end. A requisition with no price entered here (left at
// 0) is simply left out — same "0 or blank means skip this row" filtering
// createPurchaseOrder's own material-line rows already use.
export async function createPurchaseOrderFromRequisitions(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, PURCHASING_ROLES);

  const supplierId = String(formData.get("supplierId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  if (!supplierId || !siteId) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const requisitionIds = formData.getAll("requisitionId").map(String);
  const unitPrices = formData.getAll("unitPrice").map(Number);
  const picks = requisitionIds
    .map((id, i) => ({ id, unitPrice: unitPrices[i] || 0 }))
    .filter((p) => p.id && p.unitPrice > 0);
  if (picks.length === 0) return;

  const requisitions = await prisma.sparePartsRequisition.findMany({
    where: { id: { in: picks.map((p) => p.id) }, status: "APPROVED" },
  });
  if (requisitions.length === 0) return;

  const plantId = await resolvePlantIdForSite(siteId);
  const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId } }) : null;
  const currency = plant?.currency ?? "EGP";
  const taxRatePct = plant?.taxRatePct ?? 0;

  const lines = requisitions.map((r) => {
    const unitPrice = picks.find((p) => p.id === r.id)!.unitPrice;
    return { requisition: r, unitPrice, lineTotal: r.quantityNeeded * unitPrice };
  });
  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const taxAmount = subtotal * (taxRatePct / 100);
  const total = subtotal + taxAmount;

  const po = await withSequentialNumber(
    "PO",
    () => prisma.purchaseOrder.count(),
    (poNumber) =>
      prisma.$transaction(async (tx) => {
        const created = await tx.purchaseOrder.create({
          data: { poNumber, supplierId, siteId, currency, subtotal, taxRatePct, taxAmount, total, createdById: actor!.id },
        });
        for (const l of lines) {
          const line = await tx.purchaseOrderLine.create({
            data: {
              purchaseOrderId: created.id,
              sparePartId: l.requisition.sparePartId,
              orderedQty: l.requisition.quantityNeeded,
              receivedQty: 0,
              unitPrice: l.unitPrice,
              lineTotal: l.lineTotal,
            },
          });
          await tx.sparePartsRequisition.update({
            where: { id: l.requisition.id },
            data: { status: "ORDERED", purchaseOrderLineId: line.id },
          });
        }
        return created;
      }),
  );

  await logAudit({ module: "Purchasing", recordId: po.id, afterValue: `${po.poNumber} — ${total} ${currency} (${lines.length} spare-part lines)`, reasonCode: "PO_CREATED_FROM_REQUISITIONS" });
  revalidatePath("/purchasing");
  revalidatePath("/warehouses");
  revalidatePath("/maintenance");
}
