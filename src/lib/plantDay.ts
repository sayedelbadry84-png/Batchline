import { resolveTimeZone } from "@/lib/datetime";

// Audit 2026-10-26 P1-C: which instants belong to a calendar day at a plant.
//
// Report ranges used to be built with `new Date("YYYY-MM-DDT00:00:00")` and
// `T23:59:59`, i.e. in the server's zone (UTC on Vercel), and "today" came
// from `toISOString().slice(0, 10)`. A pour completed at 00:30 in Riyadh
// (21:30 UTC the evening before) was counted on the wrong day, and the
// 23:59:59 end dropped the last second of every day.
//
// The owner's rule (2026-10-26): a day is the local calendar day of the
// plant where the work happened, from Plant.timezone. A report that spans
// several plants applies each plant's own day, then adds the results up.
// A range here is always half-open, [start, end): use `gte` and `lt`.

export type UtcRange = { start: Date; end: Date };
export type PlantWindow = UtcRange & { plantId: string };

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDay(value: string | undefined | null): value is string {
  if (!value) return false;
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// The UTC offset of `zone` at `instant`, in minutes (Riyadh: +180).
function offsetMinutes(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

// The instant local midnight starts `isoDay` in `zone`. Two passes settle
// the offset across a DST change; a zone that skips midnight (none of
// ours do today) lands on the first instant that exists.
export function zonedDayStart(isoDay: string, zone: string): Date {
  if (!isIsoDay(isoDay)) throw new RangeError(`Not a calendar day: ${isoDay}`);
  const tz = resolveTimeZone(zone);
  const [y, m, d] = isoDay.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d);
  let guess = naive - offsetMinutes(new Date(naive), tz) * 60_000;
  guess = naive - offsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess);
}

export function addDays(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// [local midnight of `fromDay`, local midnight after `toDay`) in `zone`.
export function zonedDayRange(fromDay: string, toDay: string, zone: string): UtcRange {
  return { start: zonedDayStart(fromDay, zone), end: zonedDayStart(addDays(toDay, 1), zone) };
}

// The calendar day an instant falls on in `zone`, as YYYY-MM-DD.
export function zonedIsoDay(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: resolveTimeZone(zone), year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

// One window per plant, each in that plant's own zone.
export function plantWindows(plants: { id: string; timezone: string }[], fromDay: string, toDay: string): PlantWindow[] {
  return plants.map((p) => ({ plantId: p.id, ...zonedDayRange(fromDay, toDay, p.timezone) }));
}

// The smallest UTC range covering every window: a cheap pre-filter for an
// index, never the filter itself.
export function coveringRange(windows: UtcRange[]): UtcRange | null {
  if (windows.length === 0) return null;
  return {
    start: new Date(Math.min(...windows.map((w) => w.start.getTime()))),
    end: new Date(Math.max(...windows.map((w) => w.end.getTime()))),
  };
}

// PM review 2026-10-27 P2-2: Reservation.pourWindowStart is NOT an instant
// in this sense. It is entered with <input type="datetime-local"> and
// parsed by `new Date(raw)` on the server, whose zone is UTC on Vercel, so
// the stored value is the plant's wall-clock time labelled as UTC (a 23:00
// Riyadh pour is stored as 23:00Z). Its calendar day is therefore the UTC
// day of the stored value, and a day window over it is UTC midnight to UTC
// midnight of the plant's local date. Applying a zone to it shifts it by
// the plant's offset. Use these helpers for that field only, until the
// input is parsed in the plant's zone and history is migrated (an owner
// decision: it changes stored data).
export function wallClockDayStart(isoDay: string): Date {
  if (!isIsoDay(isoDay)) throw new RangeError(`Not a calendar day: ${isoDay}`);
  return new Date(`${isoDay}T00:00:00.000Z`);
}
