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

// Pump operator incentive is priced differently from the other four
// roles: by m³ delivered (not trip count), only above a company-wide
// "free" target, and at a rate that depends on the reach of the specific
// pump each trip used — a 60m boom job and a 30m job earn differently
// even at the same volume. rateBrackets covers each reach with its own
// price; a trip whose pump has no matching bracket (or no reach on file)
// earns nothing rather than guessing a rate.
export type PumpRateBracket = { minReachM: number; maxReachM: number | null; ratePerM3Sar: number };
export type PumpTripVolume = { volumeM3: number; reachM: number | null };

export function calculatePumpOperatorPayout(
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
    if (billable <= 0 || trip.reachM == null) continue;

    const bracket = rateBrackets.find(
      (b) => trip.reachM! >= b.minReachM && (b.maxReachM == null || trip.reachM! <= b.maxReachM),
    );
    if (bracket) payout += billable * bracket.ratePerM3Sar;
  }

  return payout;
}

export type PumpOperatorTrips = { driverId: string; driverName: string; trips: PumpTripVolume[] };
export type PumpOperatorResult = { driverId: string; driverName: string; volumeM3: number; payout: number };

export function rankPumpOperatorsByIncentive(
  operators: PumpOperatorTrips[],
  freeVolumeM3: number,
  rateBrackets: PumpRateBracket[],
): PumpOperatorResult[] {
  return operators
    .map((o) => ({
      driverId: o.driverId,
      driverName: o.driverName,
      volumeM3: o.trips.reduce((sum, t) => sum + t.volumeM3, 0),
      payout: calculatePumpOperatorPayout(o.trips, freeVolumeM3, rateBrackets),
    }))
    .sort((a, b) => b.payout - a.payout || b.volumeM3 - a.volumeM3);
}
