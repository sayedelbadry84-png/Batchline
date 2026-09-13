import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

// PL-R12-P2-03, twelfth production-lifecycle review: both retry queues
// could already park a row as dead-lettered past
// MAX_ATTEMPTS_BEFORE_DEAD_LETTER (retryBackoff.ts), but nothing ever
// showed those rows to a human and no action could requeue or drop one.
// A row reaching that state meant a real consequence had been abandoned —
// a purchasing requisition never opened, or an orphaned delivery photo
// never cleaned up — with the only evidence a console line in a serverless
// log nobody reads.
//
// Domain layer only: no session access, no formData, so the site-scope
// rule and both state transitions below are directly testable against
// real PostgreSQL (same split as completeBatchTicket/claimAndRecordActuals).

export type DeadLetterKind = "AUTO_REQUISITION" | "BLOB_DELETION";

export type DeadLetterRow = {
  kind: DeadLetterKind;
  id: string;
  // Human-facing identity of the abandoned work.
  subject: string;
  reason: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: Date;
  // Null for blob deletions, which have no site of their own — see the
  // scoping note on listDeadLetters.
  siteId: string | null;
};

export type DeadLetterActionResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "NOT_DEAD_LETTERED" };

// allowedSiteId is effectiveSiteId(user): null for ADMIN (every site),
// otherwise the caller's one site.
//
// PendingAutoRequisition carries a real siteId and is filtered by it.
// PendingBlobDeletion deliberately has no site — it is a storage path and
// a failure reason, with no plant/site attribution available to filter on
// — so rather than guess an owner, it is shown only to callers with
// org-wide scope (ADMIN). A site-scoped operator therefore sees exactly
// the dead letters that belong to their own site and nothing else.
// PL-R13-P2-03, thirteenth production-lifecycle review: returns the total
// alongside the page. The page previously rendered `rows.length` as the
// count while each query was capped at 200 — so past 200 rows of one kind
// the operator was shown a number that was simply wrong, with no way to
// reach the rest. `page` is 0-based; `pageSize` applies to EACH queue,
// and `total` is the real count across both.
export const DEAD_LETTER_PAGE_SIZE = 50;

export async function listDeadLetters(allowedSiteId: string | null, page = 0, pageSize = DEAD_LETTER_PAGE_SIZE): Promise<{ rows: DeadLetterRow[]; total: number; page: number; pageSize: number }> {
  const safePage = Math.max(0, page);
  const skip = safePage * pageSize;

  // PL-R14-P2-01, fourteenth production-lifecycle review: paginate the
  // ORDERED UNION, not each table separately.
  //
  // Taking `pageSize` from each queue and merging afterwards produced a
  // page of up to 2 × pageSize rows for an ADMIN (who sees both kinds),
  // made the "showing X–Y" range wrong, and could offer a "next" link to
  // an empty page — 25 + 25 dead letters filled a 50-row page exactly,
  // so `rows.length === pageSize` claimed another page existed when it
  // did not. One UNION ALL with a single ORDER BY / LIMIT / OFFSET is the
  // only shape where a page is a genuine global slice.
  //
  // Ordered by deadLetteredAt DESC then kind, id so the sort is TOTAL:
  // two rows parked in the same millisecond must still have a stable
  // relative order, or paging could repeat or skip one at a page seam.
  const siteFilter = allowedSiteId === null ? Prisma.sql`TRUE` : Prisma.sql`p."siteId" = ${allowedSiteId}`;
  // Blob deletions carry no site of their own, so a site-scoped caller is
  // never shown them (see this function's own scoping note above).
  const blobFilter = allowedSiteId === null ? Prisma.sql`TRUE` : Prisma.sql`FALSE`;

  const [raw, total] = await Promise.all([
    prisma.$queryRaw<
      { kind: DeadLetterKind; id: string; subject: string; reason: string; attempts: number; lastError: string | null; deadLetteredAt: Date; siteId: string | null }[]
    >`
      SELECT * FROM (
        SELECT
          'AUTO_REQUISITION' AS kind,
          p."id"             AS id,
          COALESCE(p."requisitionNumber", p."materialName", p."materialId") AS subject,
          CASE WHEN p."requisitionId" IS NOT NULL THEN 'NOTIFICATION_UNDELIVERED' ELSE 'REQUISITION_NOT_OPENED' END AS reason,
          p."attempts"       AS attempts,
          p."lastError"      AS "lastError",
          p."deadLetteredAt" AS "deadLetteredAt",
          p."siteId"         AS "siteId"
        FROM "PendingAutoRequisition" p
        WHERE p."deadLetteredAt" IS NOT NULL AND ${siteFilter}

        UNION ALL

        SELECT
          'BLOB_DELETION'    AS kind,
          b."id"             AS id,
          b."url"            AS subject,
          b."reason"         AS reason,
          b."attempts"       AS attempts,
          b."lastError"      AS "lastError",
          b."deadLetteredAt" AS "deadLetteredAt",
          NULL               AS "siteId"
        FROM "PendingBlobDeletion" b
        WHERE b."deadLetteredAt" IS NOT NULL AND ${blobFilter}
      ) AS dead_letters
      ORDER BY "deadLetteredAt" DESC, kind ASC, id ASC
      LIMIT ${pageSize} OFFSET ${skip}
    `,
    countDeadLetters(allowedSiteId),
  ]);

  // attempts comes back from Postgres as a number already, but the raw
  // query bypasses Prisma's own mapping — normalized here so callers get
  // exactly the DeadLetterRow shape the typed path returned.
  const rows: DeadLetterRow[] = raw.map((r) => ({
    kind: r.kind,
    id: r.id,
    subject: r.subject,
    reason: r.reason,
    attempts: Number(r.attempts),
    lastError: r.lastError,
    deadLetteredAt: r.deadLetteredAt,
    siteId: r.siteId,
  }));

  return { rows, total, page: safePage, pageSize };
}

export async function countDeadLetters(allowedSiteId: string | null): Promise<number> {
  const [requisitions, blobs] = await Promise.all([
    prisma.pendingAutoRequisition.count({ where: { deadLetteredAt: { not: null }, ...(allowedSiteId === null ? {} : { siteId: allowedSiteId }) } }),
    allowedSiteId === null ? prisma.pendingBlobDeletion.count({ where: { deadLetteredAt: { not: null } } }) : Promise.resolve(0),
  ]);
  return requisitions + blobs;
}

// PL-R13-P2-01: the site predicate every scoped WRITE below carries, so
// authorization is decided by the same statement that mutates the row
// rather than by an earlier, separately-timed read. `null` (ADMIN) adds
// no condition at all.
function siteCondition(allowedSiteId: string | null): { siteId?: string } {
  return allowedSiteId === null ? {} : { siteId: allowedSiteId };
}

// PL-R14-P2-02, fourteenth production-lifecycle review: classifies a
// mutation that matched NOTHING, and runs only AFTER that mutation.
//
// There used to be an inScope() pre-read gating the whole action. It made
// the write's own site condition untestable — a row moved between the
// read and the write was already rejected by the re-read, so the
// condition inside the UPDATE never got exercised — and it was a second,
// separately-timed authorization decision on top of the real one. The
// mutation is now the single authorization point; this only decides
// which refusal to report, and it re-applies the caller's own scope so a
// row outside it is indistinguishable from one that does not exist.
async function classifyMiss(kind: DeadLetterKind, id: string, allowedSiteId: string | null): Promise<DeadLetterActionResult> {
  if (kind === "BLOB_DELETION") {
    // Blob deletions carry no site, so a site-scoped caller can never act
    // on one at all — reported as NOT_FOUND rather than disclosing it.
    if (allowedSiteId !== null) return { status: "NOT_FOUND" };
    const row = await prisma.pendingBlobDeletion.findUnique({ where: { id }, select: { deadLetteredAt: true } });
    if (!row) return { status: "NOT_FOUND" };
    return { status: "NOT_DEAD_LETTERED" };
  }
  const row = await prisma.pendingAutoRequisition.findFirst({
    where: { id, ...siteCondition(allowedSiteId) },
    select: { deadLetteredAt: true },
  });
  if (!row) return { status: "NOT_FOUND" };
  return { status: "NOT_DEAD_LETTERED" };
}

// Puts an abandoned row back in front of the sweep: clears the
// dead-letter mark, makes it immediately eligible again, and resets the
// attempt budget so one more genuine failure cannot instantly re-park it.
// lastError is deliberately KEPT — the operator requeuing this needs the
// history of why it was parked in the first place.
export async function requeueDeadLetter(kind: DeadLetterKind, id: string, actor: { id: string | null; role: string }, allowedSiteId: string | null): Promise<DeadLetterActionResult> {
  // PL-R14-P2-02: no pre-read. The conditional mutation below IS the
  // authorization decision — site, existence and dead-letter state are
  // all decided by the same statement that writes.
  const missed = await prisma.$transaction(async (tx) => {
    const claim =
      kind === "AUTO_REQUISITION"
        ? await tx.pendingAutoRequisition.updateMany({
            // PL-R13-P2-01: the site condition is part of the WRITE, so a
            // row that moves to another site between an operator loading
            // the page and pressing the button cannot still be acted on.
            where: { id, deadLetteredAt: { not: null }, ...siteCondition(allowedSiteId) },
            // leaseOwner/leaseExpiresAt cleared too: a row parked while a
            // processor still nominally held it must not stay unclaimable.
            data: { deadLetteredAt: null, attempts: 0, nextAttemptAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
          })
        : allowedSiteId !== null
          ? { count: 0 } // blob deletions have no site — site-scoped callers can never act on one
          : await tx.pendingBlobDeletion.updateMany({
              where: { id, deadLetteredAt: { not: null } },
              data: { deadLetteredAt: null, attempts: 0, nextAttemptAt: new Date() },
            });
    if (claim.count === 0) return true;

    await writeAudit(tx, actor, { module: "Operations", recordId: id, field: kind, reasonCode: "DEAD_LETTER_REQUEUED" });
    return false;
  });

  // Classified only after the write matched nothing, so the refusal never
  // depends on a read taken before it.
  return missed ? classifyMiss(kind, id, allowedSiteId) : { status: "OK" };
}

// Drops the row for good. Only ever a deliberate human decision — the
// audit event is the record that the consequence was abandoned knowingly,
// which is precisely what was missing when these rows simply sat there.
export async function dismissDeadLetter(kind: DeadLetterKind, id: string, actor: { id: string | null; role: string }, allowedSiteId: string | null): Promise<DeadLetterActionResult> {
  // PL-R14-P2-02: no pre-read — the conditional delete is the single
  // authorization decision, same as requeue above.
  const missed = await prisma.$transaction(async (tx) => {
    const claim =
      kind === "AUTO_REQUISITION"
        ? // PL-R13-P2-01: site condition inside the delete itself, so a
          // row that moved to another site cannot be dropped by the old
          // site's operator.
          await tx.pendingAutoRequisition.deleteMany({ where: { id, deadLetteredAt: { not: null }, ...siteCondition(allowedSiteId) } })
        : allowedSiteId !== null
          ? { count: 0 } // blob deletions have no site — site-scoped callers can never act on one
          : await tx.pendingBlobDeletion.deleteMany({ where: { id, deadLetteredAt: { not: null } } });
    if (claim.count === 0) return true;

    await writeAudit(tx, actor, { module: "Operations", recordId: id, field: kind, reasonCode: "DEAD_LETTER_DISMISSED" });
    return false;
  });

  return missed ? classifyMiss(kind, id, allowedSiteId) : { status: "OK" };
}
