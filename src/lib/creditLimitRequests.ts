import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput, toMinorUnits } from "@/lib/money";
import { canPerformAction } from "@/lib/permissions";

// Raising a customer's credit limit, as a request and a decision.
//
// Customer.creditLimit decides whether reservations are held and whether
// tickets release (creditPolicy.ts), so changing it is a financial
// authorization. It used to be a field on the ordinary customer form,
// writable by every role with customers.updateCustomer, PLANT_OPERATOR
// included, and audited after the write had already committed. Now:
//
// - the customer forms never write it (a new customer starts at 0);
// - anyone with customers.requestCreditLimitIncrease may PROPOSE a higher
//   limit, with a reason. A proposal changes nothing: creditPolicy.ts
//   reads Customer.creditLimit only;
// - only a different person, holding customers.approveCreditLimitIncrease
//   at the moment of the decision AND company-wide scope, may approve it.
//   Approval writes the limit, the decision and the audit row in one
//   transaction, under the Customer row lock.
//
// Customer is company-wide (no siteId), so its limit is company-wide
// authority. A plant-pinned account may be granted the request action,
// because a request authorizes nothing, but never the decision, whatever
// the permissions screen says: a site-scoped user deciding a company-wide
// limit is exactly the inference this refuses to make.
//
// Lowering a limit is not part of this flow (it only ever restricts), and
// no path in the application lowers it today.

export type CreditLimitActor = { id: string; role: string; allowedSiteId: string | null };

const MIN_REASON_LENGTH = 10;

class Abort<R> extends Error {
  constructor(public result: R) {
    super("credit limit request refused");
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// ---- Request ------------------------------------------------------------

export type RequestCreditLimitResult =
  | { status: "OK"; requestId: string }
  | { status: "FORBIDDEN" }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_AMOUNT" }
  | { status: "NOT_AN_INCREASE" }
  | { status: "REASON_REQUIRED" }
  | { status: "ALREADY_PENDING" };

export async function requestCreditLimitIncrease(
  customerId: string,
  input: { proposedLimit: FormDataEntryValue | null; reason: string },
  actor: CreditLimitActor,
): Promise<RequestCreditLimitResult> {
  if (!(await canPerformAction(actor.role, "customers", "requestCreditLimitIncrease"))) return { status: "FORBIDDEN" };

  // Validated from the submitted text, like every money input, then held
  // as exact minor units from here on.
  const proposed = parseMoneyInput(input.proposedLimit);
  if (proposed === null) return { status: "INVALID_AMOUNT" };
  const proposedMinor = toMinorUnits(proposed);
  if (!Number.isSafeInteger(proposedMinor)) return { status: "INVALID_AMOUNT" };
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) return { status: "REASON_REQUIRED" };

  try {
    const requestId = await prisma.$transaction(async (tx) => {
      // Lock order, shared with the decision below: Customer row first,
      // then request rows.
      const locked = await tx.$queryRaw<{ creditLimit: number }[]>`SELECT "creditLimit" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
      if (locked.length === 0) throw new Abort<RequestCreditLimitResult>({ status: "NOT_FOUND" });
      const currentMinor = toMinorUnits(locked[0].creditLimit);
      if (proposedMinor <= currentMinor) throw new Abort<RequestCreditLimitResult>({ status: "NOT_AN_INCREASE" });

      const pending = await tx.customerCreditLimitRequest.count({ where: { customerId, status: "PENDING" } });
      if (pending > 0) throw new Abort<RequestCreditLimitResult>({ status: "ALREADY_PENDING" });

      const request = await tx.customerCreditLimitRequest.create({
        data: {
          customerId,
          previousLimitMinor: BigInt(currentMinor),
          proposedLimitMinor: BigInt(proposedMinor),
          reason,
          requestedById: actor.id,
        },
      });
      await writeAudit(tx, { id: actor.id, role: actor.role }, {
        module: "Customers",
        recordId: customerId,
        field: "creditLimit",
        beforeValue: (currentMinor / 100).toFixed(2),
        afterValue: `${(proposedMinor / 100).toFixed(2)} requested (${request.id})`,
        reasonCode: "CREDIT_LIMIT_INCREASE_REQUESTED",
      });
      return request.id;
    });
    return { status: "OK", requestId };
  } catch (e) {
    if (e instanceof Abort) return e.result as RequestCreditLimitResult;
    // The partial unique index is the backstop for two requests racing
    // past the count above.
    if (isUniqueViolation(e)) return { status: "ALREADY_PENDING" };
    throw e;
  }
}

// ---- Decision -----------------------------------------------------------

export type DecideCreditLimitResult =
  | { status: "APPROVED" }
  | { status: "REJECTED" }
  | { status: "FORBIDDEN" }
  | { status: "NOT_FOUND" }
  | { status: "NOT_PENDING" }
  | { status: "SELF_DECISION" }
  | { status: "NOTE_REQUIRED" }
  | { status: "STALE" };

export async function decideCreditLimitRequest(
  requestId: string,
  decision: "APPROVE" | "REJECT",
  note: string,
  actor: CreditLimitActor,
): Promise<DecideCreditLimitResult> {
  // Permission as it stands NOW, not when the request was made or the page
  // was rendered: revoking the permission stops a pending approval.
  const actionKey = decision === "APPROVE" ? "approveCreditLimitIncrease" : "rejectCreditLimitIncrease";
  if (!(await canPerformAction(actor.role, "customers", actionKey))) return { status: "FORBIDDEN" };
  if (actor.allowedSiteId !== null) return { status: "FORBIDDEN" };
  const decisionNote = note.trim() || null;
  if (decision === "REJECT" && !decisionNote) return { status: "NOTE_REQUIRED" };

  // Which customer to lock. The request's customerId never changes, so
  // this unlocked read only chooses the lock; everything decided below is
  // re-read after it.
  const target = await prisma.customerCreditLimitRequest.findUnique({ where: { id: requestId }, select: { customerId: true } });
  if (!target) return { status: "NOT_FOUND" };

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ creditLimit: number }[]>`SELECT "creditLimit" FROM "Customer" WHERE "id" = ${target.customerId} FOR UPDATE`;
      if (locked.length === 0) throw new Abort<DecideCreditLimitResult>({ status: "NOT_FOUND" });
      await tx.$queryRaw`SELECT "id" FROM "CustomerCreditLimitRequest" WHERE "id" = ${requestId} FOR UPDATE`;
      const request = await tx.customerCreditLimitRequest.findUniqueOrThrow({ where: { id: requestId } });

      // A replay, or the loser of two concurrent decisions, finds the
      // request already decided.
      if (request.status !== "PENDING") throw new Abort<DecideCreditLimitResult>({ status: "NOT_PENDING" });
      if (request.requestedById === actor.id) throw new Abort<DecideCreditLimitResult>({ status: "SELF_DECISION" });

      const auditActor = { id: actor.id, role: actor.role };
      const now = new Date();
      if (decision === "REJECT") {
        await tx.customerCreditLimitRequest.update({
          where: { id: requestId },
          data: { status: "REJECTED", decidedById: actor.id, decidedAt: now, decisionNote },
        });
        await writeAudit(tx, auditActor, {
          module: "Customers",
          recordId: request.customerId,
          field: "creditLimit",
          afterValue: `request ${requestId} by ${request.requestedById} rejected: ${decisionNote}`,
          reasonCode: "CREDIT_LIMIT_INCREASE_REJECTED",
        });
        return { status: "REJECTED" } as const;
      }

      // The limit the request was made against must still be the limit.
      // Otherwise the approver would be deciding a change from a baseline
      // they are not looking at; the request is closed as STALE and a
      // fresh one is needed.
      const currentMinor = BigInt(toMinorUnits(locked[0].creditLimit));
      if (currentMinor !== request.previousLimitMinor) {
        await tx.customerCreditLimitRequest.update({ where: { id: requestId }, data: { status: "STALE" } });
        await writeAudit(tx, auditActor, {
          module: "Customers",
          recordId: request.customerId,
          field: "creditLimit",
          afterValue: `request ${requestId} stale: made against ${request.previousLimitMinor} minor, limit is now ${currentMinor}`,
          reasonCode: "CREDIT_LIMIT_INCREASE_STALE",
        });
        return { status: "STALE" } as const;
      }

      const newLimit = Number(request.proposedLimitMinor) / 100;
      await tx.customer.update({ where: { id: request.customerId }, data: { creditLimit: newLimit } });
      await tx.customerCreditLimitRequest.update({
        where: { id: requestId },
        data: { status: "APPROVED", decidedById: actor.id, decidedAt: now, decisionNote },
      });
      await writeAudit(tx, auditActor, {
        module: "Customers",
        recordId: request.customerId,
        field: "creditLimit",
        beforeValue: (Number(request.previousLimitMinor) / 100).toFixed(2),
        afterValue: `${newLimit.toFixed(2)} (request ${requestId}, requested by ${request.requestedById}, approved by ${actor.id})`,
        reasonCode: "CREDIT_LIMIT_INCREASE_APPROVED",
      });
      return { status: "APPROVED" } as const;
    });
    return outcome;
  } catch (e) {
    if (e instanceof Abort) return e.result as DecideCreditLimitResult;
    throw e;
  }
}
