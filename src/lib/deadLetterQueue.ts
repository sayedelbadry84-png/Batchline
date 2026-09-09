import "server-only";
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
  const skip = Math.max(0, page) * pageSize;
  const [requisitions, blobs, total] = await Promise.all([
    prisma.pendingAutoRequisition.findMany({
      where: { deadLetteredAt: { not: null }, ...(allowedSiteId === null ? {} : { siteId: allowedSiteId }) },
      orderBy: { deadLetteredAt: "desc" },
      skip,
      take: pageSize,
    }),
    allowedSiteId === null
      ? prisma.pendingBlobDeletion.findMany({ where: { deadLetteredAt: { not: null } }, orderBy: { deadLetteredAt: "desc" }, skip, take: pageSize })
      : Promise.resolve([]),
    countDeadLetters(allowedSiteId),
  ]);

  const rows = [
    ...requisitions.map((r) => ({
      kind: "AUTO_REQUISITION" as const,
      id: r.id,
      subject: r.requisitionNumber ?? r.materialName ?? r.materialId,
      reason: r.requisitionId ? "NOTIFICATION_UNDELIVERED" : "REQUISITION_NOT_OPENED",
      attempts: r.attempts,
      lastError: r.lastError,
      deadLetteredAt: r.deadLetteredAt!,
      siteId: r.siteId,
    })),
    ...blobs.map((b) => ({
      kind: "BLOB_DELETION" as const,
      id: b.id,
      subject: b.url,
      reason: b.reason,
      attempts: b.attempts,
      lastError: b.lastError,
      deadLetteredAt: b.deadLetteredAt!,
      siteId: null,
    })),
  ].sort((a, b) => b.deadLetteredAt.getTime() - a.deadLetteredAt.getTime());

  return { rows, total, page: Math.max(0, page), pageSize };
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

// A scope mismatch resolves to NOT_FOUND, never a distinct "forbidden" —
// the same convention every other domain command in this app uses, so a
// caller with no authority over a row can't even learn it exists.
async function inScope(kind: DeadLetterKind, id: string, allowedSiteId: string | null): Promise<{ ok: true; siteId: string | null } | { ok: false }> {
  if (kind === "AUTO_REQUISITION") {
    const row = await prisma.pendingAutoRequisition.findUnique({ where: { id }, select: { siteId: true, deadLetteredAt: true } });
    if (!row) return { ok: false };
    if (allowedSiteId !== null && row.siteId !== allowedSiteId) return { ok: false };
    return { ok: true, siteId: row.siteId };
  }
  // Blob deletions have no site to scope by — org-wide callers only, same
  // rule listDeadLetters applies.
  if (allowedSiteId !== null) return { ok: false };
  const row = await prisma.pendingBlobDeletion.findUnique({ where: { id }, select: { deadLetteredAt: true } });
  return row ? { ok: true, siteId: null } : { ok: false };
}

// Puts an abandoned row back in front of the sweep: clears the
// dead-letter mark, makes it immediately eligible again, and resets the
// attempt budget so one more genuine failure cannot instantly re-park it.
// lastError is deliberately KEPT — the operator requeuing this needs the
// history of why it was parked in the first place.
export async function requeueDeadLetter(kind: DeadLetterKind, id: string, actor: { id: string | null; role: string }, allowedSiteId: string | null): Promise<DeadLetterActionResult> {
  const scope = await inScope(kind, id, allowedSiteId);
  if (!scope.ok) return { status: "NOT_FOUND" };

  return prisma.$transaction(async (tx) => {
    const claim =
      kind === "AUTO_REQUISITION"
        ? await tx.pendingAutoRequisition.updateMany({
            // PL-R13-P2-01, thirteenth production-lifecycle review: the
            // site condition is part of the WRITE, not only of the
            // separate inScope() read above. Checking scope and then
            // writing on `id` alone left a window where the row's siteId
            // could change in between, letting the old site's operator
            // act on a row that had already moved to another site.
            where: { id, deadLetteredAt: { not: null }, ...siteCondition(allowedSiteId) },
            // leaseOwner/leaseExpiresAt cleared too: a row parked while a
            // processor still nominally held it must not stay unclaimable.
            data: { deadLetteredAt: null, attempts: 0, nextAttemptAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
          })
        : await tx.pendingBlobDeletion.updateMany({
            where: { id, deadLetteredAt: { not: null } },
            data: { deadLetteredAt: null, attempts: 0, nextAttemptAt: new Date() },
          });
    if (claim.count === 0) return { status: "NOT_DEAD_LETTERED" as const };

    await writeAudit(tx, actor, { module: "Operations", recordId: id, field: kind, reasonCode: "DEAD_LETTER_REQUEUED" });
    return { status: "OK" as const };
  });
}

// Drops the row for good. Only ever a deliberate human decision — the
// audit event is the record that the consequence was abandoned knowingly,
// which is precisely what was missing when these rows simply sat there.
export async function dismissDeadLetter(kind: DeadLetterKind, id: string, actor: { id: string | null; role: string }, allowedSiteId: string | null): Promise<DeadLetterActionResult> {
  const scope = await inScope(kind, id, allowedSiteId);
  if (!scope.ok) return { status: "NOT_FOUND" };

  return prisma.$transaction(async (tx) => {
    const claim =
      kind === "AUTO_REQUISITION"
        ? // PL-R13-P2-01: site condition inside the delete itself, same
          // reasoning as requeue above — a row that moved to another site
          // between the scope read and this write must not be droppable
          // by the old site's operator.
          await tx.pendingAutoRequisition.deleteMany({ where: { id, deadLetteredAt: { not: null }, ...siteCondition(allowedSiteId) } })
        : await tx.pendingBlobDeletion.deleteMany({ where: { id, deadLetteredAt: { not: null } } });
    if (claim.count === 0) return { status: "NOT_DEAD_LETTERED" as const };

    await writeAudit(tx, actor, { module: "Operations", recordId: id, field: kind, reasonCode: "DEAD_LETTER_DISMISSED" });
    return { status: "OK" as const };
  });
}
