// Second AI-decision-layer feature (see src/lib/anomaly.ts for the first):
// a 7/14/28-day concrete cylinder break isn't known until weeks after the
// pour, which is too late to act on a problem batch. This estimates the
// eventual late-age result from an early-age reading — a linear fit
// against this plant's own historical (early, final) pairs once there are
// enough of them, falling back to widely-cited generic strength-gain
// ratios (ACI-style curing curves) when there isn't. No external model,
// no external call — just the LabResult data the app already records.
export type HistoricalPair = { ageDays: number; earlyMpa: number; finalMpa: number };

export type PredictionMethod =
  | { kind: "REGRESSION"; sampleCount: number; rSquared: number }
  | { kind: "DEFAULT_RATIO"; ratio: number };

export type StrengthPrediction = {
  predictedFinalMpa: number;
  method: PredictionMethod;
  atRisk: boolean;
};

// rSquared is the standard coefficient-of-determination: how much of the
// variation in final strength this plant's own early-age readings actually
// explain, on a 0-1 scale. A prediction built on 3 samples is technically
// a regression, but rSquared is what tells a quality supervisor whether to
// trust it or wait for more data — the sample count alone doesn't say that.
type RegressionFit = { slope: number; intercept: number; count: number; rSquared: number };

// Only ages QC actually samples at in practice — an odd age (e.g. day 5)
// isn't worth guessing at with so little grounding.
const SUPPORTED_AGES = new Set([3, 7, 14]);

// Rough, widely-cited rule-of-thumb fractions of 28-day strength typical
// OPC concrete reaches by these ages — a starting point only, meant to be
// displaced by this plant's own fitted data as soon as there's enough of it.
const DEFAULT_RATIO_BY_AGE: Record<number, number> = { 3: 0.4, 7: 0.65, 14: 0.85 };

const MIN_PAIRS_FOR_REGRESSION = 3;

export function fitRegressionsByAge(pairs: HistoricalPair[]): Map<number, RegressionFit> {
  const byAge = new Map<number, HistoricalPair[]>();
  for (const p of pairs) {
    if (!SUPPORTED_AGES.has(p.ageDays)) continue;
    const arr = byAge.get(p.ageDays) ?? [];
    arr.push(p);
    byAge.set(p.ageDays, arr);
  }

  const fits = new Map<number, RegressionFit>();
  for (const [age, samples] of byAge) {
    if (samples.length < MIN_PAIRS_FOR_REGRESSION) continue;

    const n = samples.length;
    const sumX = samples.reduce((s, p) => s + p.earlyMpa, 0);
    const sumY = samples.reduce((s, p) => s + p.finalMpa, 0);
    const sumXY = samples.reduce((s, p) => s + p.earlyMpa * p.finalMpa, 0);
    const sumXX = samples.reduce((s, p) => s + p.earlyMpa * p.earlyMpa, 0);
    const sumYY = samples.reduce((s, p) => s + p.finalMpa * p.finalMpa, 0);
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-6) continue; // degenerate (identical x values) — fall back to the default ratio

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    const denomY = n * sumYY - sumY * sumY;
    const rSquared = denomY > 1e-6 ? ((n * sumXY - sumX * sumY) ** 2) / (denom * denomY) : 0;

    fits.set(age, { slope, intercept, count: n, rSquared });
  }
  return fits;
}

// referenceTargetMpa is whatever target the QC engineer logged alongside
// this early-age reading — the app has no separate "28-day design target"
// field to fall back on, so this is the most honest reference available
// rather than one this function invents.
export function predictFinalStrength(
  ageDays: number,
  earlyMpa: number,
  referenceTargetMpa: number,
  fits: Map<number, RegressionFit>,
): StrengthPrediction | null {
  if (!SUPPORTED_AGES.has(ageDays)) return null;

  const fit = fits.get(ageDays);
  let predictedFinalMpa: number;
  let method: PredictionMethod;
  if (fit) {
    predictedFinalMpa = fit.slope * earlyMpa + fit.intercept;
    method = { kind: "REGRESSION", sampleCount: fit.count, rSquared: fit.rSquared };
  } else {
    const ratio = DEFAULT_RATIO_BY_AGE[ageDays];
    predictedFinalMpa = earlyMpa / ratio;
    method = { kind: "DEFAULT_RATIO", ratio };
  }

  return { predictedFinalMpa, method, atRisk: predictedFinalMpa < referenceTargetMpa };
}
