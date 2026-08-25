// Fourth AI/decision-layer feature this session: a tiered per-trip driver
// bonus, modeled on the reviewed competitor's "TripMaster" scheme. Nothing
// is stored precomputed — payout is derived live from closed Trip counts
// per driver, the same derive-from-what-already-exists approach as
// anomaly.ts, strength-prediction.ts, dispatch.ts, carbon.ts and demand.ts.
export type IncentivePolicy = {
  freeTripsThreshold: number;
  tier2Threshold: number;
  tier2RateSar: number;
  tier3Threshold: number;
  tier3RateSar: number;
  beyondRateSar: number;
};

// Trips 1..freeTripsThreshold earn nothing, each trip from there up to
// tier2Threshold earns tier2RateSar, each trip from there up to
// tier3Threshold earns tier3RateSar, and every trip beyond that earns
// beyondRateSar. Rates are always the owning plant's own currency.
export function calculateDriverPayout(tripCount: number, policy: IncentivePolicy): number {
  let remaining = Math.max(0, tripCount);
  let payout = 0;

  const freeTrips = Math.min(remaining, policy.freeTripsThreshold);
  remaining -= freeTrips;

  const tier2Trips = Math.min(remaining, Math.max(0, policy.tier2Threshold - policy.freeTripsThreshold));
  payout += tier2Trips * policy.tier2RateSar;
  remaining -= tier2Trips;

  const tier3Trips = Math.min(remaining, Math.max(0, policy.tier3Threshold - policy.tier2Threshold));
  payout += tier3Trips * policy.tier3RateSar;
  remaining -= tier3Trips;

  payout += remaining * policy.beyondRateSar;
  return payout;
}

export type DriverTripCount = {
  driverId: string;
  driverName: string;
  tripCount: number;
};

export type DriverIncentiveResult = DriverTripCount & { payout: number };

export function rankDriversByIncentive(trips: DriverTripCount[], policy: IncentivePolicy): DriverIncentiveResult[] {
  return trips
    .map((t) => ({ ...t, payout: calculateDriverPayout(t.tripCount, policy) }))
    .sort((a, b) => b.payout - a.payout || b.tripCount - a.tripCount);
}

// Volume-based incentive — priced by quantity delivered (not trip count),
// only above a company-wide "free" target, at a rate that can vary by pump
// reach. Originally pump-operator-only (names kept as PumpRateBracket/
// PumpTripVolume to avoid an unrelated rename); now the calculation any
// role's VOLUME_M3 incentive method uses (see DEFAULT_INCENTIVE_METHOD
// below) — PUMP_OPERATOR/PUMP_ASSISTANT price by the trip's real pump
// reach, every other volume-based role prices off a single flat bracket
// (minReachM 0, maxReachM null) that matches regardless of reach, reachM
// included when the role has no concept of it at all.
export type PumpRateBracket = { minReachM: number; maxReachM: number | null; ratePerM3Sar: number };
export type PumpTripVolume = { volumeM3: number; reachM: number | null };

export function calculateVolumeIncentivePayout(
  trips: PumpTripVolume[],
  freeVolumeM3: number,
  rateBrackets: PumpRateBracket[],
): number {
  let cumulative = 0;
  let payout = 0;

  for (const trip of trips) {
    const before = cumulative;
    cumulative += trip.volumeM3;
    // The slice of THIS trip's volume that falls above the free target —
    // trips are priced in the order given, so once cumulative volume
    // crosses the target, everything after (in this trip or a later one)
    // is billable.
    const billable = Math.max(0, cumulative - Math.max(before, freeVolumeM3));
    if (billable <= 0) continue;

    const bracket =
      trip.reachM == null
        ? rateBrackets.find((b) => b.minReachM <= 0 && b.maxReachM == null)
        : rateBrackets.find((b) => trip.reachM! >= b.minReachM && (b.maxReachM == null || trip.reachM! <= b.maxReachM));
    if (bracket) payout += billable * bracket.ratePerM3Sar;
  }

  return payout;
}

// Back-compat alias — every existing call site was written against the
// pump-operator-specific name; kept so this generalization doesn't force a
// simultaneous rename across every caller.
export const calculatePumpOperatorPayout = calculateVolumeIncentivePayout;

export type PumpOperatorTrips = { driverId: string; driverName: string; trips: PumpTripVolume[] };
export type PumpOperatorResult = { driverId: string; driverName: string; volumeM3: number; payout: number };

export function rankByVolumeIncentive(
  operators: PumpOperatorTrips[],
  freeVolumeM3: number,
  rateBrackets: PumpRateBracket[],
): PumpOperatorResult[] {
  return operators
    .map((o) => ({
      driverId: o.driverId,
      driverName: o.driverName,
      volumeM3: o.trips.reduce((sum, t) => sum + t.volumeM3, 0),
      payout: calculateVolumeIncentivePayout(o.trips, freeVolumeM3, rateBrackets),
    }))
    .sort((a, b) => b.payout - a.payout || b.volumeM3 - a.volumeM3);
}

export const rankPumpOperatorsByIncentive = rankByVolumeIncentive;

// The two incentive calculations a role can use — see IncentiveMethod in
// schema.prisma. Compiled default per role, overridable per plant from the
// Incentives module's "plan" tab; a role with no entry here (e.g. a brand
// new job title with no wired trip/delivery data source) has no default
// and shows as unset until an Admin explicitly assigns one.
export type IncentiveMethodKind = "TRIP_COUNT" | "VOLUME_M3";

export const DEFAULT_INCENTIVE_METHOD: Record<string, IncentiveMethodKind> = {
  MIXER_DRIVER: "TRIP_COUNT",
  PUMP_OPERATOR: "VOLUME_M3",
  PUMP_ASSISTANT: "VOLUME_M3",
  BULKER_DRIVER: "TRIP_COUNT",
  WATER_TANKER_DRIVER: "TRIP_COUNT",
};

export const INCENTIVE_ROLE_KEYS = ["MIXER_DRIVER", "PUMP_OPERATOR", "PUMP_ASSISTANT", "BULKER_DRIVER", "WATER_TANKER_DRIVER"] as const;
export type IncentiveRoleKey = (typeof INCENTIVE_ROLE_KEYS)[number];

// Reach brackets are only meaningful for the two pump roles (the trip
// data actually carries a pump reach); every other role's volume policy
// is a single flat rate, so its "add bracket" form only ever needs to
// write one row with minReachM 0 / maxReachM null.
export function isReachBasedRole(role: string): boolean {
  return role === "PUMP_OPERATOR" || role === "PUMP_ASSISTANT";
}

// --- Cross-plant aggregation ---------------------------------------------
// A driver (or pump operator/assistant) can load from more than one plant
// — even a different plant, not just a different station at the same one
// — on the same day. The incentive policy itself now lives at the plant
// level (see the schema migration note on DriverIncentivePolicy), so one
// person's period total has to be priced per-plant first, using whichever
// policy and method that specific plant has configured, then summed — the
// same price-then-merge principle invoicing already follows, applied here
// to a payout instead of a bill. Currencies are never blended: a person
// who worked plants with different currencies gets one subtotal per
// currency rather than one wrong combined number.

export type ActivityEntry = { id: string; name: string; siteId: string; volumeM3: number; reachM: number | null };

export type SitePricing = {
  siteName: string;
  currency: string;
  method: IncentiveMethodKind;
  tripPolicy: IncentivePolicy;
  freeVolumeM3: number;
  rateBrackets: PumpRateBracket[];
};

export type CurrencyAmount = { currency: string; amount: number };

export type AggregatedIncentiveResult = {
  id: string;
  name: string;
  tripCount: number;
  volumeM3: number;
  payoutByCurrency: CurrencyAmount[];
  siteNames: string[];
};

export function aggregateIncentiveResults(
  entries: ActivityEntry[],
  sitePricing: Map<string, SitePricing>,
): AggregatedIncentiveResult[] {
  const byPerson = new Map<string, { name: string; bySite: Map<string, ActivityEntry[]> }>();
  for (const e of entries) {
    if (!e.id || !e.name) continue;
    const person = byPerson.get(e.id) ?? { name: e.name, bySite: new Map<string, ActivityEntry[]>() };
    const siteEntries = person.bySite.get(e.siteId) ?? [];
    siteEntries.push(e);
    person.bySite.set(e.siteId, siteEntries);
    byPerson.set(e.id, person);
  }

  const results: AggregatedIncentiveResult[] = [];
  for (const [id, { name, bySite }] of byPerson) {
    let tripCount = 0;
    let volumeM3 = 0;
    const payoutByCurrency = new Map<string, number>();
    const siteNames: string[] = [];

    for (const [siteId, siteEntries] of bySite) {
      const pricing = sitePricing.get(siteId);
      if (!pricing) continue;
      tripCount += siteEntries.length;
      volumeM3 += siteEntries.reduce((sum, e) => sum + e.volumeM3, 0);
      siteNames.push(pricing.siteName);

      const payout =
        pricing.method === "VOLUME_M3"
          ? calculateVolumeIncentivePayout(siteEntries, pricing.freeVolumeM3, pricing.rateBrackets)
          : calculateDriverPayout(siteEntries.length, pricing.tripPolicy);

      payoutByCurrency.set(pricing.currency, (payoutByCurrency.get(pricing.currency) ?? 0) + payout);
    }

    results.push({
      id,
      name,
      tripCount,
      volumeM3,
      payoutByCurrency: Array.from(payoutByCurrency.entries()).map(([currency, amount]) => ({ currency, amount })),
      siteNames,
    });
  }

  return results.sort((a, b) => {
    const totalA = a.payoutByCurrency.reduce((s, p) => s + p.amount, 0);
    const totalB = b.payoutByCurrency.reduce((s, p) => s + p.amount, 0);
    return totalB - totalA || b.tripCount - a.tripCount;
  });
}
