// Audit 2026-10-26 P1-C: report days are the plant's local calendar day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, coveringRange, isIsoDay, plantWindows, zonedDayRange, zonedDayStart, zonedIsoDay } from "../src/lib/plantDay";

const iso = (d: Date) => d.toISOString();

test("a Riyadh day starts at 21:00 UTC the evening before", () => {
  assert.equal(iso(zonedDayStart("2026-10-26", "Asia/Riyadh")), "2026-10-25T21:00:00.000Z");
  const r = zonedDayRange("2026-10-26", "2026-10-26", "Asia/Riyadh");
  assert.equal(iso(r.start), "2026-10-25T21:00:00.000Z");
  assert.equal(iso(r.end), "2026-10-26T21:00:00.000Z");
});

test("00:30 in Riyadh (21:30 UTC) belongs to the next local day", () => {
  const pour = new Date("2026-10-25T21:30:00Z");
  assert.equal(zonedIsoDay(pour, "Asia/Riyadh"), "2026-10-26");
  const day = zonedDayRange("2026-10-26", "2026-10-26", "Asia/Riyadh");
  assert.ok(pour >= day.start && pour < day.end);
  // The old server-zone (UTC) range put it on the 25th.
  const oldStart = new Date("2026-10-26T00:00:00Z");
  assert.ok(pour < oldStart);
});

test("the last fraction of a second of the day is inside, midnight is not", () => {
  const day = zonedDayRange("2026-10-26", "2026-10-26", "Asia/Riyadh");
  const lastMs = new Date(day.end.getTime() - 1);
  assert.ok(lastMs >= day.start && lastMs < day.end, "23:59:59.999 is counted (the old lte 23:59:59 dropped it)");
  assert.ok(!(day.end < day.end), "the next midnight is excluded");
  assert.equal(day.end.getTime() - day.start.getTime(), 24 * 3600_000);
});

test("Cairo follows its own offset, including summer time", () => {
  // Egypt observes DST (UTC+3) from late April to late October, UTC+2 otherwise.
  assert.equal(iso(zonedDayStart("2026-07-15", "Africa/Cairo")), "2026-07-14T21:00:00.000Z");
  assert.equal(iso(zonedDayStart("2026-12-15", "Africa/Cairo")), "2026-12-14T22:00:00.000Z");
  for (const day of ["2026-04-24", "2026-04-25", "2026-10-29", "2026-10-30"]) {
    const r = zonedDayRange(day, day, "Africa/Cairo");
    assert.equal(zonedIsoDay(r.start, "Africa/Cairo"), day);
    assert.equal(zonedIsoDay(new Date(r.end.getTime() - 1), "Africa/Cairo"), day);
    assert.equal(zonedIsoDay(r.end, "Africa/Cairo"), addDays(day, 1));
  }
});

test("two plants in different zones get their own windows; the company total is their sum", () => {
  const windows = plantWindows([{ id: "ruh", timezone: "Asia/Riyadh" }, { id: "cai", timezone: "Africa/Cairo" }], "2026-12-01", "2026-12-01");
  const ruh = windows.find((w) => w.plantId === "ruh")!;
  const cai = windows.find((w) => w.plantId === "cai")!;
  assert.equal(iso(ruh.start), "2026-11-30T21:00:00.000Z");
  assert.equal(iso(cai.start), "2026-11-30T22:00:00.000Z");
  // A mixer's trips at both plants on the same local day.
  const trips = [
    { plantId: "ruh", at: new Date("2026-11-30T21:30:00Z") }, // 00:30 Riyadh, Dec 1
    { plantId: "cai", at: new Date("2026-11-30T21:30:00Z") }, // 23:30 Cairo, Nov 30: not Dec 1
    { plantId: "cai", at: new Date("2026-12-01T21:59:59.999Z") }, // 23:59:59.999 Cairo, Dec 1
    { plantId: "ruh", at: new Date("2026-12-01T21:00:00Z") }, // 00:00 Riyadh, Dec 2
  ];
  const counted = trips.filter((t) => windows.some((w) => w.plantId === t.plantId && t.at >= w.start && t.at < w.end));
  assert.equal(counted.length, 2);
  const perPlant = windows.map((w) => trips.filter((t) => t.plantId === w.plantId && t.at >= w.start && t.at < w.end).length);
  assert.equal(perPlant.reduce((a, b) => a + b, 0), counted.length, "no trip lost or counted twice");
  const cover = coveringRange(windows)!;
  assert.equal(iso(cover.start), "2026-11-30T21:00:00.000Z");
  assert.equal(iso(cover.end), "2026-12-01T22:00:00.000Z");
});

test("only real calendar days are accepted", () => {
  assert.equal(isIsoDay("2026-02-28"), true);
  for (const bad of ["2026-02-30", "2026-13-01", "26-10-26", "2026-10-26T00:00", "", null, undefined]) assert.equal(isIsoDay(bad), false, String(bad));
  assert.throws(() => zonedDayStart("2026-02-30", "Asia/Riyadh"), RangeError);
});
