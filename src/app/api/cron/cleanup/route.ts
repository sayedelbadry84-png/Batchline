import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { safeEqual } from "@/lib/integration-auth";
import { retryPendingBlobDeletions } from "@/lib/blob";
import { retryPendingAutoRequisitions } from "@/lib/materialRequisition";

// Daily housekeeping (see vercel.json) — the "background job" half of what
// this app was missing at scale: instead of a paid queue/Redis (not
// justified yet at a single plant's data volume — see the note on this in
// the reports/caching discussion), Vercel's own free Cron feature hits
// this route on a schedule to do the sweeping that was previously only
// ever opportunistic (a lazy per-lookup expiry check in session.ts, a
// prune-on-every-write in rateLimit.ts). Both of those stay as they are
// for the in-request fast path; this is the actual guaranteed sweep.
//
// Vercel signs cron requests with `Authorization: Bearer $CRON_SECRET`
// when that env var is set — set CRON_SECRET in the Vercel project's
// environment variables (same idea as INTEGRATION_API_KEY) so this fails
// closed rather than being an open, unauthenticated endpoint.
export async function GET(request: NextRequest) {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "Cron endpoint not configured (CRON_SECRET unset)." }, { status: 503 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${configuredSecret}`)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const now = new Date();
  const staleLoginAttemptCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const abandonedTotpSetupCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // A SENT quote whose validUntil has passed was previously just left
  // sitting there forever — nothing ever flipped its status, so
  // recordQuoteResponse would still happily accept/decline a stale price
  // offer, and the Sales board had no way to tell "still open" from
  // "customer's gone quiet past the deadline" without a human checking
  // every date by eye. Only SENT quotes are touched — DRAFT has no
  // customer-facing deadline yet, and ACCEPTED/DECLINED/EXPIRED are
  // already final.
  const staleQuotes = await prisma.quote.findMany({
    where: { status: "SENT", validUntil: { lt: now } },
    select: { id: true },
  });

  const [expiredSessions, staleLoginAttempts, abandonedTotpSetups] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: staleLoginAttemptCutoff } } }),
    // A 2FA setup the user started (totpTempSecret set) and never
    // confirmed within a day — clears the unused secret rather than
    // leaving it sitting on the account indefinitely.
    prisma.user.updateMany({
      where: { totpTempSecret: { not: null }, totpEnabled: false, updatedAt: { lt: abandonedTotpSetupCutoff } },
      data: { totpTempSecret: null },
    }),
    prisma.pendingTwoFactor.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);

  // One audit event per quote, same as every other status change in Sales
  // (markQuoteSent, recordQuoteResponse), written by the SYSTEM actor (a
  // cron request carries no user session).
  //
  // Audit 2026-10-26 P2-D: the claim and its audit row commit together, one
  // transaction per quote. The audit used to be a separate write after the
  // claim, so a failed insert left the quote EXPIRED with no record of why,
  // and the throw ended the whole sweep before the queues below ran. Now a
  // failed audit rolls its own claim back (the quote stays SENT and the next
  // run retries it), it is counted in quotesExpiryFailed, and the other
  // quotes and sweeps still run.
  let quotesExpired = 0;
  let quotesExpiryFailed = 0;
  for (const q of staleQuotes) {
    try {
      const won = await prisma.$transaction(async (tx) => {
        // A response may have accepted this quote since the scan. Never
        // overwrite a terminal status or audit an expiration that lost.
        const claim = await tx.quote.updateMany({ where: { id: q.id, status: "SENT", validUntil: { lt: now } }, data: { status: "EXPIRED" } });
        if (claim.count === 0) return false;
        await writeAudit(tx, null, { module: "Sales", recordId: q.id, field: "status", beforeValue: "SENT", afterValue: "EXPIRED", reasonCode: "QUOTE_AUTO_EXPIRED" });
        return true;
      });
      if (won) quotesExpired++;
    } catch (error) {
      quotesExpiryFailed++;
      console.error("[cron/cleanup] quote expiry rolled back", { quoteId: q.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // PL-R9-P2-02, ninth production-lifecycle review: durable retry for a
  // delivery-photo blob whose compensating delete itself failed — see
  // PendingBlobDeletion's own comment in schema.prisma. Runs after the
  // DB-only sweeps above so a slow/failing blob-storage retry never
  // delays session/login-attempt/quote housekeeping ahead of it.
  const blobDeletions = await retryPendingBlobDeletions();

  // PL-R9-P2-03, ninth production-lifecycle review: durable retry for
  // completeBatch's own best-effort auto-requisition follow-up — see
  // PendingAutoRequisition's own comment in schema.prisma.
  const autoRequisitions = await retryPendingAutoRequisitions();

  // PL-R12-P2-02/P2-03, twelfth production-lifecycle review: the full
  // structured counts, not just attempted/succeeded. bookkeepingFailed
  // and deadLettered are the two an operator actually has to act on — a
  // sweep that resolved nothing and dead-lettered rows previously looked
  // identical here to a completely clean run.
  return NextResponse.json({
    ranAt: now.toISOString(),
    expiredSessionsDeleted: expiredSessions.count,
    staleLoginAttemptsDeleted: staleLoginAttempts.count,
    abandonedTotpSetupsCleared: abandonedTotpSetups.count,
    // `quotesExpired` counts the expirations that actually WON their
    // conditional claim above, not the size of the pre-scan — the same
    // "count what committed, never what was attempted" rule the two
    // queue sweeps below report by (see QueueSweepCounts).
    quotesExpired,
    // Expirations whose transaction failed and rolled back; non-zero means
    // an operator should read the logs. Those quotes are still SENT.
    quotesExpiryFailed,
    pendingBlobDeletions: blobDeletions,
    pendingAutoRequisitions: autoRequisitions,
  });
}
