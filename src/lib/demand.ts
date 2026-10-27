import { addDays, zonedDayStart, zonedIsoDay } from "@/lib/plantDay";

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

// Audit 2026-10-26 P1-C: days are calendar days in `timeZone` (the
// plant's clock), not the server's. Both functions used setHours and
// toISOString, i.e. UTC on Vercel, so a 00:30 Riyadh pour landed in the
// previous day's bucket. `date` on a bucket is that day's local midnight.
export function groupReservationsByDay(
  reservations: ReservationForOutlook[],
  days: number,
  startFrom: Date,
  weekdayAverages?: number[],
  timeZone = "UTC",
): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  const firstDay = zonedIsoDay(startFrom, timeZone);

  for (let i = 0; i < days; i++) {
    const key = addDays(firstDay, i);
    buckets.set(key, { dateKey: key, date: zonedDayStart(key, timeZone), volumeM3: 0, count: 0, typicalVolumeM3: weekdayAverages ? weekdayAverages[weekdayOf(key)] : null });
  }

  for (const r of reservations) {
    if (r.remainingVolumeM3 <= 0.001) continue;
    const bucket = buckets.get(zonedIsoDay(new Date(r.pourWindowStart), timeZone));
    if (bucket) {
      bucket.volumeM3 += r.remainingVolumeM3;
      bucket.count += 1;
    }
  }

  return [...buckets.values()];
}

export type HistoricalDelivery = { date: Date; volumeM3: number };

// 0 = Sunday..6 = Saturday, for a YYYY-MM-DD calendar day.
function weekdayOf(isoDay: string): number {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Average m³ actually produced on each weekday (0 = Sunday..6 = Saturday)
// over the last `weeksBack` weeks — walks every calendar day in the
// window, including ones with zero production, so a normally-quiet Friday
// correctly pulls its own average down rather than being skipped.
export function computeWeekdayAverages(deliveries: HistoricalDelivery[], weeksBack: number, asOf: Date, timeZone = "UTC"): number[] {
  const endDay = zonedIsoDay(asOf, timeZone);
  const startDay = addDays(endDay, -weeksBack * 7);

  const byDateKey = new Map<string, number>();
  for (const d of deliveries) {
    const key = zonedIsoDay(d.date, timeZone);
    byDateKey.set(key, (byDateKey.get(key) ?? 0) + d.volumeM3);
  }

  const totals = new Array(7).fill(0);
  const occurrences = new Array(7).fill(0);
  for (let key = startDay; key < endDay; key = addDays(key, 1)) {
    const weekday = weekdayOf(key);
    totals[weekday] += byDateKey.get(key) ?? 0;
    occurrences[weekday] += 1;
  }

  return totals.map((total, i) => (occurrences[i] > 0 ? total / occurrences[i] : 0));
}
