/**
 * Every date shown in this app is formatted HERE, with an explicit time
 * zone and an explicit locale. Nothing calls `Date.prototype.toLocale*`
 * directly any more — `tests/datetime.test.ts` enforces that.
 *
 * Why this module exists
 * ---------------------
 * `toLocaleString()` with no arguments formats in the *runtime's* time
 * zone and locale. In a Server Component that runtime is the Node process
 * on Vercel, which runs in UTC. So a dispatcher in Cairo or Riyadh read
 * every batch-completion time, GPS ping and delivery-note timestamp two
 * or three hours earlier than it actually happened — silently, with no
 * indication the value had been shifted. On a screen where "when was this
 * truck last seen" and "when did this load discharge" are operational
 * decisions, that is a real defect, not a cosmetic one.
 *
 * The same call in a Client Component formats in the *browser's* time
 * zone, so the identical value rendered differently depending on which
 * side of the RSC boundary happened to render it. A printed delivery note
 * or an invoice must not say different things to different readers.
 *
 * What "correct" means here
 * -------------------------
 * Not the viewer's device time zone — the PLANT's. Batchline records
 * physical events at a concrete batching plant: a load is discharged at
 * 14:30 plant time whether the person reading the record is on site, at
 * head office, or abroad. `Plant.timezone` already exists in the schema,
 * is editable on /plants, and is audited when changed — it was simply
 * never read by any rendering code. This module is what finally reads it.
 *
 * Locale is fixed to en-GB rather than following the UI language. Two
 * reasons: the codebase already chose it explicitly at nineteen call
 * sites, and every one of these values is rendered in a `font-mono
 * tabular` cell marked `dir="ltr"`, which the Arabic locale's
 * Arabic-Indic digits would break. Day-first also removes the real
 * ambiguity the bare default left behind — the Node default is en-US, so
 * "09/12/2026" meant September to the server and December to every
 * Egyptian and Saudi user reading it.
 */

// Nullish is accepted on purpose. A great many of these columns are
// optional (dischargeEnd, approvedAt, licenseExpiry...), and before this
// module every page open-coded its own `x ? fmt(x) : "—"` guard — thirteen
// near-identical `fmtDate` helpers existed across the app, three of which
// had already drifted to a different placeholder. Handling absence in one
// place is what let all of them be deleted.
export type DateInput = Date | string | number | null | undefined;

// Matches Plant.timezone's own default in schema.prisma. Used when a user
// has no plant (ADMIN) or a plant carries a time zone the runtime's ICU
// build does not recognise.
export const FALLBACK_TIME_ZONE = "Africa/Cairo";

// Deliberately not the UI locale — see the module comment.
export const DISPLAY_LOCALE = "en-GB";

const DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

/**
 * A time zone reaching this module comes from an admin-typed free-text
 * field on /plants, so it can be a typo. `Intl.DateTimeFormat` throws a
 * RangeError on an unknown zone, and a page that crashes because someone
 * mistyped "Africa/Ciaro" is a worse failure than one that falls back.
 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(zone: string | null | undefined): string {
  const trimmed = zone?.trim();
  if (!trimmed) return FALLBACK_TIME_ZONE;
  return isValidTimeZone(trimmed) ? trimmed : FALLBACK_TIME_ZONE;
}

// Intl.DateTimeFormat construction is the expensive part, not format().
// These pages render hundreds of cells from the same few shapes, so the
// formatters are built once per (zone, options) pair and reused.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, { ...options, timeZone });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/**
 * An absent or invalid Date formats as the string "Invalid Date" through Intl,
 * which would land in a delivery note looking like real data. Returning
 * an em dash keeps a bad value visibly absent instead of plausible.
 */
function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const ABSENT = "—";

export function formatWith(value: DateInput, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const date = toDate(value);
  if (!date) return ABSENT;
  return formatterFor(timeZone, options).format(date);
}

/** "12/09/2026" */
export function formatDate(value: DateInput, timeZone: string): string {
  return formatWith(value, timeZone, DATE_OPTIONS);
}

/** "12/09/2026, 14:30" */
export function formatDateTime(value: DateInput, timeZone: string): string {
  return formatWith(value, timeZone, { ...DATE_OPTIONS, ...TIME_OPTIONS });
}

/** "14:30" */
export function formatTime(value: DateInput, timeZone: string): string {
  return formatWith(value, timeZone, TIME_OPTIONS);
}

// "12/09, 14:30" — the dispatch board and the reservations calendar both
// show same-week work, where the year is noise and the weekday is not.
const DAY_TIME_OPTIONS: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", ...TIME_OPTIONS };

export function formatDayTime(value: DateInput, timeZone: string): string {
  return formatWith(value, timeZone, DAY_TIME_OPTIONS);
}

/**
 * The set of formatters bound to one plant's time zone, handed to a page
 * as a single value so call sites read `f.dateTime(x)` rather than
 * threading the zone through every one of them.
 *
 * Every field is a plain function, so this object is NOT serializable
 * across the RSC boundary — passing it to a Client Component is exactly
 * the bug commit 5776765 fixed. A Client Component takes the `timeZone`
 * string as a prop and calls `createDateFormatters` itself.
 */
export type DateFormatters = {
  timeZone: string;
  date: (value: DateInput) => string;
  dateTime: (value: DateInput) => string;
  time: (value: DateInput) => string;
  dayTime: (value: DateInput) => string;
  with: (value: DateInput, options: Intl.DateTimeFormatOptions) => string;
};

export function createDateFormatters(zone: string | null | undefined): DateFormatters {
  const timeZone = resolveTimeZone(zone);
  return {
    timeZone,
    date: (value) => formatDate(value, timeZone),
    dateTime: (value) => formatDateTime(value, timeZone),
    time: (value) => formatTime(value, timeZone),
    dayTime: (value) => formatDayTime(value, timeZone),
    with: (value, options) => formatWith(value, timeZone, options),
  };
}
