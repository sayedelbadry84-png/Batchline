// The Incentives report tab's data. It lived as an inline async IIFE in
// reports/page.tsx until 2026-09-12; it is here now for the same reason
// every other report's query function is in src/lib/reportQueries.ts —
// a page should not hold its own data layer — and because the tab
// component needs a named function to take its prop type from.
import "server-only";
import {
  INCENTIVE_ROLE_KEYS,
  activityForRole,
  aggregateIncentiveResults,
  buildSitePricingMap,
  getIncentiveSiteData,
  isReachBasedRole,
} from "@/lib/incentives";

export async function getIncentivesReport(rangeStart: Date, rangeEnd: Date) {
  // Delegates to the exact same functions the Incentives module
  // itself uses (src/lib/incentives.ts) — this used to be a
  // separate, hand-rolled computation here that had drifted out
  // of sync with the real one (wrong site resolution for both
  // trip-count and volume-based roles), so the two screens could
  // show different numbers for the same person. Always
  // company-wide, same as the Incentives module and the
  // Equipment report — not scoped to the site/plant filter,
  // since a person can work more than one plant in the same
  // period (see aggregateIncentiveResults' own comment).
  //
  // Kept grouped by role, one table per job, rather than flattened
  // into one mixed list — a pump operator/assistant is priced by
  // volume poured (see isReachBasedRole / DEFAULT_INCENTIVE_METHOD
  // in src/lib/incentives.ts), so showing them next to a mixer
  // driver's trip count in the same "count" column read as if
  // everyone were priced the same way.
  const siteData = await getIncentiveSiteData();
  const byRole = await Promise.all(
    INCENTIVE_ROLE_KEYS.map(async (role) => {
      const entries = await activityForRole(role, rangeStart, rangeEnd);
      const sitePricing = buildSitePricingMap(siteData, role);
      const results = aggregateIncentiveResults(entries, sitePricing);
      const rows = results
        .map((r) => ({
          key: `${role}:${r.id}`,
          name: r.name,
          tripCount: r.tripCount,
          volumeM3: r.volumeM3,
          siteCount: r.siteNames.length,
          payout: r.payoutByCurrency.reduce((sum, p) => sum + p.amount, 0),
        }))
        .sort((a, b) => b.payout - a.payout);
      return { role, volumeBased: isReachBasedRole(role), rows };
    }),
  );
  const totalPayout = byRole.reduce((sum, g) => sum + g.rows.reduce((s, r) => s + r.payout, 0), 0);
  return { byRole, totalPayout };
}
