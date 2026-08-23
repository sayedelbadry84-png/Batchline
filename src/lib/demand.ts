// Fifth AI/decision-layer feature, from the strategic review's demand-
// forecasting idea — but scoped to what's honestly knowable: the app has
// no order history deep enough yet to fit a meaningful statistical
// forecast (unlike anomaly detection or strength prediction, which lean
// on data that accumulates from day one of production). What it *does*
// have, reliably, is the confirmed reservation pipeline itself — real
// committed demand, not a guess — which is exactly what a plant manager
// needs to see to avoid a stockout on a day that's already booked.
//
// Alongside that, computeWeekdayAverages adds real historical context: not
// a prediction, just "what a typical day like this one has actually looked
// like" over the last several weeks of completed production — so a
// Tuesday booked at 20 m³ can be flagged as unusually light against a
// 55 m³ typical Tuesday, without ever pretending to forecast beyond what's
// already on the books.
export type ReservationForOutlook = {
  pourWindowStart: Date;
  remainingVolumeM3: number;
};

export type DayBucket = {
  dateKey: string;
  date: Date;
  volumeM3: number;
  count: number;
  typicalVolumeM3: number | null;
};

export function groupReservationsByDay(
  reservations: ReservationForOutlook[],
  days: number,
  startFrom: Date,
  weekdayAverages?: number[],
): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  const start = new Date(startFrom);
  start.setHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { dateKey: key, date: d, volumeM3: 0, count: 0, typicalVolumeM3: weekdayAverages ? weekdayAverages[d.getDay()] : null });
  }

  for (const r of reservations) {
    if (r.remainingVolumeM3 <= 0.001) continue;
    const key = new Date(r.pourWindowStart).toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.volumeM3 += r.remainingVolumeM3;
      bucket.count += 1;
    }
  }

  return [...buckets.values()];
}

export type HistoricalDelivery = { date: Date; volumeM3: number };

// Average m³ actually produced on each weekday (0 = Sunday..6 = Saturday)
// over the last `weeksBack` weeks — walks every calendar day in the
// window, including ones with zero production, so a normally-quiet Friday
// correctly pulls its own average down rather than being skipped.
export function computeWeekdayAverages(deliveries: HistoricalDelivery[], weeksBack: number, asOf: Date): number[] {
  const end = new Date(asOf);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - weeksBack * 7);

  const byDateKey = new Map<string, number>();
  for (const d of deliveries) {
    const key = d.date.toISOString().slice(0, 10);
    byDateKey.set(key, (byDateKey.get(key) ?? 0) + d.volumeM3);
  }

  const totals = new Array(7).fill(0);
  const occurrences = new Array(7).fill(0);
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const weekday = d.getDay();
    totals[weekday] += byDateKey.get(key) ?? 0;
    occurrences[weekday] += 1;
  }

  return totals.map((total, i) => (occurrences[i] > 0 ? total / occurrences[i] : 0));
}
