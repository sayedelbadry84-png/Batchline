import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { safeEqual } from "@/lib/integration-auth";

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
  // (markQuoteSent, recordQuoteResponse) — logAudit resolves to actor
  // "SYSTEM" on its own here since a cron request carries no user session.
  let quotesExpired = 0;
  for (const q of staleQuotes) {
    // A response may have accepted this quote since the scan. Never
    // overwrite a terminal status or audit an expiration that lost.
    const claim = await prisma.quote.updateMany({ where: { id: q.id, status: "SENT", validUntil: { lt: now } }, data: { status: "EXPIRED" } });
    if (claim.count === 0) continue;
    quotesExpired++;
    await logAudit({ module: "Sales", recordId: q.id, afterValue: "EXPIRED", reasonCode: "QUOTE_AUTO_EXPIRED" });
  }

  return NextResponse.json({
    ranAt: now.toISOString(),
    expiredSessionsDeleted: expiredSessions.count,
    staleLoginAttemptsDeleted: staleLoginAttempts.count,
    abandonedTotpSetupsCleared: abandonedTotpSetups.count,
    quotesExpired,
  });
}
