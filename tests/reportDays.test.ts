// Audit 2026-10-26 P1-A and P1-C, against a real PostgreSQL database.
//
// One mixer code and one driver work at two plants in different zones
// (Riyadh, UTC+3; Cairo, UTC+2 in December) on the same local day. Reports
// must count each trip once, on its own plant's local day; the asset's
// total must be the sum of its per-plant contributions; and a REPORTS key
// bound to one site must never receive the other site's work.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
require("./setup/stubServerOnly.cjs");
if (!process.env.TEST_DATABASE_URL || process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("Set a disposable TEST_DATABASE_URL different from DATABASE_URL; refusing to guess.");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { prisma } = await import("../src/lib/prisma");
const { NextRequest } = await import("next/server");
const { hashApiKey } = await import("../src/lib/apiKeys");
const reports = await import("../src/lib/reportQueries");
const reportsRoute = await import("../src/app/api/reports/[report]/route");

const prefix = `DAYS-${randomUUID().slice(0, 8)}`;
const DAY = "2026-12-01";
const siteKey = randomUUID(); // disposable test credentials only
const globalKey = randomUUID();
const ids = { sites: [] as string[], plants: [] as string[], trucks: [] as string[], trips: [] as string[], tickets: [] as string[] };
let ruh = "", cai = "", ruhSite = "", caiSite = "", customerId = "", projectId = "", mixId = "", reservationId = "", driverId = "", userId = "";

// 0.5 m3 steps keep every expected volume exact.
const tripsAt: { plant: "ruh" | "cai"; dischargeEnd: string; volumeM3: number; inDay: boolean }[] = [
  { plant: "ruh", dischargeEnd: "2026-11-30T21:30:00.000Z", volumeM3: 6, inDay: true },   // 00:30 Riyadh, Dec 1 (UTC says Nov 30)
  { plant: "ruh", dischargeEnd: "2026-12-01T20:59:59.999Z", volumeM3: 7.5, inDay: true }, // 23:59:59.999 Riyadh
  { plant: "ruh", dischargeEnd: "2026-12-01T21:00:00.000Z", volumeM3: 9, inDay: false },  // 00:00 Riyadh, Dec 2
  { plant: "cai", dischargeEnd: "2026-11-30T21:30:00.000Z", volumeM3: 4, inDay: false },  // 23:30 Cairo, Nov 30
  { plant: "cai", dischargeEnd: "2026-12-01T21:59:59.999Z", volumeM3: 5.5, inDay: true }, // 23:59:59.999 Cairo, Dec 1
];

before(async () => {
  ruhSite = (await prisma.site.create({ data: { code: `${prefix}-R`, name: `${prefix} Riyadh`, city: "Riyadh", country: "SA" } })).id;
  caiSite = (await prisma.site.create({ data: { code: `${prefix}-C`, name: `${prefix} Cairo`, city: "Cairo", country: "EG" } })).id;
  ids.sites.push(ruhSite, caiSite);
  ruh = (await prisma.plant.create({ data: { name: `${prefix} Riyadh 1`, siteId: ruhSite, timezone: "Asia/Riyadh", currency: "SAR" } })).id;
  cai = (await prisma.plant.create({ data: { name: `${prefix} Cairo 1`, siteId: caiSite, timezone: "Africa/Cairo", currency: "EGP" } })).id;
  ids.plants.push(ruh, cai);
  userId = (await prisma.user.create({ data: { email: `${prefix}@example.invalid`, passwordHash: "test-only", name: prefix, role: "ADMIN", plantId: ruh } })).id;
  driverId = (await prisma.employee.create({ data: { plantId: ruh, name: `${prefix} driver`, code: `${prefix}-D`, role: "DRIVER" } })).id;
  customerId = (await prisma.customer.create({ data: { legalName: prefix } })).id;
  projectId = (await prisma.project.create({ data: { customerId, name: prefix, siteAddress: "Test" } })).id;
  mixId = (await prisma.mixDesign.create({ data: { code: prefix, grade: "C25", slumpTargetMm: 100, wcRatio: .5 } })).id;
  reservationId = (await prisma.reservation.create({ data: { reservationNumber: prefix, projectId, siteId: ruhSite, mixId, requestedVolumeM3: 40, originalVolumeM3: 40, pourWindowStart: new Date("2026-12-01T06:00:00Z") } })).id;
  // The same mixer, registered at each plant under the same fleet code.
  const truckAt = { ruh: (await prisma.truck.create({ data: { plantId: ruh, code: `${prefix}-M1`, drumCapacityM3: 10 } })).id, cai: (await prisma.truck.create({ data: { plantId: cai, code: `${prefix}-M1`, drumCapacityM3: 10 } })).id };
  ids.trucks.push(truckAt.ruh, truckAt.cai);
  for (const [i, t] of tripsAt.entries()) {
    const plantId = t.plant === "ruh" ? ruh : cai;
    const ticket = await prisma.batchTicket.create({ data: { reservationId, mixId, plantId, ticketNumber: `${prefix}-${i}`, volumeM3: t.volumeM3, status: "COMPLETE", releasedAt: new Date(t.dischargeEnd), batchCompletedAt: new Date(t.dischargeEnd) } });
    ids.tickets.push(ticket.id);
    const trip = await prisma.trip.create({ data: { batchTicketId: ticket.id, truckId: truckAt[t.plant], driverId, status: "CLOSED", volumeDeliveredM3: t.volumeM3, batchTime: new Date(t.dischargeEnd), dischargeEnd: new Date(t.dischargeEnd) } });
    ids.trips.push(trip.id);
  }
  await prisma.apiKey.create({ data: { siteId: ruhSite, label: prefix, keyHash: hashApiKey(siteKey), keyPrefix: "test", scope: "REPORTS", createdById: userId } });
  await prisma.apiKey.create({ data: { global: true, label: prefix, keyHash: hashApiKey(globalKey), keyPrefix: "test", scope: "REPORTS", createdById: userId } });
});

after(async () => {
  await prisma.apiKey.deleteMany({ where: { label: prefix } });
  await prisma.trip.deleteMany({ where: { id: { in: ids.trips } } });
  await prisma.batchTicket.deleteMany({ where: { id: { in: ids.tickets } } });
  await prisma.truck.deleteMany({ where: { id: { in: ids.trucks } } });
  await prisma.reservation.deleteMany({ where: { id: reservationId } });
  await prisma.mixDesign.deleteMany({ where: { id: mixId } });
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.employee.deleteMany({ where: { id: driverId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.plant.deleteMany({ where: { id: { in: ids.plants } } });
  await prisma.site.deleteMany({ where: { id: { in: ids.sites } } });
  await prisma.$disconnect();
});

const expected = (plant?: "ruh" | "cai") => tripsAt.filter((t) => t.inDay && (!plant || t.plant === plant));
const sum = (rows: { volumeM3: number }[]) => rows.reduce((s, r) => s + r.volumeM3, 0);
const mine = <T extends { code: string }>(rows: T[]) => rows.filter((r) => r.code === `${prefix}-M1`);

test("each trip counts on its own plant's local day, once", async () => {
  const both = await reports.getTripsReport({ fromDay: DAY, toDay: DAY, siteId: undefined });
  const ours = both.rows.filter((t) => ids.trips.includes(t.id));
  assert.equal(ours.length, expected().length);
  assert.equal(sum(ours.map((t) => ({ volumeM3: t.volumeDeliveredM3 ?? 0 }))), sum(expected()));

  const r = await reports.getTripsReport({ fromDay: DAY, toDay: DAY, siteId: ruhSite });
  const c = await reports.getTripsReport({ fromDay: DAY, toDay: DAY, siteId: caiSite });
  assert.equal(r.rows.length, expected("ruh").length, "00:30 Riyadh is Dec 1; 00:00 the next day is not");
  assert.equal(c.rows.length, expected("cai").length, "23:30 Cairo on Nov 30 is not Dec 1; 23:59:59.999 is");
  assert.equal(r.rows.length + c.rows.length, ours.length, "the company total is the sum of the plants");
});

test("an asset's total is the sum of its per-plant contributions", async () => {
  const report = await reports.getEquipmentProductivityReport({ fromDay: DAY, toDay: DAY });
  const [truck] = mine(report.trucks);
  assert.ok(truck, "the mixer appears once, merged across both plants");
  assert.equal(mine(report.trucks).length, 1);
  assert.equal(truck.tripCount, expected().length);
  assert.equal(truck.volumeM3, sum(expected()));
  assert.deepEqual(new Set(truck.byPlant.map((p) => p.plantId)), new Set([ruh, cai]));
  assert.equal(truck.byPlant.reduce((s, p) => s + p.tripCount, 0), truck.tripCount);
  assert.equal(truck.byPlant.reduce((s, p) => s + p.volumeM3, 0), truck.volumeM3);
  assert.equal(truck.byPlant.find((p) => p.plantId === ruh)!.volumeM3, sum(expected("ruh")));
});

test("the driver's activity across both plants is counted once each", async () => {
  const { rows } = await reports.getWorkerProductivityReport({ fromDay: DAY, toDay: DAY });
  const driver = rows.filter((r) => r.key === `MIXER_DRIVER:${prefix}-D`);
  assert.equal(driver.length, 1);
  assert.equal(driver[0].count, expected().length);
  assert.equal(driver[0].volumeM3, sum(expected()));
});

const get = (report: string, key: string, query = "") =>
  reportsRoute.GET(new NextRequest(`http://test.local/api/reports/${report}?from=${DAY}&to=${DAY}${query}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ report }) });

test("a site-scoped REPORTS key never receives another site's equipment work", async () => {
  const res = await get("equipment", siteKey);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.scope, "site");
  const [truck] = mine(body.trucks as { code: string; tripCount: number; volumeM3: number; byPlant: { plantId: string }[] }[]);
  assert.equal(truck.tripCount, expected("ruh").length);
  assert.equal(truck.volumeM3, sum(expected("ruh")));
  assert.deepEqual(truck.byPlant.map((p) => p.plantId), [ruh]);
  assert.equal((await get("equipment", siteKey, `&site=${caiSite}`)).status, 403);
  assert.equal((await get("equipment", siteKey, `&plant=${cai}`)).status, 403);
});

test("a global REPORTS key sees the company-wide total", async () => {
  const body = await (await get("equipment", globalKey)).json();
  assert.equal(body.scope, "company");
  const [truck] = mine(body.trucks as { code: string; volumeM3: number }[]);
  assert.equal(truck.volumeM3, sum(expected()));
  const cairoOnly = await (await get("equipment", globalKey, `&site=${caiSite}`)).json();
  assert.equal(mine(cairoOnly.trucks as { code: string; volumeM3: number }[])[0].volumeM3, sum(expected("cai")));
});

test("the API refuses a day that is not a calendar day", async () => {
  const res = await reportsRoute.GET(new NextRequest(`http://test.local/api/reports/trips?from=2026-02-30&to=${DAY}`, { headers: { authorization: `Bearer ${globalKey}` } }), { params: Promise.resolve({ report: "trips" }) });
  assert.equal(res.status, 400);
});
