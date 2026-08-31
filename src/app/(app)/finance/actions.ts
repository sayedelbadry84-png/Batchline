"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { postSupplierBill, postSupplierPayment, postCashTransaction } from "@/lib/ledger";
import { revalidatePath } from "next/cache";

const FINANCE_ROLES = ["ACCOUNTANT", "ADMIN"];

export async function createSupplierBill(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, FINANCE_ROLES);

  const supplierId = String(formData.get("supplierId") ?? "");
  const purchaseOrderId = String(formData.get("purchaseOrderId") ?? "") || null;
  const siteId = String(formData.get("siteId") ?? "");
  const dueDateRaw = String(formData.get("dueDate") ?? "");
  const subtotal = Number(formData.get("subtotal") ?? 0);
  const taxAmount = Number(formData.get("taxAmount") ?? 0) || 0;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!supplierId || !siteId || !dueDateRaw || !subtotal) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const plantId = await resolvePlantIdForSite(siteId);
  const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId } }) : null;
  const currency = plant?.currency ?? "EGP";
  const total = subtotal + taxAmount;

  const bill = await withSequentialNumber(
    "BILL",
    () => prisma.supplierBill.count(),
    (billNumber) =>
      prisma.supplierBill.create({
        data: {
          billNumber,
          supplierId,
          purchaseOrderId,
          siteId,
          dueDate: new Date(dueDateRaw),
          subtotal,
          taxAmount,
          total,
          currency,
          notes,
        },
      }),
  );

  await logAudit({ module: "Finance", recordId: bill.id, afterValue: `${bill.billNumber} — ${total} ${currency}`, reasonCode: "SUPPLIER_BILL_CREATED" });
  await postSupplierBill({ siteId, currency, billId: bill.id, total });
  revalidatePath("/finance");
}

// Recomputes the bill's own status from the sum of its payments — same
// "derive the parent's status from its children" shape used throughout
// this app (PurchaseOrder from its lines, Reservation from its tickets).
async function recomputeBillStatus(supplierBillId: string) {
  const bill = await prisma.supplierBill.findUnique({ where: { id: supplierBillId }, include: { payments: true } });
  if (!bill) return;
  const paid = bill.payments.reduce((sum, p) => sum + p.amount, 0);
  const status = paid <= 0 ? "UNPAID" : paid >= bill.total ? "PAID" : "PARTIALLY_PAID";
  if (status !== bill.status) await prisma.supplierBill.update({ where: { id: supplierBillId }, data: { status } });
}

export async function recordSupplierPayment(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, FINANCE_ROLES);

  const supplierBillId = String(formData.get("supplierBillId") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  if (!supplierBillId || !amount || amount <= 0) return;

  const bill = await prisma.supplierBill.findUnique({ where: { id: supplierBillId } });
  if (!bill || bill.status === "CANCELLED") return;

  const payment = await prisma.supplierPayment.create({ data: { supplierBillId, amount, method, reference } });
  await recomputeBillStatus(supplierBillId);

  await logAudit({ module: "Finance", recordId: payment.id, afterValue: `${amount} against ${bill.billNumber}`, reasonCode: "SUPPLIER_PAYMENT_RECORDED" });
  await postSupplierPayment({ siteId: bill.siteId, currency: bill.currency, paymentId: payment.id, amount });
  revalidatePath("/finance");
}

export async function cancelSupplierBill(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, FINANCE_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const bill = await prisma.supplierBill.findUnique({ where: { id } });
  if (!bill || bill.status === "PAID") return;

  await prisma.supplierBill.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Finance", recordId: id, afterValue: "CANCELLED", reasonCode: "SUPPLIER_BILL_CANCELLED" });
  revalidatePath("/finance");
}

export async function createCashTransaction(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, FINANCE_ROLES);

  const siteId = String(formData.get("siteId") ?? "");
  const direction = String(formData.get("direction") ?? "");
  const category = String(formData.get("category") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const description = String(formData.get("description") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "");

  if (!siteId || !["IN", "OUT"].includes(direction) || !category || !amount || amount <= 0 || !description) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const plantId = await resolvePlantIdForSite(siteId);
  const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId } }) : null;
  const currency = plant?.currency ?? "EGP";

  const txn = await withSequentialNumber(
    "TXN",
    () => prisma.cashTransaction.count(),
    (txnNumber) =>
      prisma.cashTransaction.create({
        data: {
          txnNumber,
          siteId,
          direction,
          category,
          amount,
          currency,
          description,
          reference,
          occurredAt: occurredAtRaw ? new Date(occurredAtRaw) : new Date(),
          createdById: actor!.id,
        },
      }),
  );

  await logAudit({ module: "Finance", recordId: txn.id, afterValue: `${direction} ${amount} ${currency} — ${category}`, reasonCode: "CASH_TRANSACTION_RECORDED" });
  await postCashTransaction({ siteId, currency, txnId: txn.id, direction: direction as "IN" | "OUT", category, amount, description });
  revalidatePath("/finance");
}

// One shared reconcile action for all three money-movement kinds — a
// manual "I matched this against the bank statement" flag, see the
// Finance schema section comment for why this is hand-matched rather
// than a real bank-feed import.
export async function reconcileMovement(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, FINANCE_ROLES);

  const kind = String(formData.get("kind") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const now = new Date();
  if (kind === "payment") {
    await prisma.payment.update({ where: { id }, data: { reconciled: true, reconciledAt: now } });
  } else if (kind === "supplierPayment") {
    await prisma.supplierPayment.update({ where: { id }, data: { reconciled: true, reconciledAt: now } });
  } else if (kind === "cashTransaction") {
    await prisma.cashTransaction.update({ where: { id }, data: { reconciled: true, reconciledAt: now } });
  } else {
    return;
  }

  await logAudit({ module: "Finance", recordId: id, afterValue: `${kind} reconciled`, reasonCode: "BANK_RECONCILED" });
  revalidatePath("/finance");
}
