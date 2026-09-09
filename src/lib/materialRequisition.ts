import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withSequentialNumber } from "@/lib/sequence";
import { resolveRoleRecipients, createNotificationsInTx, pushToRecipients } from "@/lib/notify";
import { REQUISITION_APPROVAL_ROLES } from "@/lib/permissions";
import { computeNextAttempt, MAX_ATTEMPTS_BEFORE_DEAD_LETTER } from "@/lib/retryBackoff";
import type { QueueSweepCounts } from "@/lib/queueSweep";
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

// PL-R12-P1-03, twelfth production-lifecycle review: siteId is now a
// REQUIRED argument, not an omitted option. REQUISITION_APPROVAL_ROLES
// includes plant managers, and notifyRoles without a site filter fans a
// notification out org-wide — so a manager at site B was told the
// requisition number and material name belonging to site A's shortage,
// even though every page and action they could reach afterwards would
// correctly refuse them. notifyRoles' own siteId option (added for the
// same class of leak on shortage overrides, FR-P1-02) always keeps ADMIN
// in scope, so nothing that legitimately needs org-wide visibility is
// lost by scoping this.
// PL-R13-P1-03, thirteenth production-lifecycle review: runs INSIDE the
// caller's transaction and returns the recipients it created rows for, so
// the caller can push after commit. Previously this owned its own write
// and was called AFTER the requisition had already been stamped
// "notified" — a crash in between left a requisition marked announced
// with no Notification row and no intent left to retry it.
export type RequisitionNotifier = (tx: Tx, params: { requisitionId: string; requisitionNumber: string; materialName: string; siteId: string }) => Promise<string[]>;

export function autoRequisitionDedupeKey(requisitionId: string): string {
  return `auto-requisition:${requisitionId}`;
}

export const notifyRequisitionCreated: RequisitionNotifier = async (tx, { requisitionId, requisitionNumber, materialName, siteId }) => {
  const recipients = await resolveRoleRecipients(tx, REQUISITION_APPROVAL_ROLES, { siteId });
  await createNotificationsInTx(
    tx,
    recipients,
    {
      title: requisitionNumber,
      body: `${materialName} — auto-requested, stock at or below threshold`,
      link: "/warehouses?tab=rawMaterials&sub=silos",
      module: "Warehouses",
    },
    autoRequisitionDedupeKey(requisitionId),
  );
  return recipients;
};

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

export type ProcessIntentResult =
  | { status: "RESOLVED" }
  | { status: "RETRY"; bookkeepingFailed?: boolean }
  // PL-R12-P1-02: another processor holds an unexpired lease on this
  // exact intent. Deliberately NOT folded into RESOLVED — the work is
  // someone else's in-flight responsibility, not finished, and counting
  // it as done is precisely how the concurrent-consumption bug hid.
  | { status: "BUSY" }
  // PL-R12-P2-02: the external work succeeded but recording that fact
  // did not. Never RESOLVED: the row is still there, so the operator-
  // visible counters must say so rather than reporting a clean sweep.
  | { status: "BOOKKEEPING_FAILED" };

// How long one processor may hold an intent before another may take it
// over. Comfortably longer than a requisition create + notify round
// trip, short enough that a crashed process frees the row well within
// the daily sweep cadence.
const INTENT_LEASE_MS = 5 * 60 * 1000;

// PL-R12-P1-02: the ONE claim every entry point goes through — both
// completeBatch's immediate post-commit attempt and the cron sweep. A
// conditional updateMany, so the claim is decided by the database, not
// by a read-then-write the other processor can interleave with.
async function claimAutoRequisitionIntent(intentId: string, owner: string): Promise<{ status: "CLAIMED" } | { status: "BUSY" } | { status: "GONE" }> {
  const now = new Date();
  const claimed = await prisma.pendingAutoRequisition.updateMany({
    where: {
      id: intentId,
      OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + INTENT_LEASE_MS) },
  });
  if (claimed.count === 1) return { status: "CLAIMED" };
  const stillThere = await prisma.pendingAutoRequisition.count({ where: { id: intentId } });
  return stillThere === 0 ? { status: "GONE" } : { status: "BUSY" };
}

// PL-R12-P2-02: the cleanup that decides RESOLVED. A `.catch(() => {})`
// here used to swallow a failed delete and still report RESOLVED, so a
// row that was still sitting in the queue was counted as drained and the
// operator-visible counters said the sweep was clean.
async function finishIntent(intentId: string, owner: string): Promise<ProcessIntentResult> {
  try {
    // PL-R13-P1-03: fenced on the lease. `delete({ where: { id } })` let
    // an owner whose lease had already expired remove work the CURRENT
    // owner was mid-way through.
    const removed = await prisma.pendingAutoRequisition.deleteMany({ where: { id: intentId, leaseOwner: owner } });
    return removed.count === 1 ? { status: "RESOLVED" } : { status: "BUSY" };
  } catch (error) {
    console.error(`[materialRequisition] intent ${intentId} completed its work but could not be removed from the queue:`, error);
    return { status: "BOOKKEEPING_FAILED" };
  }
}

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
export async function processPendingAutoRequisition(intentId: string, notify: RequisitionNotifier = notifyRequisitionCreated): Promise<ProcessIntentResult> {
  // PL-R12-P1-02: claim BEFORE reading, so no two processors ever act on
  // one intent's state. The previous version opened with an unlocked
  // findUnique, which is exactly how the immediate post-commit caller and
  // a cron worker could both see requisitionId = null.
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const claim = await claimAutoRequisitionIntent(intentId, owner);
  if (claim.status === "GONE") return { status: "RESOLVED" }; // already fully resolved (and deleted) by a previous attempt
  if (claim.status === "BUSY") return { status: "BUSY" };

  const intent = await prisma.pendingAutoRequisition.findUnique({ where: { id: intentId } });
  if (!intent) return { status: "RESOLVED" };

  try {
    let requisitionId = intent.requisitionId;
    let requisitionNumber = intent.requisitionNumber;
    let materialName = intent.materialName;

    if (!requisitionId) {
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
        // PL-R12-P2-02: a delete that fails is a BOOKKEEPING failure, not
        // a resolution. Reporting RESOLVED for a row that is still on
        // file is exactly how a stuck queue looked healthy.
        return finishIntent(intentId, owner);
      }
      // PL-R12-P1-02: ALREADY_OPEN no longer deletes the intent on the
      // ASSUMPTION that whoever created that requisition also notified
      // for it — that assumption is what let a concurrent processor
      // destroy the creator's outstanding notification work. The winning
      // requisition is attached to this intent and the explicit
      // notification state below decides, from the requisition's own
      // delivery stamp, whether anything is still owed.
      requisitionId = created.requisitionId;
      requisitionNumber = created.requisitionNumber;
      materialName = created.materialName;
      // CREATED and ALREADY_OPEN alike: record the requisition progress
      // durably BEFORE attempting notification, so a notify failure can
      // never cause a retry to re-attempt creation. PL-R13-P1-03: fenced
      // on our own lease — an owner whose lease has expired must not
      // write over whoever holds it now.
      const progress = await prisma.pendingAutoRequisition.updateMany({
        where: { id: intentId, leaseOwner: owner },
        data: { requisitionId, requisitionNumber, materialName },
      });
      if (progress.count === 0) return { status: "BUSY" };
    }

    // PL-R13-P1-03: delivery and cleanup are ONE transaction.
    //
    // The previous version stamped MaterialRequisition.autoRequisitionNotifiedAt
    // FIRST and then called the notifier — but the notifier is what
    // creates the durable Notification rows. A process crash in between
    // left a requisition marked "announced", no notification anywhere,
    // and (once the lease expired) a next processor that saw the stamp,
    // skipped the notification, and deleted the intent. Rolling the stamp
    // back in a catch cannot help with a crash.
    //
    // Now: create the rows, stamp the requisition, and remove the intent
    // all inside one transaction. Either every one of those facts is true
    // afterwards or none is — so the intent can never be deleted before a
    // durable Notification exists. The dedupeKey + skipDuplicates in
    // createNotificationsInTx makes re-running this after a rollback safe.
    let recipients: string[] = [];
    const settled = await prisma.$transaction(async (tx) => {
      if (!intent.notificationDeliveredAt) {
        // Whether anything is still owed is read from the requisition's
        // own stamp — a fact in the database, never an assumption that
        // some other intent must have delivered it.
        const requisition = await tx.materialRequisition.findUnique({ where: { id: requisitionId! }, select: { autoRequisitionNotifiedAt: true } });
        if (requisition && requisition.autoRequisitionNotifiedAt === null) {
          recipients = await notify(tx, { requisitionId: requisitionId!, requisitionNumber: requisitionNumber!, materialName: materialName!, siteId: intent.siteId });
          await tx.materialRequisition.updateMany({ where: { id: requisitionId!, autoRequisitionNotifiedAt: null }, data: { autoRequisitionNotifiedAt: new Date() } });
        }
      }
      // Fenced: only the lease holder may retire the intent.
      const removed = await tx.pendingAutoRequisition.deleteMany({ where: { id: intentId, leaseOwner: owner } });
      return removed.count === 1;
    });
    if (!settled) return { status: "BUSY" };

    // Push AFTER commit and outside the transaction — best-effort by
    // design, and it must never hold a transaction open or turn an
    // already-committed delivery into a failure.
    await pushToRecipients(recipients, {
      title: requisitionNumber!,
      body: `${materialName} — auto-requested, stock at or below threshold`,
      link: "/warehouses?tab=rawMaterials&sub=silos",
    });
    return { status: "RESOLVED" };
  } catch (error) {
    const attempts = intent.attempts + 1;
    try {
      // PL-R13-P1-03: fenced on our own lease, like every other write to
      // this row. If the lease has already been taken over, recording OUR
      // failure would overwrite the new owner's state — count === 0 here
      // means exactly that, and nothing further may be transitioned.
      const recorded = await prisma.pendingAutoRequisition.updateMany({
        where: { id: intentId, leaseOwner: owner },
        data: {
          attempts,
          lastError: String(error),
          lastTriedAt: new Date(),
          nextAttemptAt: computeNextAttempt(attempts),
          deadLetteredAt: attempts >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER ? new Date() : undefined,
          // PL-R12-P1-02: release our own lease on the way out, so the
          // next sweep can retry as soon as the backoff allows instead of
          // waiting out the full lease behind a processor that is already
          // finished with this row.
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      return recorded.count === 1 ? { status: "RETRY" } : { status: "BUSY" };
    } catch (bookkeepingError) {
      // PL-R12-P2-02: previously `.catch(() => {})`. A failure to record
      // the attempt means this row keeps its OLD nextAttemptAt and lease
      // and will be re-attempted with no backoff at all — a real
      // operational fact the sweep's counters must be able to report.
      console.error(`[materialRequisition] intent ${intentId} failed AND its failure could not be recorded:`, error, bookkeepingError);
      return { status: "RETRY", bookkeepingFailed: true };
    }
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
export async function retryPendingAutoRequisitions(limit = 200, notify: RequisitionNotifier = notifyRequisitionCreated): Promise<QueueSweepCounts> {
  const claimed = await claimEligiblePendingAutoRequisitions(limit);
  const counts: QueueSweepCounts = { claimed: claimed.length, resolved: 0, busy: 0, externalFailed: 0, bookkeepingFailed: 0, deadLettered: 0 };
  for (const row of claimed) {
    const outcome = await processPendingAutoRequisition(row.id, notify);
    if (outcome.status === "RESOLVED") counts.resolved++;
    else if (outcome.status === "BUSY") counts.busy++;
    else if (outcome.status === "BOOKKEEPING_FAILED") counts.bookkeepingFailed++;
    else {
      counts.externalFailed++;
      if (outcome.bookkeepingFailed) counts.bookkeepingFailed++;
    }
  }
  counts.deadLettered = await prisma.pendingAutoRequisition.count({ where: { deadLetteredAt: { not: null } } });
  return counts;
}
