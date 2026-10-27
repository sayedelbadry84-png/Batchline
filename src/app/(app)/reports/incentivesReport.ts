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

export type CurrencyAmount = { currency: string; amount: number };

// Audit 2026-10-26 P1-A: a payout is kept per currency. Summing SAR and
// EGP into one number, as this used to, produced a total that is neither.
function addByCurrency(into: Map<string, number>, items: CurrencyAmount[]) {
  for (const p of items) into.set(p.currency, (into.get(p.currency) ?? 0) + p.amount);
}
const sortedAmounts = (m: Map<string, number>): CurrencyAmount[] =>
  [...m].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency));

// fromDay/toDay are calendar days; each trip counts on the local day of the
// plant it was batched at (audit P1-C, see activityForRole).
export async function getIncentivesReport(fromDay: string, toDay: string) {
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
      const entries = await activityForRole(role, { fromDay, toDay });
      const sitePricing = buildSitePricingMap(siteData, role);
      const results = aggregateIncentiveResults(entries, sitePricing);
      const rows = results
        .map((r) => ({
          key: `${role}:${r.id}`,
          name: r.name,
          tripCount: r.tripCount,
          volumeM3: r.volumeM3,
          siteCount: r.siteNames.length,
          payoutByCurrency: r.payoutByCurrency.filter((p) => p.amount !== 0),
        }))
        // Sorted by the largest single-currency amount; amounts in two
        // currencies are never added to rank them.
        .sort((a, b) => Math.max(0, ...b.payoutByCurrency.map((p) => p.amount)) - Math.max(0, ...a.payoutByCurrency.map((p) => p.amount)));
      return { role, volumeBased: isReachBasedRole(role), rows };
    }),
  );
  const total = new Map<string, number>();
  for (const g of byRole) for (const r of g.rows) addByCurrency(total, r.payoutByCurrency);
  return { byRole, totalPayoutByCurrency: sortedAmounts(total) };
}
