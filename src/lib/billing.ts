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

// What the customer actually owes right now — every non-cancelled,
// non-draft invoice's total minus whatever's been paid against it, summed.
// DRAFT is excluded because it hasn't been sent yet (not a real receivable
// yet); CANCELLED never was one. This replaces the Phase 1 stub credit
// check (creditLimit <= 0) with the real thing it always meant to become
// (see createReservation's own comment) — same shape as the "Sales
// Agreement balance" that gates bookings in the Dynamics data this was
// compared against.
export async function getCustomerOutstandingBalance(customerId: string): Promise<number> {
  const invoices = await prisma.invoice.findMany({
    where: { customerId, status: { notIn: ["DRAFT", "CANCELLED"] } },
    select: { total: true, payments: { select: { amount: true } } },
  });
  return invoices.reduce((sum, inv) => {
    const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
    return sum + Math.max(0, inv.total - paid);
  }, 0);
}
