import { prisma } from "@/lib/prisma";

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

// Fallback for a site with no policy row configured for a given role yet
// (see updateIncentivePolicy) — free trips, no rate. Shared so a
// not-yet-configured site prices identically everywhere, rather than each
// caller inventing its own "reasonable" default.
export const DEFAULT_POLICY: IncentivePolicy = {
  freeTripsThreshold: 10,
  tier2Threshold: 15,
  tier2RateSar: 0,
  tier3Threshold: 20,
  tier3RateSar: 0,
  beyondRateSar: 20,
};

// --- Per-role activity sources — the ONE place every incentive-payout
// consumer (the Incentives module itself, and the Reports module's own
// Incentives tab) reads trip/delivery activity from. Previously
// reports/page.tsx kept its own separate copy of this logic that had
// drifted out of sync with the real one here (wrong site resolution for
// both the trip-count and volume-based roles), so the two screens could
// — and did — disagree on the same person's payout. Never duplicate this
// again; both pages call these same functions. `to` open-ended (the
// Incentives module's own "since the 1st of this month, ongoing" view)
// when omitted, bounded when Reports passes an explicit range.
//
// Each of the five incentive roles is backed by a different underlying
// record (Trip for mixer/pump crew, MaterialReceipt filtered by material
// type for bulker/water drivers). Every source is fetched company-wide (no
// plantId filter) and each entry carries its own siteId, derived from
// where the batch/receipt actually happened — never from a driver's own
// current plant assignment, since a driver can load from more than one
// plant in the same day (see the cross-plant aggregation note above). ---

async function mixerDriverTrips(from: Date, to?: Date): Promise<ActivityEntry[]> {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: from, ...(to ? { lte: to } : {}) } },
    select: {
      driverId: true,
      driver: { select: { name: true } },
      volumeDeliveredM3: true,
      batchTicket: { select: { plant: { select: { siteId: true } } } },
    },
  });
  return trips.map(
    (t): ActivityEntry => ({
      id: t.driverId,
      name: t.driver.name,
      siteId: t.batchTicket.plant.siteId,
      volumeM3: t.volumeDeliveredM3 ?? 0,
      reachM: null,
    }),
  );
}

async function pumpCrewTrips(from: Date, to: Date | undefined, crewField: "pumpOperatorId" | "pumpAssistantId"): Promise<ActivityEntry[]> {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: from, ...(to ? { lte: to } : {}) }, [crewField]: { not: null } },
    select: {
      pumpOperatorId: true,
      pumpAssistantId: true,
      pumpOperatorCrew: { select: { name: true } },
      pumpAssistantCrew: { select: { name: true } },
      volumeDeliveredM3: true,
      pump: { select: { reachM: true } },
      batchTicket: { select: { plant: { select: { siteId: true } } } },
    },
  });
  return trips
    .map((t): ActivityEntry | null => {
      const id = crewField === "pumpOperatorId" ? t.pumpOperatorId : t.pumpAssistantId;
      const name = crewField === "pumpOperatorId" ? t.pumpOperatorCrew?.name : t.pumpAssistantCrew?.name;
      if (!id || !name) return null;
      return {
        id,
        name,
        siteId: t.batchTicket.plant.siteId,
        volumeM3: t.volumeDeliveredM3 ?? 0,
        reachM: t.pump?.reachM ?? null,
      };
    })
    .filter((e): e is ActivityEntry => e !== null);
}

async function materialReceiptEntries(from: Date, to: Date | undefined, materialType: string): Promise<ActivityEntry[]> {
  const receipts = await prisma.materialReceipt.findMany({
    where: { receivedAt: { gte: from, ...(to ? { lte: to } : {}) }, material: { type: materialType } },
    select: { driverId: true, driverName: true, driver: { select: { name: true } }, netWeightKg: true, plant: { select: { siteId: true } } },
  });
  return receipts
    .map((r): ActivityEntry | null => {
      const name = r.driver?.name ?? r.driverName;
      if (!name) return null;
      return {
        id: r.driverId ?? `name:${name}`,
        name,
        siteId: r.plant.siteId,
        volumeM3: r.netWeightKg / 1000,
        reachM: null,
      };
    })
    .filter((e): e is ActivityEntry => e !== null);
}

export async function activityForRole(role: string, from: Date, to?: Date): Promise<ActivityEntry[]> {
  if (role === "MIXER_DRIVER") return mixerDriverTrips(from, to);
  if (role === "PUMP_OPERATOR") return pumpCrewTrips(from, to, "pumpOperatorId");
  if (role === "PUMP_ASSISTANT") return pumpCrewTrips(from, to, "pumpAssistantId");
  if (role === "BULKER_DRIVER") return materialReceiptEntries(from, to, "CEMENT");
  if (role === "WATER_TANKER_DRIVER") return materialReceiptEntries(from, to, "WATER");
  return [];
}

export type IncentiveSiteDatum = {
  site: Awaited<ReturnType<typeof getIncentiveSiteData>>[number]["site"];
  effectiveMethod: (role: string) => IncentiveMethodKind;
  currency: string;
};

// Every site's own incentive configuration (trip-count policy, volume/
// reach-based policy, and any per-role method override), in the one shape
// both the Incentives module and the Reports module's Incentives tab price
// against — see the activity-sources comment above for why this can never
// be allowed to drift into two copies again.
export async function getIncentiveSiteData() {
  const sites = await prisma.site.findMany({
    orderBy: { name: "asc" },
    include: {
      // currency isn't itself a Site field (still a Station one) so a
      // site's first station stands in as its representative currency —
      // every station at one real-world site is expected to actually
      // share one currency in practice.
      plants: { orderBy: { name: "asc" }, take: 1, select: { currency: true } },
      incentivePolicies: true,
      pumpIncentivePolicies: { include: { rateBrackets: { orderBy: { minReachM: "asc" } } } },
      incentiveMethods: true,
    },
  });

  return sites.map((site) => {
    const methodOverride = new Map(site.incentiveMethods.map((r) => [r.role, r.method as IncentiveMethodKind]));
    const effectiveMethod = (role: string): IncentiveMethodKind => methodOverride.get(role) ?? DEFAULT_INCENTIVE_METHOD[role];
    const currency = site.plants[0]?.currency ?? "EGP";
    return { site, effectiveMethod, currency };
  });
}

// The per-site pricing map aggregateIncentiveResults needs for one role,
// built from getIncentiveSiteData's output.
export function buildSitePricingMap(siteData: Awaited<ReturnType<typeof getIncentiveSiteData>>, role: string): Map<string, SitePricing> {
  return new Map(
    siteData.map(({ site, effectiveMethod, currency }) => {
      const volumePolicy = site.pumpIncentivePolicies.find((p) => p.role === role);
      return [
        site.id,
        {
          siteName: site.name,
          currency,
          method: effectiveMethod(role),
          tripPolicy: site.incentivePolicies.find((p) => p.role === role) ?? DEFAULT_POLICY,
          freeVolumeM3: volumePolicy?.freeVolumeM3 ?? 0,
          rateBrackets: volumePolicy?.rateBrackets ?? [],
        },
      ];
    }),
  );
}
