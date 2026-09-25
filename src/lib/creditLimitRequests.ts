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
// - only an ADMIN other than the requester may approve or reject it.
//   Approval writes the limit, the decision and the audit row in one
//   transaction, under the Customer row lock.
//
// Who decides is fixed here, not on the Permissions screen. Customer is
// company-wide (no siteId), so its limit is company-wide financial
// authority. An earlier version put approve/reject on the editable
// ACTION_ROLES table AND required effectiveSiteId(actor) === null, which
// only ADMIN ever satisfies: the screen could show an accountant as
// "granted" a decision the server would always refuse. Deriving financial
// authority from a plant-data scope helper was the wrong source anyway.
// Until the owner defines a delegable company-wide credit-approval role,
// the rule is the one the code actually enforced: ADMIN decides,
// ACCOUNTANT (or ADMIN) requests, and the two are different people.
//
// The decider's role and status are read from the User row, under a
// share lock, inside the same transaction that writes the decision. A
// role change or deactivation that commits first is seen; one that
// starts during the decision waits for it to finish. The role the session
// carried in is only a fast early refusal, never the authority.
//
// Lowering a limit is not part of this flow (it only ever restricts), and
// no path in the application lowers it today.

export type CreditLimitActor = { id: string; role: string };

export const CREDIT_LIMIT_DECIDER_ROLE = "ADMIN";

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
  | { status: "ALREADY_PENDING" }
  | { status: "NO_ELIGIBLE_APPROVER" };

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
      // Lock order, shared with the decision below: Customer row, then
      // request rows. (The decision takes a share lock on its own User row
      // before either; this path locks no User row, so the two cannot
      // wait on each other in opposite orders.)
      const locked = await tx.$queryRaw<{ creditLimit: number }[]>`SELECT "creditLimit" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
      if (locked.length === 0) throw new Abort<RequestCreditLimitResult>({ status: "NOT_FOUND" });
      const currentMinor = toMinorUnits(locked[0].creditLimit);
      if (proposedMinor <= currentMinor) throw new Abort<RequestCreditLimitResult>({ status: "NOT_AN_INCREASE" });

      const pending = await tx.customerCreditLimitRequest.count({ where: { customerId, status: "PENDING" } });
      if (pending > 0) throw new Abort<RequestCreditLimitResult>({ status: "ALREADY_PENDING" });

      // A request nobody may decide would sit PENDING forever and block
      // every later one for this customer. Deciders are active ADMINs
      // other than the requester; an ADMIN requesting with no second
      // ADMIN on the system is told so instead.
      const deciders = await tx.user.count({ where: { role: CREDIT_LIMIT_DECIDER_ROLE, status: "ACTIVE", id: { not: actor.id } } });
      if (deciders === 0) throw new Abort<RequestCreditLimitResult>({ status: "NO_ELIGIBLE_APPROVER" });

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
  // Early refusal from the session's role; the authority itself is
  // re-read from the User row inside the transaction below.
  if (actor.role !== CREDIT_LIMIT_DECIDER_ROLE) return { status: "FORBIDDEN" };
  const decisionNote = note.trim() || null;
  if (decision === "REJECT" && !decisionNote) return { status: "NOTE_REQUIRED" };

  // Which customer to lock. The request's customerId never changes, so
  // this unlocked read only chooses the lock; everything decided below is
  // re-read after it.
  const target = await prisma.customerCreditLimitRequest.findUnique({ where: { id: requestId }, select: { customerId: true } });
  if (!target) return { status: "NOT_FOUND" };

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // The decider's authority as it stands at this commit. FOR SHARE
      // conflicts with the UPDATE that changes a role or deactivates an
      // account, so neither can slip in between this check and the
      // decision's commit.
      const decider = await tx.$queryRaw<{ role: string; status: string }[]>`SELECT "role", "status" FROM "User" WHERE "id" = ${actor.id} FOR SHARE`;
      if (decider.length === 0 || decider[0].role !== CREDIT_LIMIT_DECIDER_ROLE || decider[0].status !== "ACTIVE") {
        throw new Abort<DecideCreditLimitResult>({ status: "FORBIDDEN" });
      }
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

