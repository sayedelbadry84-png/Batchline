"use server";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolvePlantBillingDefaults } from "@/lib/plantBilling";
import { writeAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { postSupplierBill, postSupplierPayment, postCashTransaction, reverseJournalEntry } from "@/lib/ledger";
import { parseBankStatementCsv, matchBankStatementLines, type ReconciliationCandidate } from "@/lib/bankReconciliation";
import { parseMoneyInput, toMinorUnits } from "@/lib/money";
import { revalidatePath } from "next/cache";

// See the same note on billing/actions.ts's own TX_OPTIONS — several
// sequential round trips to Neon inside one interactive transaction can
// exceed Prisma's 5s default timeout, especially on a cold connection.
const TX_OPTIONS = { timeout: 15000 };


// PR4-R3-P1-01: thrown inside the bill transaction when the purchase
// order named on the form is not this site's and this supplier's, so the
// bill and its journal entry unwind with it. Turned back into the silent
// refusal every other action here uses — an answer that distinguished
// "not yours" from "does not exist" would confirm the order exists.
class BillSourceRefused extends Error {}

async function silentOnRefusal<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof BillSourceRefused) return null;
    throw e;
  }
}

export async function createSupplierBill(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "createSupplierBill");

  const supplierId = String(formData.get("supplierId") ?? "");
  const purchaseOrderId = String(formData.get("purchaseOrderId") ?? "") || null;
  const siteId = String(formData.get("siteId") ?? "");
  const dueDateRaw = String(formData.get("dueDate") ?? "");
  // PR4-R3-P1-02: the payment path already refused amounts that cannot
  // exist in the currency, but the SOURCE document did not — it took
  // `Number(...)` straight from the form. That admitted a negative
  // subtotal (which reverses the journal's economic direction), and
  // values like 100.004: a bill totalling 100.004 can never be settled,
  // because paying 100.00 leaves 0.004 outstanding while the smallest
  // payable amount, 0.01, exceeds it. The bill is where the number enters
  // the ledger, so it is where the policy has to hold.
  const subtotal = parseMoneyInput(formData.get("subtotal"));
  const taxAmount = formData.get("taxAmount") === null || String(formData.get("taxAmount")).trim() === "" ? 0 : parseMoneyInput(formData.get("taxAmount"));
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!supplierId || !siteId || !dueDateRaw) return;
  if (subtotal === null || subtotal <= 0) return;
  if (taxAmount === null || taxAmount < 0) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const { currency } = await resolvePlantBillingDefaults(siteId);
  // PR4-R5-P1-01: the sum is computed in MINOR UNITS and the stored amount
  // derived back from it. Validating `subtotal + taxAmount` and then
  // persisting that raw float was not enough — the check looked at the
  // rounded value while the unrounded one went to the database. Ordinary
  // input is all it takes: 0.10 + 0.20 is 0.30000000000000004 in binary
  // floating point, so a later, perfectly valid payment of 0.30 left the
  // bill PARTIALLY_PAID forever, with a remainder too small to pay off.
  // Exactly the unpayable-remainder class the text parser was added to
  // remove, reintroduced by arithmetic instead of by input.
  const totalMinor = toMinorUnits(subtotal) + toMinorUnits(taxAmount);
  if (!Number.isSafeInteger(totalMinor)) return;
  const total = totalMinor / 100;

  // PR4-R3-P1-01: purchaseOrderId arrived from the form and was written
  // onto the bill without ever being loaded — the same cross-site bridge
  // class already fixed in createQuote, here in Finance. A Site A
  // accountant could submit their own permitted siteId together with a
  // known Site B purchase order (or another supplier's), and the schema
  // has no invariant tying SupplierBill.siteId to PurchaseOrder.siteId.
  // The order is now claimed inside the transaction by id + site +
  // supplier, so the three cannot name different owners.
  //
  // PR4-R3-P1-03: the audit row moved inside the transaction. It used to
  // run after the commit, so a failed audit insert left a numbered bill
  // and its journal entry committed while the caller saw a failure — and
  // an operator retry created a SECOND numbered document and posted the
  // ledger again.
  //
  // The transaction now sits INSIDE withSequentialNumber rather than the
  // other way round. That ordering matters: a P2002 on billNumber aborts
  // the whole transaction, so the old shape retried its next candidate
  // inside a transaction Postgres had already poisoned.
  const bill = await silentOnRefusal(() =>
    withSequentialNumber(
      "BILL",
      (yr) => prisma.supplierBill.count({ where: { createdAt: yr } }),
      (billNumber) =>
        prisma.$transaction(async (tx) => {
          if (purchaseOrderId) {
            const order = await tx.purchaseOrder.findFirst({
              where: { id: purchaseOrderId, siteId, supplierId },
              select: { id: true },
            });
            if (!order) throw new BillSourceRefused();
          }
          const created = await tx.supplierBill.create({
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
          });
          await postSupplierBill(tx, { siteId, currency, billId: created.id, total });
          await writeAudit(tx, { id: actor!.id, role: actor!.role }, {
            module: "Finance",
            recordId: created.id,
            afterValue: `${created.billNumber} — ${total} ${currency}`,
            reasonCode: "SUPPLIER_BILL_CREATED",
          });
          return created;
        }, TX_OPTIONS),
    ),
  );
  if (!bill) return;

  revalidatePath("/finance");
}

// Recomputes the bill's own status from the sum of its payments — same
// "derive the parent's status from its children" shape used throughout
// this app (PurchaseOrder from its lines, Reservation from its tickets).
async function recomputeBillStatus(db: Prisma.TransactionClient, supplierBillId: string) {
  const bill = await db.supplierBill.findUnique({ where: { id: supplierBillId }, include: { payments: true } });
  if (!bill) return;
  // PR4-R5-P1-01: summed and compared in whole minor units. `paid >=
  // bill.total` on floats is where an exactly settled bill stayed
  // PARTIALLY_PAID, and repeated partial payments each contributed their
  // own representation error to the running sum.
  const paidMinor = bill.payments.reduce((sum, p) => sum + toMinorUnits(p.amount), 0);
  const totalMinor = toMinorUnits(bill.total);
  const status = paidMinor <= 0 ? "UNPAID" : paidMinor >= totalMinor ? "PAID" : "PARTIALLY_PAID";
  if (status !== bill.status) await db.supplierBill.update({ where: { id: supplierBillId }, data: { status } });
}

export async function recordSupplierPayment(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "recordSupplierPayment");

  const supplierBillId = String(formData.get("supplierBillId") ?? "");
  // PR4-R2-P1-01: parsed and validated as CURRENCY before anything else
  // looks at it. The previous version accepted any finite number and only
  // compared it in rounded minor units, so 100.004 against a 100.00
  // balance passed the check and was then persisted and posted in full.
  const amount = parseMoneyInput(formData.get("amount"));
  const method = String(formData.get("method") ?? "").trim() || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  if (!supplierBillId || amount === null || amount <= 0) return;

  // BL-CR-P1-02 and BL-CR-P1-07, external-review validation (2026-09-10).
  // Three defects, one cause: the bill was read OUTSIDE the transaction
  // that then wrote against it.
  //
  //  1. no site check at all — role permission let an accountant at one
  //     site post cash against another site's supplier bill and its
  //     journals;
  //  2. no comparison against the outstanding balance — a single payment
  //     could exceed what was owed, still flip the bill to PAID, and post
  //     the whole excess to AP/cash;
  //  3. the stale read raced both a concurrent payment (two payments each
  //     sized against the same pre-payment balance overpay together) and
  //     cancelSupplierBill (a payment landing against a bill whose entry
  //     had just been reversed).
  //
  // The row is now locked FOR UPDATE inside the transaction and every
  // decision — scope, status, outstanding balance — is made from that
  // locked read. cancelSupplierBill takes the same lock, so the two
  // genuinely serialize instead of interleaving.
  const allowedSiteId = effectiveSiteId(actor);
  const posted = await prisma.$transaction(async (tx) => {
    // PR4-R1-P1-03: the caller's site is part of the locked SELECT itself,
    // so a crafted request cannot even take the lock on another site's
    // bill — previously it locked the row and only then found out it was
    // not allowed to, which is a denial-of-service handle on a stranger's
    // billing row. `${allowedSiteId}::text IS NULL` is the ADMIN case.
    const locked = await tx.$queryRaw<{ id: string; siteId: string; currency: string; total: number; status: string; billNumber: string }[]>`
      SELECT "id", "siteId", "currency", "total", "status", "billNumber"
      FROM "SupplierBill"
      WHERE "id" = ${supplierBillId}
        AND (${allowedSiteId}::text IS NULL OR "siteId" = ${allowedSiteId})
      FOR UPDATE
    `;
    const bill = locked[0];
    if (!bill) return null;
    if (bill.status === "CANCELLED") return null;

    // Summed inside the same locked transaction, so a concurrent payment
    // is either already counted here or still waiting on our lock.
    const alreadyPaid = (await tx.supplierPayment.aggregate({ where: { supplierBillId }, _sum: { amount: true } }))._sum.amount ?? 0;
    // Integer-exact: no epsilon, so nothing above the balance is accepted
    // and exact settlement is never refused by a float representation.
    if (toMinorUnits(amount) > toMinorUnits(bill.total) - toMinorUnits(alreadyPaid)) return null;

    const payment = await tx.supplierPayment.create({ data: { supplierBillId, amount, method, reference } });
    await recomputeBillStatus(tx, supplierBillId);
    await postSupplierPayment(tx, { siteId: bill.siteId, currency: bill.currency, paymentId: payment.id, amount });
    // PR4-R1-P1-03: writeAudit inside the transaction, not logAudit after
    // it. Post-commit audit left exactly the failure this finding
    // prohibits — a committed payment and journal entry whose audit row
    // failed to insert, reported to the caller as a failure they may then
    // retry. Now the money, the journal and the audit commit together or
    // not at all.
    await writeAudit(tx, { id: actor!.id, role: actor!.role }, {
      module: "Finance",
      recordId: payment.id,
      afterValue: `${amount} against ${bill.billNumber}`,
      reasonCode: "SUPPLIER_PAYMENT_RECORDED",
    });
    return { paymentId: payment.id, billNumber: bill.billNumber };
  }, TX_OPTIONS);
  if (!posted) return;

  revalidatePath("/finance");
}

export async function cancelSupplierBill(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "cancelSupplierBill");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // BL-CR-P1-02 / BL-CR-P1-07: same treatment as recordSupplierPayment
  // above — the bill is locked inside the transaction and every decision
  // (site scope, status, whether any payment exists) is made from that
  // locked state. The old outside-the-transaction read let a payment
  // commit in the gap and leave real money posted against a bill whose
  // own entry was then reversed.
  const allowedSiteId = effectiveSiteId(actor);
  const cancelled = await prisma.$transaction(async (tx) => {
    // PR4-R1-P1-03: site in the locked predicate, same as
    // recordSupplierPayment above.
    const locked = await tx.$queryRaw<{ id: string; siteId: string; status: string }[]>`
      SELECT "id", "siteId", "status" FROM "SupplierBill"
      WHERE "id" = ${id}
        AND (${allowedSiteId}::text IS NULL OR "siteId" = ${allowedSiteId})
      FOR UPDATE
    `;
    const bill = locked[0];
    if (!bill) return false;
    // Tightened to unpaid-only (was PAID-only before) — same reasoning as
    // cancelInvoice's own guard: cancelling a bill that already has real
    // SupplierPayment money moved against it can't be undone by simply
    // reversing the bill's own entry (the payment's own Dr AP/Cr Cash
    // entry would be left referencing a since-reversed AP balance). A
    // partially-paid bill needs a credit memo from the supplier or a
    // manual correction, not a one-click cancel — out of scope here.
    if (bill.status === "CANCELLED" || bill.status === "PAID") return false;
    if ((await tx.supplierPayment.count({ where: { supplierBillId: id } })) > 0) return false;

    await tx.supplierBill.update({ where: { id }, data: { status: "CANCELLED" } });
    // Reverses whatever postSupplierBill posted at creation time (Dr
    // COGS/Materials / Cr AP) — see the same reasoning on cancelInvoice's
    // own reversal call in billing/actions.ts.
    await reverseJournalEntry(tx, "Finance", id, "Supplier bill cancelled");
    // PR4-R1-P1-03: audited inside the same transaction as the reversal.
    await writeAudit(tx, { id: actor!.id, role: actor!.role }, {
      module: "Finance",
      recordId: id,
      afterValue: "CANCELLED",
      reasonCode: "SUPPLIER_BILL_CANCELLED",
    });
    return true;
  }, TX_OPTIONS);
  if (!cancelled) return;

  revalidatePath("/finance");
}

export async function createCashTransaction(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "finance", "createCashTransaction");

  const siteId = String(formData.get("siteId") ?? "");
  const direction = String(formData.get("direction") ?? "");
  const category = String(formData.get("category") ?? "");
  // Same currency validation as recordSupplierPayment (PR4-R2-P1-01):
  // this amount is posted to the cash ledger, so a value that cannot be
  // expressed in halalas must not reach it either.
  const amount = parseMoneyInput(formData.get("amount"));
  const description = String(formData.get("description") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "");

  if (!siteId || !["IN", "OUT"].includes(direction) || !category || amount === null || amount <= 0 || !description) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const { currency } = await resolvePlantBillingDefaults(siteId);

  // The transaction and its journal entry commit as one unit — see the
  // same rationale on generateInvoiceForProject in billing/actions.ts.
  // PR4-R3-P1-03 and the same withSequentialNumber/transaction ordering
  // fix as createSupplierBill above.
  await withSequentialNumber(
    "TXN",
    (yr) => prisma.cashTransaction.count({ where: { createdAt: yr } }),
    (txnNumber) =>
      prisma.$transaction(async (tx) => {
        const txn = await tx.cashTransaction.create({
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
        });
        await postCashTransaction(tx, { siteId, currency, txnId: txn.id, direction: direction as "IN" | "OUT", category, amount, description });
        await writeAudit(tx, { id: actor!.id, role: actor!.role }, {
          module: "Finance",
          recordId: txn.id,
          afterValue: `${direction} ${amount} ${currency} — ${category}`,
          reasonCode: "CASH_TRANSACTION_RECORDED",
        });
        return txn;
      }, TX_OPTIONS),
  );

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

  // BL-CR-P1-02: each of these three is site-owned through a different
  // relation — a customer payment through its invoice's plant, a supplier
  // payment through its bill, a cash transaction through its own column —
  // and none of them was checking any of it. The scope is now part of the
  // conditional write, so marking another site's money as reconciled
  // matches no row.
  if (kind !== "payment" && kind !== "supplierPayment" && kind !== "cashTransaction") return;

  const now = new Date();
  const allowedSiteId = effectiveSiteId(actor);
  const data = { reconciled: true, reconciledAt: now };

  // PR4-R5-P1-02: the flag and its audit row are ONE transaction. The
  // previous version marked the movement reconciled and then opened a
  // SEPARATE transaction for the audit — so a failed audit insert left
  // the money marked reconciled while the caller saw an error. Splitting
  // the commit is the defect; putting the audit in a transaction of its
  // own does not fix it.
  const reconciled = await prisma.$transaction(async (tx) => {
    const marked =
      kind === "payment"
        ? await tx.payment.updateMany({ where: { id, ...(allowedSiteId ? { invoice: { plant: { siteId: allowedSiteId } } } : {}) }, data })
        : kind === "supplierPayment"
          ? await tx.supplierPayment.updateMany({ where: { id, ...(allowedSiteId ? { supplierBill: { siteId: allowedSiteId } } : {}) }, data })
          : await tx.cashTransaction.updateMany({ where: { id, ...(allowedSiteId ? { siteId: allowedSiteId } : {}) }, data });
    if (marked.count !== 1) return false;

    await writeAudit(tx, { id: actor!.id, role: actor!.role }, {
      module: "Finance",
      recordId: id,
      afterValue: `${kind} reconciled`,
      reasonCode: "BANK_RECONCILED",
    });
    return true;
  }, TX_OPTIONS);
  if (!reconciled) return;

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

    // PR4-R5-P1-02: audited inside the same transaction as the import.
    // Post-commit, a failed audit left every statement line and every
    // auto-reconciliation committed while the caller saw an error — and a
    // retry re-imports the same file, because nothing about this import is
    // idempotent. The audit row is the only record of what was already
    // brought in, so it must not be the part that can go missing.
    const matchedCount = matched.filter((m) => m.match).length;
    await writeAudit(tx, { id: actor!.id, role: actor!.role }, {
      module: "Finance",
      recordId: siteId,
      afterValue: `Imported ${lines.length} bank statement lines, ${matchedCount} auto-matched, ${lines.length - matchedCount} unmatched, ${errors.length} rows skipped`,
      reasonCode: "BANK_STATEMENT_IMPORTED",
    });
  }, TX_OPTIONS);

  revalidatePath("/finance");
}
