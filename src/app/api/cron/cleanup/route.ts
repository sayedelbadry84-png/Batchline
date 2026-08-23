import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
  if (auth !== `Bearer ${configuredSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const now = new Date();
  const staleLoginAttemptCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const abandonedTotpSetupCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

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
  ]);

  return NextResponse.json({
    ranAt: now.toISOString(),
    expiredSessionsDeleted: expiredSessions.count,
    staleLoginAttemptsDeleted: staleLoginAttempts.count,
    abandonedTotpSetupsCleared: abandonedTotpSetups.count,
  });
}
