import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { invoiceAmountDue } from "@/lib/billing";
import { toMinorUnits } from "@/lib/money";

type Db = Prisma.TransactionClient | typeof prisma;

// The ONE credit decision every path that can make a reservation
// releasable, or release against one, goes through. It used to be
// computed at two call sites only (createReservation and
// approveReservationFinal), each with its own copy of the comparison, and
// four other paths produced a CONFIRMED, fully signed-off reservation or a
// ticket without asking at all: the edit form's free status field, quote
// conversion, the walk-in manual booking, and release itself for a
// reservation whose customer went over the limit after it was approved.
//
// The policy is unchanged from what createReservation always applied:
// the customer's outstanding receivables (every non-draft, non-cancelled
// invoice's amount due) against their credit limit, and "at or over the
// limit" holds. A limit of 0 therefore means no credit: every booking for
// that customer holds until a person clears it. Compared in minor units,
// never as floats, so a balance that equals the limit to the halala is
// "at", not "a hair under".
//
// Takes a transaction client so a caller can make the decision from the
// same snapshot as the write it gates. Reading inside the transaction is
// the point: a decision made before it can be stale by the time the
// reservation or ticket is written.
export type CreditDecision = {
  status: "WITHIN_LIMIT" | "OVER_LIMIT";
  outstandingMinor: number;
  limitMinor: number;
};

export function decideCredit(outstanding: number, creditLimit: number): CreditDecision {
  const outstandingMinor = toMinorUnits(outstanding);
  const limitMinor = toMinorUnits(creditLimit);
  return { status: outstandingMinor >= limitMinor ? "OVER_LIMIT" : "WITHIN_LIMIT", outstandingMinor, limitMinor };
}

// null when the customer does not exist, which every caller treats as a
// refusal rather than as "no limit".
export async function evaluateCustomerCredit(db: Db, customerId: string): Promise<CreditDecision | null> {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { creditLimit: true } });
  if (!customer) return null;
  const invoices = await db.invoice.findMany({
    where: { customerId, status: { notIn: ["DRAFT", "CANCELLED"] } },
    select: { total: true, payments: { select: { amount: true } }, creditNotes: { select: { amount: true } } },
  });
  // Summed per invoice in minor units, so float dust across many invoices
  // cannot accumulate into a different decision.
  const outstandingMinor = invoices.reduce((sum, inv) => sum + toMinorUnits(invoiceAmountDue(inv)), 0);
  return decideCredit(outstandingMinor / 100, customer.creditLimit);
}

export async function evaluateProjectCredit(db: Db, projectId: string): Promise<CreditDecision | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { customerId: true } });
  if (!project) return null;
  return evaluateCustomerCredit(db, project.customerId);
}
