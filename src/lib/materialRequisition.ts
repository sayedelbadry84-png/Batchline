import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withSequentialNumber } from "@/lib/sequence";
import { notifyRoles } from "@/lib/notify";
import { REQUISITION_APPROVAL_ROLES } from "@/lib/permissions";

// Extracted out of production/actions.ts (PL-R8-P2-02, eighth production-
// lifecycle review) so the concurrency behavior below is directly
// testable against real PostgreSQL, not only inspectable as code — the
// same reasoning that already pulled completeBatchTicket/
// claimAndRecordActualField/etc. out of their own Server Actions.

// withSequentialNumber's own P2002 retry loop treats EVERY P2002 as a
// requisitionNumber collision worth retrying with the next number — it
// has no way to know this create can also collide on the DIFFERENT
// partial unique index MaterialRequisition_open_per_material_site_key
// (migration harden_production_lifecycle_round7_part2).
//
// PL-R9-P1-01, ninth production-lifecycle review: the previous fix tried
// to tell the two collisions apart by matching an index-name substring
// in the P2002's own `meta.target` — CI proved this doesn't match the
// shape Prisma's real query engine actually reports for a raw-SQL
// partial index, so every real open-requisition collision escaped as a
// plain P2002, got retried five times against five different numbers
// (never able to succeed, since the number was never the problem), and
// surfaced as the same generic "Could not allocate" failure this whole
// mechanism exists to avoid.
//
// This classifies by the AUTHORITATIVE RESULT instead of by parsing
// Prisma's error internals: after any P2002 on this create, ask the
// database directly whether an open requisition for this exact
// material+site now exists. A unique-index conflict only ever returns
// once the winning transaction has committed or aborted, so this read
// is reliable — if a row is there, THAT was the open-requisition index;
// if genuinely nothing is there, the P2002 could only have been a real
// requisitionNumber collision, and rethrowing it unchanged lets
// withSequentialNumber correctly retry with the next number.
class RequisitionAlreadyOpenError extends Error {
  constructor(public winner: { id: string; requisitionNumber: string }) {
    super("An equivalent open requisition already exists for this material and site.");
  }
}

async function findOpenRequisition(materialId: string, siteId: string) {
  return prisma.materialRequisition.findFirst({
    where: { materialId, siteId, status: { in: ["PENDING_APPROVAL", "APPROVED", "ORDERED"] } },
  });
}

export type AutoRequisitionResult =
  | { status: "CREATED"; requisitionId: string; requisitionNumber: string }
  | { status: "ALREADY_OPEN"; requisitionId: string; requisitionNumber: string }
  | { status: "BELOW_THRESHOLD" }
  | { status: "NOT_TRACKED" };

// Raw-material counterpart to issueSparePartToOrder's shortfall handling —
// called from completeBatch right after a silo/hopper/tank's level is
// deducted; if what's left is at or below the store's own minThresholdPct,
// opens a MaterialRequisition for enough to refill it (skipped if capacity
// is unset/zero, since there's then no percentage to compare against, or
// if one's already open for this material+site). toKg converts the
// store's own unit (tons for silo/hopper, liters for a chemical tank) to
// the kg PurchaseOrderLine.orderedMassKg expects.
export async function maybeAutoRequisitionMaterial(
  materialId: string,
  siteId: string,
  currentLevel: number,
  capacity: number,
  minThresholdPct: number,
  toKg: (units: number) => number,
): Promise<AutoRequisitionResult> {
  if (capacity <= 0) return { status: "NOT_TRACKED" };
  if ((currentLevel / capacity) * 100 > minThresholdPct) return { status: "BELOW_THRESHOLD" };

  const shortfall = capacity - currentLevel;
  if (shortfall <= 0) return { status: "BELOW_THRESHOLD" };

  const existing = await findOpenRequisition(materialId, siteId);
  if (existing) return { status: "ALREADY_OPEN", requisitionId: existing.id, requisitionNumber: existing.requisitionNumber };

  // The pre-check above is a plain read with no lock — a genuinely
  // concurrent completion for the same material+site can still race past
  // it and try to create a second open requisition; the partial unique
  // index is the real backstop for that race, classified precisely below.
  let requisition;
  try {
    requisition = await withSequentialNumber(
      "MTR",
      (yr) => prisma.materialRequisition.count({ where: { createdAt: yr } }),
      async (requisitionNumber) => {
        try {
          return await prisma.materialRequisition.create({
            data: { requisitionNumber, materialId, siteId, quantityNeededKg: toKg(shortfall) },
            include: { material: true },
          });
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
          // A unique-index conflict only ever returns once the winning
          // transaction has committed or aborted — so this read is
          // reliable, not a race of its own. A row here means THIS was
          // the open-requisition index; nothing here means it could only
          // have been a genuine requisitionNumber collision, so rethrow
          // unchanged and let withSequentialNumber correctly retry with
          // the next number.
          const winner = await findOpenRequisition(materialId, siteId);
          if (winner) throw new RequisitionAlreadyOpenError(winner);
          throw e;
        }
      },
    );
  } catch (e) {
    if (e instanceof RequisitionAlreadyOpenError) {
      // A concurrent completion won the exact race between our own
      // pre-check and this create — an equivalent open requisition now
      // genuinely exists. Return the ACTUAL winner captured on the
      // sentinel (not a second, separately-timed lookup) — the review's
      // own "return the existing open requisition" ask — so both
      // concurrent callers resolve to the SAME row instead of one of
      // them silently doing nothing with no visible result at all.
      return { status: "ALREADY_OPEN", requisitionId: e.winner.id, requisitionNumber: e.winner.requisitionNumber };
    }
    // Anything else — including 5 real requisitionNumber collisions —
    // is a genuine allocation failure, not a benign duplicate. It
    // propagates to the caller's own failure handling instead of being
    // silently reinterpreted as success here.
    throw e;
  }

  await notifyRoles(REQUISITION_APPROVAL_ROLES, {
    title: requisition.requisitionNumber,
    body: `${requisition.material.name} — auto-requested, stock at or below threshold`,
    link: "/warehouses?tab=rawMaterials&sub=silos",
    module: "Warehouses",
  });
  return { status: "CREATED", requisitionId: requisition.id, requisitionNumber: requisition.requisitionNumber };
}

// PL-R9-P2-03, ninth production-lifecycle review: completeBatch's own
// call into maybeAutoRequisitionMaterial above is deliberately best-
// effort (the batch itself must stay COMPLETE regardless of a
// purchasing-side failure) — but the old catch block there just logged
// and moved on, leaving no durable trace that a shortage never actually
// got a requisition opened for it. This is the paired "queue it for
// retry" half — see retryPendingAutoRequisitions below for the drain
// side, and PendingAutoRequisition's own comment in schema.prisma for
// why this is a narrow, reused-infrastructure fix rather than a full
// transactional outbox. Never throws: this itself runs from inside a
// catch block that must not fail the request it's already recovering
// from.
export async function queuePendingAutoRequisition(batchTicketId: string, candidate: { materialId: string; siteId: string; newLevel: number; capacity: number; minThresholdPct: number; unit: "TONS" | "LITERS"; specificGravity?: number }, error: unknown): Promise<void> {
  try {
    await prisma.pendingAutoRequisition.create({
      data: {
        batchTicketId,
        materialId: candidate.materialId,
        siteId: candidate.siteId,
        newLevel: candidate.newLevel,
        capacity: candidate.capacity,
        minThresholdPct: candidate.minThresholdPct,
        unit: candidate.unit,
        specificGravity: candidate.specificGravity ?? null,
        lastError: String(error),
      },
    });
  } catch (persistError) {
    console.error(`[materialRequisition] auto-requisition follow-up failed AND failed to record for retry: material ${candidate.materialId}, ticket ${batchTicketId}`, error, persistError);
  }
}

// The api/cron/cleanup sweep's own half — retries every row still on
// file by calling the exact same maybeAutoRequisitionMaterial callers
// use directly, so a retry gets the exact same idempotent behavior a
// fresh call would (findOpenRequisition's own pre-check means a
// requisition that DID get created before the original failure — e.g. a
// failure inside notifyRoles, after the create had already committed —
// is correctly seen as ALREADY_OPEN on retry rather than duplicated). A
// row is removed once it resolves to ANY terminal outcome (CREATED,
// ALREADY_OPEN, BELOW_THRESHOLD, NOT_TRACKED are all "nothing left to
// retry"); a row that fails again just records the new error for
// tomorrow's run — retried indefinitely, same reasoning as
// retryPendingBlobDeletions (blob.ts): the cost of leaving a row queued
// is a delayed requisition, never incorrect data.
export async function retryPendingAutoRequisitions(): Promise<{ attempted: number; resolved: number }> {
  const rows = await prisma.pendingAutoRequisition.findMany({ orderBy: { createdAt: "asc" }, take: 200 });
  let resolved = 0;
  for (const row of rows) {
    const toKg = row.unit === "LITERS" ? (liters: number) => liters * (row.specificGravity ?? 1) : (tons: number) => tons * 1000;
    try {
      await maybeAutoRequisitionMaterial(row.materialId, row.siteId, row.newLevel, row.capacity, row.minThresholdPct, toKg);
      await prisma.pendingAutoRequisition.delete({ where: { id: row.id } }).catch(() => {});
      resolved++;
    } catch (error) {
      await prisma.pendingAutoRequisition.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lastError: String(error), lastTriedAt: new Date() } }).catch(() => {});
    }
  }
  return { attempted: rows.length, resolved };
}
