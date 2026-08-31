// Fourth AI/decision-layer feature, and the first from the "customer &
// sustainability" layer of the strategic review: an embodied-carbon
// estimate per mix design and per completed batch, computed purely from
// data the app already has (MixComponent / BatchComponentActual masses).
//
// The factors below are typical published industry figures (the kind of
// order-of-magnitude numbers cited in concrete-industry EPD/ICE-database
// literature), NOT measured or verified for any specific supplier or
// plant — every surface that shows a number derived from this table says
// so explicitly, the same honesty discipline the Reports page already
// applies to metrics it can't back with real data.
//
// Materials also carry their own Material.co2FactorKgPerKg — prefilled
// from this table when a material is created (see createMaterial in
// suppliers/actions.ts), but always the plant's own number to override
// once they have a real supplier EPD/factor. estimateCo2eKg prefers that
// per-material figure when one is on file and only falls back to this
// generic table when it isn't — same "prefer this plant's own data, fall
// back to a disclosed generic default" posture strength-prediction.ts and
// demand.ts already use.
export const CO2E_FACTOR_KG_PER_KG: Record<string, number> = {
  CEMENT: 0.83,
  FLY_ASH: 0.015,
  SLAG: 0.1,
  SILICA_FUME: 0.02,
  SAND: 0.005,
  COARSE_AGGREGATE: 0.007,
  ADMIXTURE: 0.72,
  WATER: 0.0003,
};

export function estimateCo2eKg(materialType: string, massKg: number, materialFactorOverride?: number | null): number {
  const factor = materialFactorOverride ?? CO2E_FACTOR_KG_PER_KG[materialType];
  return factor == null ? 0 : factor * massKg;
}
