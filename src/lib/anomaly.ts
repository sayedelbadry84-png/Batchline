// A first, deliberately small step into the "AI decision layer" from the
// strategic review: no model training, no external service — just
// statistics over deviation data the app already records on every
// completed batch (BatchComponentActual). Two independent checks, because
// a scale-calibration problem shows up in different shapes:
//
// 1. OUTLIER — a single reading far outside this material's own normal
//    spread (z-score against its historical mean/stddev).
// 2. DRIFT — several of the most recent readings all leaning the same
//    direction past a minimum size, even when none of them individually
//    looks dramatic. This is closer to what a slowly-drifting scale
//    actually produces than a one-off outlier is.
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
      windowSize: number;
      thresholdPct: number;
    };

const OUTLIER_Z_THRESHOLD = 2.5;
const MIN_SAMPLES_FOR_OUTLIER = 5;
const RECENT_WINDOW_FOR_OUTLIER_CHECK = 5;
const DRIFT_WINDOW = 3;
const DRIFT_MIN_ABS_PCT = 1.5;

export function detectAnomalies(
  byMaterial: Map<string, { materialName: string; samples: DeviationSample[] }>,
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];

  for (const [materialId, { materialName, samples }] of byMaterial) {
    if (samples.length === 0) continue;
    const sortedRecentFirst = [...samples].sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());

    if (samples.length >= MIN_SAMPLES_FOR_OUTLIER) {
      const mean = samples.reduce((sum, s) => sum + s.deviationPct, 0) / samples.length;
      const variance = samples.reduce((sum, s) => sum + (s.deviationPct - mean) ** 2, 0) / samples.length;
      const stddev = Math.sqrt(variance);

      if (stddev > 0.01) {
        // Only surface anomalies among recent batches — a one-off outlier
        // from months ago isn't actionable today.
        for (const s of sortedRecentFirst.slice(0, RECENT_WINDOW_FOR_OUTLIER_CHECK)) {
          const zScore = (s.deviationPct - mean) / stddev;
          if (Math.abs(zScore) > OUTLIER_Z_THRESHOLD) {
            flags.push({
              type: "OUTLIER",
              materialId,
              materialName,
              ticketNumber: s.ticketNumber,
              deviationPct: s.deviationPct,
              zScore,
            });
          }
        }
      }
    }

    if (sortedRecentFirst.length >= DRIFT_WINDOW) {
      const recent = sortedRecentFirst.slice(0, DRIFT_WINDOW);
      const allOver = recent.every((s) => s.deviationPct > DRIFT_MIN_ABS_PCT);
      const allUnder = recent.every((s) => s.deviationPct < -DRIFT_MIN_ABS_PCT);
      if (allOver || allUnder) {
        flags.push({
          type: "DRIFT",
          materialId,
          materialName,
          ticketNumber: recent[0].ticketNumber,
          deviationPct: recent[0].deviationPct,
          direction: allOver ? "OVER" : "UNDER",
          windowSize: DRIFT_WINDOW,
          thresholdPct: DRIFT_MIN_ABS_PCT,
        });
      }
    }
  }

  return flags;
}
