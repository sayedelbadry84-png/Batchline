import { prisma } from "@/lib/prisma";

const DEFAULT_NET_DAYS = 30;

// Customer.paymentTerms is a free-text field like "Net 30" — pull the
// number out of it for a due-date calculation, falling back to a sane
// default rather than failing when a term doesn't parse ("Due on receipt",
// "COD", or something a user typed by hand).
export function parseNetDays(paymentTerms: string): number {
  const match = paymentTerms.match(/\d+/);
  return match ? Number(match[0]) : DEFAULT_NET_DAYS;
}

// The one true "what's still owed on this invoice" calculation — total
// minus payments minus credit notes, floored at 0. A CreditNote reduces
// what's owed exactly like a Payment does, but no cash actually moved (see
// the model comment), so every site that used to compute
// `total - payments.reduce(...)` should call this instead once its query
// also selects `creditNotes: { select: { amount: true } }` alongside
// `payments`.
export function invoiceAmountDue(invoice: { total: number; payments: { amount: number }[]; creditNotes: { amount: number }[] }): number {
  const paid = invoice.payments.reduce((s, p) => s + p.amount, 0);
  const credited = invoice.creditNotes.reduce((s, c) => s + c.amount, 0);
  return Math.max(0, invoice.total - paid - credited);
}

// What the customer actually owes right now — every non-cancelled,
// non-draft invoice's amount due (payments AND credit notes already
// applied), summed. DRAFT is excluded because it hasn't been sent yet (not
// a real receivable yet); CANCELLED never was one. This replaces the
// Phase 1 stub credit check (creditLimit <= 0) with the real thing it
// always meant to become (see createReservation's own comment) — same
// shape as the "Sales Agreement balance" that gates bookings in the
// Dynamics data this was compared against.
export async function getCustomerOutstandingBalance(customerId: string): Promise<number> {
  const invoices = await prisma.invoice.findMany({
    where: { customerId, status: { notIn: ["DRAFT", "CANCELLED"] } },
    select: { total: true, payments: { select: { amount: true } }, creditNotes: { select: { amount: true } } },
  });
  return invoices.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);
}
