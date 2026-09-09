import { prisma } from "@/lib/prisma";

const DEFAULT_NET_DAYS = 30;

// Discount terms contain several numbers: "2/10 Net 30" is due in 30
// days, not two. Ambiguous free text must not silently shorten the term.
export function parseNetDays(paymentTerms: string): number {
  const terms = paymentTerms.trim().replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  if (/^(cod|cash on delivery|due on receipt|cash|نقد[ًاا]*|عند الاستلام|الدفع عند الاستلام)$/i.test(terms)) return 0;
  const net = terms.match(/(?:\bnet|صافي)\s*(\d+)/i);
  const numbers = terms.match(/\d+/g) ?? [];
  const days = net ? Number(net[1]) : numbers.length === 1 ? Number(numbers[0]) : DEFAULT_NET_DAYS;
  return Number.isSafeInteger(days) && days >= 0 && days <= 3650 ? days : DEFAULT_NET_DAYS;
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
