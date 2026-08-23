// A first, deliberately small step into the "AI decision layer" from the
// strategic review: no model training, no external service — just
// statistics over deviation data the app already records on every
// completed batch (BatchComponentActual). Two independent checks, because
// a scale-calibration problem shows up in different shapes:
//
// 1. OUTLIER — a single reading far outside this material's own normal
//    spread (z-score against its historical mean/stddev).
// 2. DRIFT — a sustained small shift in the mean, caught with a CUSUM
//    (cumulative sum) control chart — the standard SPC technique for this
//    exact problem, and a better fit than "N in a row on the same side"
//    for what a slowly-drifting scale actually produces: individually
//    unremarkable readings that keep leaning the same way just enough to
//    accumulate into a real problem.
export type DeviationSample = {
  ticketNumber: string;
  completedAt: Date;
  deviationPct: number;
};

export type AnomalyFlag =
  | {
      type: "OUTLIER";
      materialId: string;
      materialName: string;
      ticketNumber: string;
      deviationPct: number;
      zScore: number;
    }
  | {
      type: "DRIFT";
      materialId: string;
      materialName: string;
      ticketNumber: string;
      deviationPct: number;
      direction: "OVER" | "UNDER";
      cusumPct: number;
    };

const OUTLIER_Z_THRESHOLD = 2.5;
const MIN_SAMPLES_FOR_OUTLIER = 5;
const RECENT_WINDOW_FOR_OUTLIER_CHECK = 5;

// Classic Montgomery/SPC-textbook CUSUM defaults, in units of the
// material's own historical standard deviation: k (the "allowance" or
// slack) absorbs ordinary noise so it doesn't accumulate into a false
// signal, h (the decision interval) is calibrated to reliably catch a
// sustained ~1σ shift in the mean without a high false-alarm rate.
const CUSUM_K_SIGMA = 0.5;
const CUSUM_H_SIGMA = 4;
const MIN_SAMPLES_FOR_DRIFT = 5;
// A drift signal only fires today if it crossed the threshold within this
// many of the most recent batches — an old, since-corrected drift from
// months ago isn't actionable now.
const DRIFT_RECENCY_WINDOW = 8;

type CusumSignal = { index: number; direction: "OVER" | "UNDER"; magnitude: number };

// Standard two-sided CUSUM: walks the samples oldest-first, accumulating
// how far each reading sits from the mean beyond the allowance k, and
// reports the LAST time either side crossed the decision interval h
// (resetting after each signal, per standard practice) — a pure function
// rather than a closured loop so the "found or not" result type stays
// straightforward to narrow.
function findLastCusumSignal(samplesOldFirst: DeviationSample[], mean: number, k: number, h: number): CusumSignal | null {
  let sPlus = 0;
  let sMinus = 0;
  let last: CusumSignal | null = null;
  for (let i = 0; i < samplesOldFirst.length; i++) {
    const x = samplesOldFirst[i].deviationPct - mean;
    sPlus = Math.max(0, sPlus + x - k);
    sMinus = Math.min(0, sMinus + x + k);
    if (sPlus > h) {
      last = { index: i, direction: "OVER", magnitude: sPlus };
      sPlus = 0;
    } else if (Math.abs(sMinus) > h) {
      last = { index: i, direction: "UNDER", magnitude: Math.abs(sMinus) };
      sMinus = 0;
    }
  }
  return last;
}

export function detectAnomalies(
  byMaterial: Map<string, { materialName: string; samples: DeviationSample[] }>,
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  for (const [materialId, { materialName, samples }] of byMaterial) {
    if (samples.length === 0) continue;
    const sortedRecentFirst = [...samples].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
    const sortedOldFirst = [...sortedRecentFirst].reverse();

    if (samples.length < MIN_SAMPLES_FOR_OUTLIER) continue;

    const mean = samples.reduce((sum, s) => sum + s.deviationPct, 0) / samples.length;
    const variance = samples.reduce((sum, s) => sum + (s.deviationPct - mean) ** 2, 0) / samples.length;
    const stddev = Math.sqrt(variance);
    if (stddev <= 0.01) continue;

    // Only surface outliers among recent batches — a one-off outlier from
    // months ago isn't actionable today.
    for (const s of sortedRecentFirst.slice(0, RECENT_WINDOW_FOR_OUTLIER_CHECK)) {
      const zScore = (s.deviationPct - mean) / stddev;
      if (Math.abs(zScore) > OUTLIER_Z_THRESHOLD) {
        flags.push({ type: "OUTLIER", materialId, materialName, ticketNumber: s.ticketNumber, deviationPct: s.deviationPct, zScore });
      }
    }

    if (sortedOldFirst.length >= MIN_SAMPLES_FOR_DRIFT) {
      const k = CUSUM_K_SIGMA * stddev;
      const h = CUSUM_H_SIGMA * stddev;
      const lastSignal = findLastCusumSignal(sortedOldFirst, mean, k, h);

      if (lastSignal && lastSignal.index >= sortedOldFirst.length - DRIFT_RECENCY_WINDOW) {
        const signalSample = sortedOldFirst[lastSignal.index];
        flags.push({
          type: "DRIFT",
          materialId,
          materialName,
          ticketNumber: signalSample.ticketNumber,
          deviationPct: signalSample.deviationPct,
          direction: lastSignal.direction,
          cusumPct: lastSignal.magnitude,
        });
      }
    }
  }

  return flags;
}
