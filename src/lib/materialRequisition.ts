import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withSequentialNumber } from "@/lib/sequence";
import { notifyRoles } from "@/lib/notify";
import { REQUISITION_APPROVAL_ROLES } from "@/lib/permissions";
import { computeNextAttempt, MAX_ATTEMPTS_BEFORE_DEAD_LETTER } from "@/lib/retryBackoff";
import type { RequisitionCandidate } from "@/lib/batchCompletion";

type Tx = Prisma.TransactionClient;

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

export type CreateRequisitionResult =
  | { status: "CREATED"; requisitionId: string; requisitionNumber: string; materialName: string }
  | { status: "ALREADY_OPEN"; requisitionId: string; requisitionNumber: string; materialName: string }
  | { status: "BELOW_THRESHOLD" }
  | { status: "NOT_TRACKED" };

// The creation half ONLY — no notification. Split out in PL-R10-P2-01
// (tenth production-lifecycle review) so requisition creation and
// approval-notification delivery can be tracked and retried as separate
// progress on one PendingAutoRequisition intent row (see
// processPendingAutoRequisition below) — a notifyRoles failure after the
// requisition itself already committed must retry ONLY the notification,
// never risk a duplicate create.
//
// Raw-material counterpart to issueSparePartToOrder's shortfall handling;
// if what's left is at or below the store's own minThresholdPct, opens a
// MaterialRequisition for enough to refill it (skipped if capacity is
// unset/zero, since there's then no percentage to compare against, or if
// one's already open for this material+site). toKg converts the store's
// own unit (tons for silo/hopper, liters for a chemical tank) to the kg
// PurchaseOrderLine.orderedMassKg expects.
export async function createRequisitionIfNeeded(
  materialId: string,
  siteId: string,
  currentLevel: number,
  capacity: number,
  minThresholdPct: number,
  toKg: (units: number) => number,
): Promise<CreateRequisitionResult> {
  if (capacity <= 0) return { status: "NOT_TRACKED" };
  if ((currentLevel / capacity) * 100 > minThresholdPct) return { status: "BELOW_THRESHOLD" };

  const shortfall = capacity - currentLevel;
  if (shortfall <= 0) return { status: "BELOW_THRESHOLD" };

  const existing = await findOpenRequisition(materialId, siteId);
  if (existing) {
    const material = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
    return { status: "ALREADY_OPEN", requisitionId: existing.id, requisitionNumber: existing.requisitionNumber, materialName: material.name };
  }

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
      const material = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
      return { status: "ALREADY_OPEN", requisitionId: e.winner.id, requisitionNumber: e.winner.requisitionNumber, materialName: material.name };
    }
    // Anything else — including 5 real requisitionNumber collisions —
    // is a genuine allocation failure, not a benign duplicate. It
    // propagates to the caller's own failure handling instead of being
    // silently reinterpreted as success here.
    throw e;
  }

  return { status: "CREATED", requisitionId: requisition.id, requisitionNumber: requisition.requisitionNumber, materialName: requisition.material.name };
}

export async function notifyRequisitionCreated(requisitionNumber: string, materialName: string): Promise<void> {
  await notifyRoles(REQUISITION_APPROVAL_ROLES, {
    title: requisitionNumber,
    body: `${materialName} — auto-requested, stock at or below threshold`,
    link: "/warehouses?tab=rawMaterials&sub=silos",
    module: "Warehouses",
  });
}

function toKgConverter(unit: string, specificGravity: number | null): (units: number) => number {
  return unit === "LITERS" ? (liters: number) => liters * (specificGravity ?? 1) : (tons: number) => tons * 1000;
}

// PL-R10-P2-01, tenth production-lifecycle review: called INSIDE
// completeBatchTicket's own completion transaction (batchCompletion.ts),
// not after a caught failure — the intent is durable from the moment the
// shortage that created it is, so a process crash between commit and the
// best-effort follow-up (or a failure of the row insert itself, the
// Round 9 gap) can no longer lose it. One row per (batchTicketId,
// materialId, siteId) — completeBatchTicket's own claim already makes a
// second call for the SAME ticket unreachable, so a genuine duplicate
// here would only ever be a real bug, not a race to defend against.
export async function stageAutoRequisitionIntent(tx: Tx, batchTicketId: string, candidate: RequisitionCandidate): Promise<{ id: string }> {
  return tx.pendingAutoRequisition.create({
    data: {
      batchTicketId,
      materialId: candidate.materialId,
      siteId: candidate.siteId,
      newLevel: candidate.newLevel,
      capacity: candidate.capacity,
      minThresholdPct: candidate.minThresholdPct,
      unit: candidate.unit,
      specificGravity: candidate.specificGravity ?? null,
    },
    select: { id: true },
  });
}

export type ProcessIntentResult = { status: "RESOLVED" } | { status: "RETRY" };

// The one place that actually drains a staged intent — called both by
// completeBatch's own right-after-commit best-effort attempt (actions.ts)
// and by the daily cron sweep (retryPendingAutoRequisitions below), so
// both paths get identical, idempotent behavior instead of a "fast path"
// and a "retry path" that could quietly drift apart. Progress is tracked
// in two independent steps: requisitionId (creation) and, once that's
// set, the notification — so a notifyRoles failure after the requisition
// already committed retries ONLY the notification on the next pass,
// never a duplicate create (see PL-R10-P2-01's own "record separate
// progress" requirement). Never throws — every failure path is caught
// and turned into a RETRY result with backoff recorded on the row.
//
// `notify` is injectable (defaulting to the real notifyRequisitionCreated
// above), the same DI pattern already used for StorageAdapter
// (offlineQueue.ts) and BlobDeleter (blob.ts) — this is what makes
// "requisition created, notification fails, retry sends notification
// exactly once, never a duplicate create" provable in a real integration
// test without needing to force a genuine notifyRoles failure.
export async function processPendingAutoRequisition(intentId: string, notify: (requisitionNumber: string, materialName: string) => Promise<void> = notifyRequisitionCreated): Promise<ProcessIntentResult> {
  const intent = await prisma.pendingAutoRequisition.findUnique({ where: { id: intentId } });
  if (!intent) return { status: "RESOLVED" }; // already resolved (and deleted) by a concurrent attempt

  try {
    let requisitionNumber = intent.requisitionNumber;
    let materialName = intent.materialName;

    if (!intent.requisitionId) {
      const toKg = toKgConverter(intent.unit, intent.specificGravity);
      const created = await createRequisitionIfNeeded(intent.materialId, intent.siteId, intent.newLevel, intent.capacity, intent.minThresholdPct, toKg);

      if (created.status === "BELOW_THRESHOLD" || created.status === "NOT_TRACKED") {
        // The snapshot that triggered this intent no longer calls for a
        // requisition — re-read fresh from the current MaterialRequisition
        // table (via findOpenRequisition inside createRequisitionIfNeeded)
        // and the storage row's OWN current level (currentLevel/capacity
        // are read fresh from the row's own arguments here — this retry
        // deliberately re-evaluates against the ORIGINAL captured
        // newLevel/capacity/minThresholdPct snapshot, not a fresh storage
        // read: honoring the snapshot that actually triggered the
        // shortage is the documented choice (PL-R10-P2-01) — a retry
        // days later re-reading current storage could either mask a
        // shortage that has since gotten WORSE (silently under-ordering)
        // or skip one that has genuinely resolved (over-ordering); the
        // snapshot is the one thing this intent can prove actually
        // happened at completion time.
        await prisma.pendingAutoRequisition.delete({ where: { id: intentId } }).catch(() => {});
        return { status: "RESOLVED" };
      }
      if (created.status === "ALREADY_OPEN") {
        // Someone else's completion already created (and already
        // notified for) this exact material+site — nothing left for
        // THIS intent to do.
        await prisma.pendingAutoRequisition.delete({ where: { id: intentId } }).catch(() => {});
        return { status: "RESOLVED" };
      }

      // CREATED — record the requisition progress durably BEFORE
      // attempting notification, so a notifyRoles failure next can never
      // cause a retry to re-attempt creation.
      requisitionNumber = created.requisitionNumber;
      materialName = created.materialName;
      await prisma.pendingAutoRequisition.update({
        where: { id: intentId },
        data: { requisitionId: created.requisitionId, requisitionNumber, materialName },
      });
    }

    // requisitionId is now set either way — only the notification is
    // still owed (an ALREADY_OPEN intent above already returned; only a
    // genuine CREATED reaches here).
    await notify(requisitionNumber!, materialName!);
    await prisma.pendingAutoRequisition.delete({ where: { id: intentId } }).catch(() => {});
    return { status: "RESOLVED" };
  } catch (error) {
    const attempts = intent.attempts + 1;
    await prisma.pendingAutoRequisition
      .update({
        where: { id: intentId },
        data: {
          attempts,
          lastError: String(error),
          lastTriedAt: new Date(),
          nextAttemptAt: computeNextAttempt(attempts),
          deadLetteredAt: attempts >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER ? new Date() : undefined,
        },
      })
      .catch(() => {});
    return { status: "RETRY" };
  }
}

// PL-R10-P2-03, tenth production-lifecycle review: a single atomic
// UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) — the
// standard Postgres work-queue claim pattern. Provisionally bumps each
// claimed row's own nextAttemptAt forward by one backoff step BEFORE any
// real work happens, so if this process crashes mid-batch, the row isn't
// immediately re-claimed by a concurrent sweep; processPendingAutoRequisition
// then either deletes the row (resolved) or recomputes the real backoff
// on failure. SKIP LOCKED is what makes two overlapping cron invocations
// safe: each one only ever claims rows the other isn't already holding.
async function claimEligiblePendingAutoRequisitions(limit: number): Promise<{ id: string }[]> {
  const provisionalLease = computeNextAttempt(0);
  return prisma.$queryRaw<{ id: string }[]>`
    UPDATE "PendingAutoRequisition"
    SET "nextAttemptAt" = ${provisionalLease}
    WHERE id IN (
      SELECT id FROM "PendingAutoRequisition"
      WHERE "nextAttemptAt" <= now() AND "deadLetteredAt" IS NULL
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
}

// The api/cron/cleanup sweep's own half — claims a fair batch of
// eligible rows (never the same permanently-failing ones forever, see
// claimEligiblePendingAutoRequisitions) and drains each through the
// exact same processPendingAutoRequisition completeBatch's own best-
// effort attempt uses.
export async function retryPendingAutoRequisitions(
  limit = 200,
  notify: (requisitionNumber: string, materialName: string) => Promise<void> = notifyRequisitionCreated,
): Promise<{ attempted: number; resolved: number }> {
  const claimed = await claimEligiblePendingAutoRequisitions(limit);
  let resolved = 0;
  for (const row of claimed) {
    const outcome = await processPendingAutoRequisition(row.id, notify);
    if (outcome.status === "RESOLVED") resolved++;
  }
  return { attempted: claimed.length, resolved };
}
