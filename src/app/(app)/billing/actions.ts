"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { parseNetDays, invoiceAmountDue } from "@/lib/billing";
import { postInvoice, postPayment, postCreditNote, reverseJournalEntry } from "@/lib/ledger";
import { generateZatcaDocuments } from "@/lib/zatca/generate";
import { submitInvoiceForClearance } from "@/lib/zatca/submit";
import { generateZatcaCreditNoteDocuments, submitCreditNoteForClearance } from "@/lib/zatca/creditNote";
import { effectiveSiteId, isPlantInScope } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Every financial event below posts its source record and journal entry
// inside one interactive transaction (see the ledger.ts Db type note) —
// each is several sequential round trips to Neon (a remote serverless
// Postgres), which can comfortably exceed Prisma's 5s default interactive-
// transaction timeout, especially on a cold connection. 15s gives real
// headroom without masking a genuinely broken/looping query.
const TX_OPTIONS = { timeout: 15000 };

// Invoice.plantId is set at generation time from whichever line produced
// the trips it bills (see generateInvoiceForProject) — an invoice with no
// plant (predates this, or had no in-scope trips) is only ever
// visible/actionable to ADMIN, same as the billing list's own filter.
async function invoiceInScope(invoiceId: string, siteId: string | null): Promise<boolean> {
  if (siteId === null) return true;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { plantId: true } });
  if (!invoice?.plantId) return false;
  return isPlantInScope(invoice.plantId, siteId);
}

// The delivery ticket (a closed Trip) is the billing unit — a split
// reservation dispatched as several trucks bills as several lines. Every
// currently-unbilled closed trip for the project goes into an invoice;
// any trip whose mix has no price on file for this customer is silently
// left out (it stays "ready to invoice" for next time) rather than
// blocking the whole invoice or guessing a price.
//
// A project itself carries no plant (see the Project model comment) — its
// trips can come from more than one line, so they're grouped by
// trip.batchTicket.plantId and ONE INVOICE IS GENERATED PER PLANT. This is
// deliberate and money-sensitive: never blend two lines' tax rates or
// currencies onto a single invoice just because they billed the same
// project (mirrors how incentive payouts are priced per-plant before any
// merging happens — see reports/page.tsx).
export async function generateInvoiceForProject(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "generateInvoice");

  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;

  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { customer: true } });
  if (!project) return;

  const uninvoicedTrips = await prisma.trip.findMany({
    where: { status: "CLOSED", invoiceLine: null, batchTicket: { reservation: { projectId } } },
    include: { batchTicket: { include: { plant: true, reservation: { include: { mix: true } } } } },
  });
  if (uninvoicedTrips.length === 0) return;

  const siteId = effectiveSiteId(user);
  const tripsByPlant = new Map<string, typeof uninvoicedTrips>();
  for (const trip of uninvoicedTrips) {
    const plantId = trip.batchTicket.plantId;
    if (!(await isPlantInScope(plantId, siteId))) continue;
    const group = tripsByPlant.get(plantId);
    if (group) group.push(trip);
    else tripsByPlant.set(plantId, [trip]);
  }

  const priceEntries = await prisma.priceListEntry.findMany({ where: { customerId: project.customerId } });
  const priceByMix = new Map(priceEntries.map((p) => [p.mixId, p.pricePerM3]));

  let firstInvoiceId: string | null = null;

  for (const trips of tripsByPlant.values()) {
    const plant = trips[0].batchTicket.plant;
    const lines = trips
      .map((trip) => {
        const mix = trip.batchTicket.reservation.mix;
        const unitPrice = priceByMix.get(mix.id);
        if (unitPrice == null) return null;
        const volumeM3 = trip.volumeDeliveredM3 ?? trip.batchTicket.volumeM3;
        return {
          tripId: trip.id,
          description: `${trip.batchTicket.ticketNumber} — ${mix.code}`,
          volumeM3,
          unitPrice,
          lineTotal: volumeM3 * unitPrice,
        };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);

    if (lines.length === 0) continue;

    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    // Snapshotted from the plant's current rate/label rather than referenced
    // live — a later change to Plant.taxRatePct must never rewrite the
    // numbers on an invoice that already went out.
    const taxRatePct = plant.taxRatePct;
    const taxLabel = plant.taxLabel;
    const taxAmount = subtotal * (taxRatePct / 100);
    const total = subtotal + taxAmount;
    const dueDate = new Date(Date.now() + parseNetDays(project.customer.paymentTerms) * 24 * 60 * 60 * 1000);

    // Invoice creation and its journal entry commit as one unit — without
    // this, a crash or a throw from postInvoice between the two calls
    // would leave a real invoice on file with no matching journal entry,
    // silently understating AR and Revenue on the Trial Balance forever
    // with nothing to detect or reconcile the gap.
    const invoice = await prisma.$transaction(async (tx) => {
      const invoiceCount = await tx.invoice.count();
      const invoiceNumber = `INV-${new Date().getFullYear()}-${String(invoiceCount + 1).padStart(4, "0")}`;

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          customerId: project.customerId,
          projectId,
          plantId: plant.id,
          dueDate,
          subtotal,
          taxRatePct,
          taxLabel,
          taxAmount,
          total,
          currency: plant.currency,
          lines: { create: lines },
        },
      });

      await postInvoice(tx, { siteId: plant.siteId, currency: plant.currency, invoiceId: invoice.id, subtotal, taxAmount, total });
      return invoice;
    }, TX_OPTIONS);

    await logAudit({
      module: "Billing",
      recordId: invoice.id,
      afterValue: `${invoice.invoiceNumber} — ${subtotal} + ${taxLabel} ${taxAmount} = ${total} ${plant.currency}`,
      reasonCode: "INVOICE_GENERATED",
    });

    firstInvoiceId ??= invoice.id;
  }

  if (!firstInvoiceId) return;

  revalidatePath("/finance");
  redirect(`/finance/invoices/${firstInvoiceId}`);
}

export async function markInvoiceSent(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "markInvoiceSent");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice || invoice.status !== "DRAFT") return;
  if (!(await invoiceInScope(id, effectiveSiteId(user)))) return;

  await prisma.invoice.update({ where: { id }, data: { status: "SENT" } });
  await logAudit({ module: "Billing", recordId: id, field: "status", afterValue: "SENT", reasonCode: "INVOICE_SENT" });

  revalidatePath(`/finance/invoices/${id}`);
  revalidatePath("/finance");
}

// Voids an invoice rather than deleting it — the header (number, total,
// dates, CANCELLED status) stays on file as the audit record of what was
// generated and why it didn't stand. Its line items are removed so the
// trips they billed become "ready to invoice" again (a trip can only carry
// one InvoiceLine — that's how "already billed" is detected), rather than
// staying stuck against a voided invoice forever. Refused once a payment
// exists: that money is real and cancelling would orphan it — reconciling
// that is a manual step outside this pass's scope.
export async function cancelInvoice(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "cancelInvoice");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { payments: true, creditNotes: true } });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "PAID" || invoice.payments.length > 0 || invoice.creditNotes.length > 0) return;
  if (!(await invoiceInScope(id, effectiveSiteId(user)))) return;

  // The cancellation and its reversing journal entry commit as one unit —
  // see the same rationale on generateInvoiceForProject above. Without it,
  // a crash between the two would leave an invoice marked CANCELLED whose
  // original Dr AR / Cr Revenue entry was never reversed, permanently
  // overstating AR and Revenue on the Trial Balance with nothing left to
  // correct it.
  await prisma.$transaction(async (tx) => {
    await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.update({ where: { id }, data: { status: "CANCELLED" } });
    await reverseJournalEntry(tx, "Billing", id, "Invoice cancelled");
  }, TX_OPTIONS);

  await logAudit({
    module: "Billing",
    recordId: id,
    field: "status",
    beforeValue: invoice.status,
    afterValue: "CANCELLED",
    reasonCode: "INVOICE_CANCELLED",
  });

  revalidatePath(`/finance/invoices/${id}`);
  revalidatePath("/finance");
}

export async function recordPayment(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "recordPayment");

  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const method = String(formData.get("method") ?? "") || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  if (!invoiceId || !amount || amount <= 0) return;

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { plant: true } });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "PAID") return;
  if (!(await invoiceInScope(invoiceId, effectiveSiteId(user)))) return;

  // The payment and its journal entry commit as one unit — same rationale
  // as generateInvoiceForProject above. amountDue is also now (re)computed
  // INSIDE the transaction (not from the snapshot fetched above) and the
  // whole thing runs Serializable — two payments recorded concurrently
  // against the same invoice used to each compute totalPaid from a
  // payments list that didn't include the other's just-created row, so an
  // invoice that was actually fully paid by the combination could sit
  // stuck at SENT forever. Serializable makes Postgres detect that
  // read-write conflict and abort one of the two competing transactions
  // instead.
  //
  // The amount itself was never checked against what's actually still
  // owed — issueCreditNote already refuses to credit more than amountDue,
  // but recordPayment had no equivalent, so a typo'd extra digit (or a
  // second payment recorded against an invoice someone forgot was already
  // settled) could push it well past PAID with nothing to catch it and no
  // refund/credit-balance workflow to make sense of the overage.
  try {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true, creditNotes: true } });
      if (!fresh) throw new Error("NOT_FOUND");
      const amountDue = invoiceAmountDue(fresh);
      if (amount > amountDue + 0.01) throw new Error("EXCEEDS_AMOUNT_DUE");

      const payment = await tx.payment.create({ data: { invoiceId, amount, method, reference } });

      if (amountDue - amount <= 0.01) {
        await tx.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } });
      }

      // No journal entry when plantId is unset — same nullable-plantId edge
      // case invoiceInScope already treats specially (an invoice that
      // predates plant-scoping, or had no in-scope trips at generation time).
      if (invoice.plant) await postPayment(tx, { siteId: invoice.plant.siteId, currency: invoice.currency, paymentId: payment.id, amount });
    }, { ...TX_OPTIONS, isolationLevel: "Serializable" });
  } catch {
    return;
  }

  await logAudit({
    module: "Billing",
    recordId: invoiceId,
    afterValue: `${amount} ${invoice.currency}`,
    reasonCode: "PAYMENT_RECORDED",
  });

  revalidatePath(`/finance/invoices/${invoiceId}`);
  revalidatePath("/finance");
}

// A discount/credit against a specific invoice — returns, price disputes,
// goodwill, corrections. Reduces what's still owed exactly like
// recordPayment does (same PAID-flip-once-covered logic), capped at
// whatever's still actually due so a credit note can never push an
// invoice into owing the customer money — that would be a refund, not a
// credit note, and this app has no such flow.
export async function issueCreditNote(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "issueCreditNote");

  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const reason = String(formData.get("reason") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!invoiceId || !amount || amount <= 0 || !reason) return;

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { plant: true } });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "PAID") return;
  if (!(await invoiceInScope(invoiceId, effectiveSiteId(user)))) return;

  // amountDue is now (re)computed INSIDE the transaction, from a fresh read,
  // not the snapshot fetched above — and the whole thing runs Serializable.
  // Two credit notes issued concurrently against the same invoice used to
  // each check `amount > amountDue` against the same stale amountDue, so
  // both could pass even though together they credit more than was ever
  // due. Serializable makes Postgres detect that read-write conflict and
  // abort one of the two competing transactions instead.
  let creditNote;
  try {
    creditNote = await prisma.$transaction(async (tx) => {
      const fresh = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true, creditNotes: true } });
      if (!fresh) throw new Error("NOT_FOUND");
      const amountDue = invoiceAmountDue(fresh);
      if (amount > amountDue + 0.01) throw new Error("EXCEEDS_AMOUNT_DUE");

      const cn = await withSequentialNumber(
        "CN",
        (yr) => tx.creditNote.count({ where: { createdAt: yr } }),
        (creditNoteNumber) =>
          tx.creditNote.create({
            data: { creditNoteNumber, invoiceId, amount, reason, notes, issuedById: user!.id },
          }),
      );

      if (amountDue - amount <= 0.01) {
        await tx.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } });
      }

      if (invoice.plant) await postCreditNote(tx, { siteId: invoice.plant.siteId, currency: invoice.currency, creditNoteId: cn.id, amount });
      return cn;
    }, { ...TX_OPTIONS, isolationLevel: "Serializable" });
  } catch {
    return;
  }

  await logAudit({
    module: "Billing",
    recordId: invoiceId,
    afterValue: `${creditNote.creditNoteNumber} — ${amount} ${invoice.currency} (${reason})`,
    reasonCode: "CREDIT_NOTE_ISSUED",
  });

  revalidatePath(`/finance/invoices/${invoiceId}`);
  revalidatePath("/finance");
}

// ZATCA (Saudi e-invoicing) — see src/lib/zatca/ for the actual document
// generation/submission logic these two thin wrappers call. Both refuse
// quietly (return without erroring) the same way every other guard in
// this file does when the invoice isn't in scope or the underlying
// function reports it can't proceed — the invoice detail page reads
// invoice.zatcaStatus/zatcaErrorMessage afterward to show what happened.
export async function generateZatcaInvoiceDocuments(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "generateZatcaDocuments");

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  if (!(await invoiceInScope(id, effectiveSiteId(user)))) return;

  const result = await generateZatcaDocuments(id);
  if (result.ok) {
    await logAudit({ module: "Billing", recordId: id, afterValue: "ZATCA QR/XML generated", reasonCode: "ZATCA_GENERATED" });
  }
  revalidatePath(`/finance/invoices/${id}`);
}

export async function submitZatcaInvoiceForClearance(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "submitZatcaClearance");

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  if (!(await invoiceInScope(id, effectiveSiteId(user)))) return;

  const result = await submitInvoiceForClearance(id);
  await logAudit({
    module: "Billing",
    recordId: id,
    afterValue: result.ok ? "ZATCA clearance accepted" : `ZATCA clearance failed: ${result.reason}`,
    reasonCode: result.ok ? "ZATCA_CLEARED" : "ZATCA_CLEARANCE_FAILED",
  });
  revalidatePath(`/finance/invoices/${id}`);
}

// Same two thin wrappers, for the credit note's own ZATCA lifecycle (see
// src/lib/zatca/creditNote.ts) — a credit note is scoped through the
// invoice it amends, same as issueCreditNote itself above.
async function creditNoteInvoiceId(creditNoteId: string): Promise<string | null> {
  const creditNote = await prisma.creditNote.findUnique({ where: { id: creditNoteId }, select: { invoiceId: true } });
  return creditNote?.invoiceId ?? null;
}

export async function generateZatcaCreditNoteDocumentsAction(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "generateZatcaCreditNoteDocuments");

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const invoiceId = await creditNoteInvoiceId(id);
  if (!invoiceId || !(await invoiceInScope(invoiceId, effectiveSiteId(user)))) return;

  const result = await generateZatcaCreditNoteDocuments(id);
  if (result.ok) {
    await logAudit({ module: "Billing", recordId: id, afterValue: "ZATCA credit note QR/XML generated", reasonCode: "ZATCA_CREDIT_NOTE_GENERATED" });
  }
  revalidatePath(`/finance/invoices/${invoiceId}`);
}

export async function submitZatcaCreditNoteForClearanceAction(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "finance", "submitZatcaCreditNoteClearance");

  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const invoiceId = await creditNoteInvoiceId(id);
  if (!invoiceId || !(await invoiceInScope(invoiceId, effectiveSiteId(user)))) return;

  const result = await submitCreditNoteForClearance(id);
  await logAudit({
    module: "Billing",
    recordId: id,
    afterValue: result.ok ? "ZATCA credit note clearance accepted" : `ZATCA credit note clearance failed: ${result.reason}`,
    reasonCode: result.ok ? "ZATCA_CREDIT_NOTE_CLEARED" : "ZATCA_CREDIT_NOTE_CLEARANCE_FAILED",
  });
  revalidatePath(`/finance/invoices/${invoiceId}`);
}
