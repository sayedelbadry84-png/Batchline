// Third AI-decision-layer feature: rank the trucks available for a batch
// ticket's assign-truck picker by how well their drum capacity fits the
// ticket's volume, instead of a plain alphabetical list. Pure function,
// no external data — same "prove it with what the app already tracks"
// approach as anomaly detection and strength prediction.
export type TruckOption = {
  id: string;
  code: string;
  drumCapacityM3: number;
  defaultDriverId?: string | null;
};

export type RankedTruck = TruckOption & {
  surplusM3: number;
  undersized: boolean;
  recommended: boolean;
};

// Generic over T so callers can pass extra fields through (e.g. plant/site
// info for the assign-truck picker's label) without losing them off the
// return type — the function only ever reads the TruckOption fields, but
// preserves everything else via the spread below, same as it always did
// at runtime; this just lets the type system agree.
export function rankTrucksForVolume<T extends TruckOption>(trucks: T[], volumeM3: number): (T & { surplusM3: number; undersized: boolean; recommended: boolean })[] {
  const withFit = trucks.map((t) => ({
    ...t,
    surplusM3: t.drumCapacityM3 - volumeM3,
    undersized: t.drumCapacityM3 < volumeM3,
  }));

  // Best fit first among trucks that can carry the whole load in one go
  // (smallest leftover capacity — not wasting a big truck on a small
  // load); trucks too small for the load sorted largest-first among
  // themselves, since the biggest of the too-small options comes closest.
  const adequate = withFit.filter((t) => !t.undersized).sort((a, b) => a.surplusM3 - b.surplusM3);
  const undersized = withFit.filter((t) => t.undersized).sort((a, b) => b.drumCapacityM3 - a.drumCapacityM3);

  return [...adequate, ...undersized].map((t, i) => ({ ...t, recommended: i === 0 && !t.undersized }));
}
