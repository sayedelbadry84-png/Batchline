// Fifth AI/decision-layer feature, from the strategic review's demand-
// forecasting idea — but scoped to what's honestly knowable: the app has
// no order history deep enough yet to fit a meaningful statistical
// forecast (unlike anomaly detection or strength prediction, which lean
// on data that accumulates from day one of production). What it *does*
// have, reliably, is the confirmed reservation pipeline itself — real
// committed demand, not a guess — which is exactly what a plant manager
// needs to see to avoid a stockout on a day that's already booked.
export type ReservationForOutlook = {
  pourWindowStart: Date;
  remainingVolumeM3: number;
};

export type DayBucket = {
  dateKey: string;
  date: Date;
  volumeM3: number;
  count: number;
};

export function groupReservationsByDay(
  reservations: ReservationForOutlook[],
  days: number,
  startFrom: Date,
): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  const start = new Date(startFrom);
  start.setHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { dateKey: key, date: d, volumeM3: 0, count: 0 });
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
