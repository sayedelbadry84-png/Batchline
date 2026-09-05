import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveTicketComponents, type ResolveComponentsResult } from "@/lib/batchCompletion";
import { EPSILON } from "@/lib/inventoryLedger";

type Tx = Prisma.TransactionClient;

// The request/approval workflow behind a shortage override (P1-04) —
// replaces the old flow where anyone who happened to hold both `complete`
// and `overrideShortage` could type a note and have it apply immediately
// at the moment of completion. Now: any operator who can complete a batch
// can request an override after hitting a real shortage; only an
// overrideShortage holder can approve or reject it; completeBatchTicket
// (batchCompletion.ts) looks for an APPROVED, unconsumed request tied to
// the ticket and consumes it only if the completion actually needs it —
// and only up to exactly what was snapshotted (see computeShortageSnapshot
// below), not a blanket "there's a shortage, trust me" (P1-03, fourth
// review).

export type ShortageSnapshotEntry = { materialId: string; materialName: string; unit: "TONS" | "LITERS"; requiredQty: number; availableQty: number; shortageQty: number };

type SnapshotResult = { status: "OK"; entries: ShortageSnapshotEntry[] } | { status: "NOT_FOUND" } | { status: "STORAGE_NOT_CONFIGURED"; material: string } | { status: "NO_SHORTAGE" };

// A dry run — no lock, no write — of exactly the same storage resolution
// completeBatchTicket itself uses (resolveTicketComponents,
// batchCompletion.ts), reading each resolved component's CURRENT level to
// compute what shortage this ticket would actually hit right now. Only
// materials genuinely short (by more than a floating-point epsilon) make
// it into the snapshot; a ticket with no real shortage right now gets
// NO_SHORTAGE rather than a request that could never authorize anything.
//
// Simulates a per-storage running balance, decremented as components are
// processed in resolveTicketComponents' own deterministic order, rather
// than reading each component's availableQty independently against the
// same original balance (BL-FU-P1-01, sixth review): two different
// materials with no explicit silo/hopper assignment can both resolve to
// the very same generic fallback storage, and real completion posts
// against it sequentially, each post seeing the PRIOR post's already-
// decremented level (via postMovement's own SELECT ... FOR UPDATE). A
// snapshot that scored every component against the same starting balance
// could report NO_SHORTAGE for a ticket that completion then genuinely
// can't satisfy.
async function computeShortageSnapshot(db: Tx | typeof prisma, ticketId: string): Promise<SnapshotResult> {
  const ticket = await db.batchTicket.findUnique({
    where: { id: ticketId },
    include: { components: { include: { material: true } }, plant: true },
  });
  if (!ticket) return { status: "NOT_FOUND" };

  const resolution: ResolveComponentsResult = await resolveTicketComponents(db, ticket);
  if (resolution.status === "STORAGE_NOT_CONFIGURED") return resolution;

  const remainingByStorage = new Map<string, number>();
  const entries: ShortageSnapshotEntry[] = [];
  for (const r of resolution.resolved) {
    if (!remainingByStorage.has(r.storageId)) remainingByStorage.set(r.storageId, r.currentLevel);
    const availableQty = Math.max(0, remainingByStorage.get(r.storageId)!);
    const requiredQty = Math.abs(r.quantity);
    const shortageQty = Math.max(0, requiredQty - availableQty);
    remainingByStorage.set(r.storageId, availableQty - Math.min(requiredQty, availableQty));
    if (shortageQty > EPSILON) {
      entries.push({ materialId: r.materialId, materialName: r.materialName, unit: r.storageType === "CHEMICAL_TANK" ? "LITERS" : "TONS", requiredQty, availableQty, shortageQty });
    }
  }
  if (entries.length === 0) return { status: "NO_SHORTAGE" };
  return { status: "OK", entries };
}

export type RequestResult =
  | { status: "OK"; requestId: string }
  | { status: "NOT_FOUND" }
  | { status: "TICKET_TERMINAL" }
  | { status: "ALREADY_PENDING" }
  | { status: "ALREADY_APPROVED" }
  | { status: "NO_SHORTAGE" }
  | { status: "STORAGE_NOT_CONFIGURED"; material: string };

export async function requestShortageOverride(ticketId: string, opts: { reason: string; requestedById: string }): Promise<RequestResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // A row lock on the ticket itself, taken BEFORE the terminal check
      // — not just a plain read — so this can never race completeBatchTicket's
      // own claim (an UPDATE on this same row) and insert a request for a
      // ticket that became COMPLETE a moment earlier (P1-02, fourth
      // review). Whichever transaction — this one or a concurrent
      // completion — acquires the lock first is what the other correctly
      // sees once it proceeds.
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "BatchTicket" WHERE id = ${ticketId} FOR UPDATE`;
      const status = rows[0]?.status;
      if (status === undefined) return { status: "NOT_FOUND" as const };
      if (status === "COMPLETE" || status === "CANCELLED") return { status: "TICKET_TERMINAL" as const };

      const existing = await tx.shortageOverrideRequest.findFirst({
        where: { batchTicketId: ticketId, status: { in: ["PENDING", "APPROVED"] } },
      });
      if (existing) return existing.status === "PENDING" ? { status: "ALREADY_PENDING" as const } : { status: "ALREADY_APPROVED" as const };

      const snapshot = await computeShortageSnapshot(tx, ticketId);
      if (snapshot.status === "NOT_FOUND") return { status: "NOT_FOUND" as const };
      if (snapshot.status === "STORAGE_NOT_CONFIGURED") return { status: "STORAGE_NOT_CONFIGURED" as const, material: snapshot.material };
      if (snapshot.status === "NO_SHORTAGE") return { status: "NO_SHORTAGE" as const };

      const created = await tx.shortageOverrideRequest.create({
        data: { batchTicketId: ticketId, reason: opts.reason, requestedById: opts.requestedById, shortageSnapshot: snapshot.entries },
      });
      return { status: "OK" as const, requestId: created.id };
    });
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

// The normal path never lets a PENDING request survive its ticket going
// terminal — completeBatchTicket/cancelBatchTicket always expire it in
// the same transaction that flips the ticket (see batchCompletion.ts).
// This is a defense-in-depth check on top of that, not the primary
// safety mechanism: if a PENDING row ever DID end up pointing at an
// already-terminal ticket (inconsistent data, manual DB recovery, a bug
// elsewhere), the decision endpoints must still refuse it themselves
// rather than trusting the normal path always ran (BL-FU-P2-01, sixth
// review) — the server stays authoritative even if the UI is stale.
async function isTicketTerminal(batchTicketId: string): Promise<boolean> {
  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId }, select: { status: true } });
  return ticket?.status === "COMPLETE" || ticket?.status === "CANCELLED";
}

export async function approveShortageOverrideRequest(requestId: string, approvedById: string): Promise<DecisionResult> {
  const request = await prisma.shortageOverrideRequest.findUnique({ where: { id: requestId }, select: { batchTicketId: true } });
  if (!request) return { status: "NOT_FOUND" };
  if (await isTicketTerminal(request.batchTicketId)) return { status: "NOT_PENDING" };

  const claim = await prisma.shortageOverrideRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "APPROVED", approvedById, approvedAt: new Date() },
  });
  if (claim.count > 0) return { status: "OK" };
  const exists = await prisma.shortageOverrideRequest.findUnique({ where: { id: requestId }, select: { id: true } });
  // NOT_PENDING covers every reason this wasn't awaiting a decision
  // anymore: someone else already approved/rejected it, OR its ticket
  // completed/was cancelled and completeBatchTicket/cancelBatchTicket
  // already expired it (P1-02) — deliberately one result, not a separate
  // TICKET_TERMINAL, since both mean the same thing to the caller: this
  // decision no longer does anything.
  return exists ? { status: "NOT_PENDING" } : { status: "NOT_FOUND" };
}

export async function rejectShortageOverrideRequest(requestId: string, approvedById: string, rejectionNote: string): Promise<DecisionResult> {
  const request = await prisma.shortageOverrideRequest.findUnique({ where: { id: requestId }, select: { batchTicketId: true } });
  if (!request) return { status: "NOT_FOUND" };
  if (await isTicketTerminal(request.batchTicketId)) return { status: "NOT_PENDING" };

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
