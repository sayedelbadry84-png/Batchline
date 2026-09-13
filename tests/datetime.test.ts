import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ABSENT,
  DISPLAY_LOCALE,
  FALLBACK_TIME_ZONE,
  createDateFormatters,
  formatDate,
  formatDateTime,
  formatTime,
  isValidTimeZone,
  resolveTimeZone,
} from "../src/lib/datetime";

// No database needed — this is the regression guard for the defect where
// every server-rendered timestamp was formatted in the Node process's UTC
// clock instead of the plant's.

// 2026-09-12T22:30:00Z is 2026-09-13 01:30 in Cairo (UTC+3 in September,
// Egypt having restored DST) and 2026-09-13 01:30 in Riyadh (UTC+3, no
// DST). Picked deliberately so the instant falls on a DIFFERENT CALENDAR
// DAY from UTC — the old behaviour did not just shift the clock, it dated
// a night-shift load to the wrong day.
const NIGHT_SHIFT = new Date("2026-09-12T22:30:00.000Z");

test("a timestamp renders in the plant's clock, not the server's UTC", () => {
  // The bug: with no timeZone argument this reads 12/09/2026, 22:30 on
  // Vercel. A load discharged after midnight in Cairo was filed as the
  // previous day's work.
  assert.equal(formatDateTime(NIGHT_SHIFT, "Africa/Cairo"), "13/09/2026, 01:30");
  assert.equal(formatDateTime(NIGHT_SHIFT, "UTC"), "12/09/2026, 22:30");
  assert.notEqual(
    formatDateTime(NIGHT_SHIFT, "Africa/Cairo"),
    formatDateTime(NIGHT_SHIFT, "UTC"),
    "if these ever match, the test instant no longer proves anything",
  );
});

test("two plants in different zones read the same instant differently", () => {
  assert.equal(formatDateTime(NIGHT_SHIFT, "Asia/Riyadh"), "13/09/2026, 01:30");
  assert.equal(formatDateTime(NIGHT_SHIFT, "Europe/London"), "12/09/2026, 23:30");
});

test("dates are day-first, so 09/12 is never read as September", () => {
  // The Node default locale is en-US, which rendered this as 9/12/2026 —
  // ambiguous for every Egyptian and Saudi user of this app.
  assert.equal(DISPLAY_LOCALE, "en-GB");
  assert.equal(formatDate("2026-09-12T09:00:00.000Z", "Africa/Cairo"), "12/09/2026");
});

test("time is 24-hour", () => {
  assert.equal(formatTime("2026-09-12T14:05:00.000Z", "UTC"), "14:05");
  assert.equal(formatTime("2026-09-12T00:05:00.000Z", "UTC"), "00:05");
});

test("an unparseable value renders as absent, never as 'Invalid Date'", () => {
  // Intl formats an invalid Date as the literal string "Invalid Date",
  // which on a delivery note looks like a field that was filled in.
  assert.equal(formatDateTime("not a date", "UTC"), ABSENT);
  assert.equal(formatDate(new Date(Number.NaN), "UTC"), ABSENT);
  assert.equal(formatTime(Number.NaN, "UTC"), ABSENT);
});

test("a mistyped plant timezone falls back instead of throwing", () => {
  // Plant.timezone is admin-typed free text on /plants. Intl throws a
  // RangeError on an unknown zone, and a page that 500s because someone
  // typed "Africa/Ciaro" is a worse failure than one that falls back.
  assert.equal(isValidTimeZone("Africa/Cairo"), true);
  assert.equal(isValidTimeZone("Africa/Ciaro"), false);
  assert.equal(resolveTimeZone("Africa/Ciaro"), FALLBACK_TIME_ZONE);
  assert.equal(resolveTimeZone(""), FALLBACK_TIME_ZONE);
  assert.equal(resolveTimeZone("   "), FALLBACK_TIME_ZONE);
  assert.equal(resolveTimeZone(null), FALLBACK_TIME_ZONE);
  assert.equal(resolveTimeZone(undefined), FALLBACK_TIME_ZONE);
  assert.equal(resolveTimeZone(" Asia/Riyadh "), "Asia/Riyadh");
  assert.doesNotThrow(() => createDateFormatters("nonsense/zone").dateTime(NIGHT_SHIFT));
});

test("the fallback matches Plant.timezone's own schema default", () => {
  // If the schema default ever changes, this fails rather than letting
  // the two drift apart silently.
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  assert.match(schema, new RegExp(`timezone\\s+String\\s+@default\\("${FALLBACK_TIME_ZONE}"\\)`));
});

test("createDateFormatters binds one zone across every helper", () => {
  const f = createDateFormatters("Asia/Riyadh");
  assert.equal(f.timeZone, "Asia/Riyadh");
  assert.equal(f.date(NIGHT_SHIFT), "13/09/2026");
  assert.equal(f.dateTime(NIGHT_SHIFT), "13/09/2026, 01:30");
  assert.equal(f.time(NIGHT_SHIFT), "01:30");
  // Deliberately numeric: CLDR's abbreviated month names shift between
  // ICU versions ("Sep" vs "Sept" for en-GB), so asserting one would make
  // this test depend on the Node build rather than on our own code.
  assert.equal(f.with(NIGHT_SHIFT, { month: "2-digit", year: "numeric" }), "09/2026");
});

// ---------------------------------------------------------------- guard

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Date.prototype.toLocale* is the defect itself, so nothing may reach for
// it again. Number.prototype.toLocaleString is a different method that
// happens to share a name — it formats money and is not in scope here —
// so the guard matches only receivers that are dates.
//
// Written as a test rather than an ESLint rule because the distinction is
// the RECEIVER's type, which a syntactic lint rule cannot see.
// "Month" is deliberately absent from the suffix list: `invoicedThisMonth`
// is a money total, and a guard that fires on it teaches people to work
// around the guard.
const DATE_RECEIVER = /(new Date\([^)]*\)|\b\w*(?:At|Date|Time|Start|End|Deadline|Day|On)\b)\s*[?!]?\s*\.toLocale(String|DateString|TimeString)\(/;

test("no source file formats a date with toLocale* directly", () => {
  const offenders: string[] = [];
  for (const file of walk(join(process.cwd(), "src"))) {
    if (file.endsWith(join("lib", "datetime.ts"))) continue; // the one legitimate home
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (DATE_RECEIVER.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `format dates through src/lib/datetime.ts (a page gets its formatters from getDateFormatters, a client component from a timeZone prop):\n${offenders.join("\n")}`,
  );
});

test("the formatter bundle is never handed to a Client Component", () => {
  // Functions are not serializable across the RSC boundary — the exact
  // defect commit 5776765 removed from FleetMap. A client component takes
  // `timeZone` as a string and builds its own formatters.
  const offenders: string[] = [];
  for (const file of walk(join(process.cwd(), "src"))) {
    const source = readFileSync(file, "utf8");
    if (!/^\s*"use client";/m.test(source)) continue;
    if (/from "@\/lib\/displayTimeZone"/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `client components must not import the server-only formatter bundle:\n${offenders.join("\n")}`);
});
