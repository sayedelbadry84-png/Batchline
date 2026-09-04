import "server-only";
import { prisma } from "@/lib/prisma";

// The request/approval workflow behind a shortage override (P1-04) —
// replaces the old flow where anyone who happened to hold both `complete`
// and `overrideShortage` could type a note and have it apply immediately
// at the moment of completion. Now: any operator who can complete a batch
// can request an override after hitting a real shortage; only an
// overrideShortage holder can approve or reject it; completeBatchTicket
// (batchCompletion.ts) looks for an APPROVED, unconsumed request tied to
// the ticket and consumes it only if the completion actually needs it.

export type RequestResult =
  | { status: "OK"; requestId: string }
  | { status: "NOT_FOUND" }
  | { status: "TICKET_TERMINAL" }
  | { status: "ALREADY_PENDING" }
  | { status: "ALREADY_APPROVED" };

export async function requestShortageOverride(ticketId: string, opts: { reason: string; requestedById: string }): Promise<RequestResult> {
  const ticket = await prisma.batchTicket.findUnique({ where: { id: ticketId }, select: { status: true } });
  if (!ticket) return { status: "NOT_FOUND" };
  if (ticket.status === "COMPLETE" || ticket.status === "CANCELLED") return { status: "TICKET_TERMINAL" };

  const existing = await prisma.shortageOverrideRequest.findFirst({
    where: { batchTicketId: ticketId, status: { in: ["PENDING", "APPROVED"] } },
  });
  if (existing) return existing.status === "PENDING" ? { status: "ALREADY_PENDING" } : { status: "ALREADY_APPROVED" };

  try {
    const created = await prisma.shortageOverrideRequest.create({
      data: { batchTicketId: ticketId, reason: opts.reason, requestedById: opts.requestedById },
    });
    return { status: "OK", requestId: created.id };
  } catch (e) {
    // The partial unique index (one active request per ticket) caught a
    // concurrent request that won the race between the check above and
    // this insert — same outcome as if we'd seen it in the first place.
    if (isUniqueViolation(e)) {
      const winner = await prisma.shortageOverrideRequest.findFirst({
        where: { batchTicketId: ticketId, status: { in: ["PENDING", "APPROVED"] } },
      });
      return winner?.status === "PENDING" ? { status: "ALREADY_PENDING" } : { status: "ALREADY_APPROVED" };
    }
    throw e;
  }
}

export type DecisionResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "NOT_PENDING" };

export async function approveShortageOverrideRequest(requestId: string, approvedById: string): Promise<DecisionResult> {
  const claim = await prisma.shortageOverrideRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "APPROVED", approvedById, approvedAt: new Date() },
  });
  if (claim.count > 0) return { status: "OK" };
  const exists = await prisma.shortageOverrideRequest.findUnique({ where: { id: requestId }, select: { id: true } });
  return exists ? { status: "NOT_PENDING" } : { status: "NOT_FOUND" };
}

export async function rejectShortageOverrideRequest(requestId: string, approvedById: string, rejectionNote: string): Promise<DecisionResult> {
  const claim = await prisma.shortageOverrideRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "REJECTED", approvedById, approvedAt: new Date(), rejectionNote },
  });
  if (claim.count > 0) return { status: "OK" };
  const exists = await prisma.shortageOverrideRequest.findUnique({ where: { id: requestId }, select: { id: true } });
  return exists ? { status: "NOT_PENDING" } : { status: "NOT_FOUND" };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002";
}
