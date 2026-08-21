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
