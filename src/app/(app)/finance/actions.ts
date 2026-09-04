"use server";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { postSupplierBill, postSupplierPayment, postCashTransaction, reverseJournalEntry } from "@/lib/ledger";
import { parseBankStatementCsv, matchBankStatementLines, type ReconciliationCandidate } from "@/lib/bankReconciliation";
import { revalidatePath } from "next/cache";

// See the same note on billing/actions.ts's own TX_OPTIONS — several
// sequential round trips to Neon inside one interactive transaction can
// exceed Prisma's 5s default timeout, especially on a cold connection.
const TX_OPTIONS = { timeout: 15000 };

export async function createSupplierBill(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "createSupplierBill");

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

  // The bill and its journal entry commit as one unit — see the same
  // rationale on generateInvoiceForProject in billing/actions.ts.
  const bill = await prisma.$transaction(async (tx) => {
    const bill = await withSequentialNumber(
      "BILL",
      (yr) => tx.supplierBill.count({ where: { createdAt: yr } }),
      (billNumber) =>
        tx.supplierBill.create({
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
    await postSupplierBill(tx, { siteId, currency, billId: bill.id, total });
    return bill;
  }, TX_OPTIONS);

  await logAudit({ module: "Finance", recordId: bill.id, afterValue: `${bill.billNumber} — ${total} ${currency}`, reasonCode: "SUPPLIER_BILL_CREATED" });
  revalidatePath("/finance");
}

// Recomputes the bill's own status from the sum of its payments — same
// "derive the parent's status from its children" shape used throughout
// this app (PurchaseOrder from its lines, Reservation from its tickets).
async function recomputeBillStatus(db: Prisma.TransactionClient, supplierBillId: string) {
  const bill = await db.supplierBill.findUnique({ where: { id: supplierBillId }, include: { payments: true } });
  if (!bill) return;
  const paid = bill.payments.reduce((sum, p) => sum + p.amount, 0);
  const status = paid <= 0 ? "UNPAID" : paid >= bill.total ? "PAID" : "PARTIALLY_PAID";
  if (status !== bill.status) await db.supplierBill.update({ where: { id: supplierBillId }, data: { status } });
}

export async function recordSupplierPayment(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "recordSupplierPayment");

  const supplierBillId = String(formData.get("supplierBillId") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  if (!supplierBillId || !amount || amount <= 0) return;

  const bill = await prisma.supplierBill.findUnique({ where: { id: supplierBillId } });
  if (!bill || bill.status === "CANCELLED") return;

  // The payment and its journal entry commit as one unit — see the same
  // rationale on generateInvoiceForProject in billing/actions.ts.
  const payment = await prisma.$transaction(async (tx) => {
    const payment = await tx.supplierPayment.create({ data: { supplierBillId, amount, method, reference } });
    await recomputeBillStatus(tx, supplierBillId);
    await postSupplierPayment(tx, { siteId: bill.siteId, currency: bill.currency, paymentId: payment.id, amount });
    return payment;
  }, TX_OPTIONS);

  await logAudit({ module: "Finance", recordId: payment.id, afterValue: `${amount} against ${bill.billNumber}`, reasonCode: "SUPPLIER_PAYMENT_RECORDED" });
  revalidatePath("/finance");
}

export async function cancelSupplierBill(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "cancelSupplierBill");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // Tightened to unpaid-only (was PAID-only before) — same reasoning as
  // cancelInvoice's own guard: cancelling a bill that already has real
  // SupplierPayment money moved against it can't be undone by simply
  // reversing the bill's own entry (the payment's own Dr AP/Cr Cash entry
  // would be left referencing a since-reversed AP balance). A
  // partially-paid bill needs a credit memo from the supplier or a
  // manual correction, not a one-click cancel — out of scope here.
  const bill = await prisma.supplierBill.findUnique({ where: { id }, include: { payments: true } });
  if (!bill || bill.status === "CANCELLED" || bill.status === "PAID" || bill.payments.length > 0) return;

  // The cancellation and its reversing journal entry commit as one unit —
  // see the same rationale on cancelInvoice in billing/actions.ts.
  await prisma.$transaction(async (tx) => {
    await tx.supplierBill.update({ where: { id }, data: { status: "CANCELLED" } });
    // Reverses whatever postSupplierBill posted at creation time (Dr
    // COGS/Materials / Cr AP) — see the same reasoning on cancelInvoice's
    // own reversal call in billing/actions.ts.
    await reverseJournalEntry(tx, "Finance", id, "Supplier bill cancelled");
  }, TX_OPTIONS);

  await logAudit({ module: "Finance", recordId: id, afterValue: "CANCELLED", reasonCode: "SUPPLIER_BILL_CANCELLED" });
  revalidatePath("/finance");
}

export async function createCashTransaction(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "createCashTransaction");

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

  // The transaction and its journal entry commit as one unit — see the
  // same rationale on generateInvoiceForProject in billing/actions.ts.
  const txn = await prisma.$transaction(async (tx) => {
    const txn = await withSequentialNumber(
      "TXN",
      (yr) => tx.cashTransaction.count({ where: { createdAt: yr } }),
      (txnNumber) =>
        tx.cashTransaction.create({
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
    await postCashTransaction(tx, { siteId, currency, txnId: txn.id, direction: direction as "IN" | "OUT", category, amount, description });
    return txn;
  }, TX_OPTIONS);

  await logAudit({ module: "Finance", recordId: txn.id, afterValue: `${direction} ${amount} ${currency} — ${category}`, reasonCode: "CASH_TRANSACTION_RECORDED" });
  revalidatePath("/finance");
}

// One shared reconcile action for all three money-movement kinds — a
// manual "I matched this against the bank statement" flag. See
// importBankStatement below for the other way this gets set: an
// unambiguous auto-match against an imported bank statement CSV.
export async function reconcileMovement(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "reconcileMovement");

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

// Imports a bank statement CSV, records every line (matched or not — an
// unmatched line is itself useful information, see BankStatementLine's
// schema comment), and auto-reconciles whichever lines have exactly one
// unambiguous candidate (see src/lib/bankReconciliation.ts for the
// matching rule). Everything else is left for reconcileMovement's
// existing manual flow.
export async function importBankStatement(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "importBankStatement");

  const siteId = String(formData.get("siteId") ?? "");
  const file = formData.get("file");
  if (!siteId || !isSiteInScope(siteId, effectiveSiteId(actor)) || !(file instanceof File) || file.size === 0) return;

  const text = await file.text();
  const { lines, errors } = parseBankStatementCsv(text);
  if (lines.length === 0) return;

  const [payments, supplierPayments, cashTransactions] = await Promise.all([
    prisma.payment.findMany({ where: { reconciled: false, invoice: { plant: { siteId } } }, select: { id: true, amount: true, paidAt: true } }),
    prisma.supplierPayment.findMany({ where: { reconciled: false, supplierBill: { siteId } }, select: { id: true, amount: true, paidAt: true } }),
    prisma.cashTransaction.findMany({ where: { reconciled: false, siteId }, select: { id: true, amount: true, occurredAt: true, direction: true } }),
  ]);

  const candidates: ReconciliationCandidate[] = [
    ...payments.map((p) => ({ kind: "payment" as const, id: p.id, date: p.paidAt, direction: "IN" as const, amount: p.amount })),
    ...supplierPayments.map((p) => ({ kind: "supplierPayment" as const, id: p.id, date: p.paidAt, direction: "OUT" as const, amount: p.amount })),
    ...cashTransactions.map((t) => ({ kind: "cashTransaction" as const, id: t.id, date: t.occurredAt, direction: t.direction as "IN" | "OUT", amount: t.amount })),
  ];

  const matched = matchBankStatementLines(lines, candidates);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const { line, match } of matched) {
      await tx.bankStatementLine.create({
        data: {
          siteId,
          statementDate: line.date,
          direction: line.amount >= 0 ? "IN" : "OUT",
          amount: Math.abs(line.amount),
          description: line.description,
          reference: line.reference || null,
          importedById: actor!.id,
          ...(match
            ? { matchedKind: match.kind, matchedId: match.id, matchedAt: now }
            : {}),
        },
      });

      if (match) {
        if (match.kind === "payment") await tx.payment.update({ where: { id: match.id }, data: { reconciled: true, reconciledAt: now } });
        else if (match.kind === "supplierPayment") await tx.supplierPayment.update({ where: { id: match.id }, data: { reconciled: true, reconciledAt: now } });
        else await tx.cashTransaction.update({ where: { id: match.id }, data: { reconciled: true, reconciledAt: now } });
      }
    }
  }, TX_OPTIONS);

  const matchedCount = matched.filter((m) => m.match).length;
  await logAudit({
    module: "Finance",
    recordId: siteId,
    afterValue: `Imported ${lines.length} bank statement lines, ${matchedCount} auto-matched, ${lines.length - matchedCount} unmatched, ${errors.length} rows skipped`,
    reasonCode: "BANK_STATEMENT_IMPORTED",
  });
  revalidatePath("/finance");
}
