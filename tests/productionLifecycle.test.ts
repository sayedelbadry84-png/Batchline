// Real PostgreSQL integration tests for the production/trip lifecycle
// domain layer (src/lib/tripAssignment.ts, src/lib/tripLifecycle.ts,
// src/lib/tripDispatch.ts) — first written for the first production-
// lifecycle review (BATCHLINE_PRODUCTION_LIFECYCLE_REVIEW_ROUND1.md) and
// extended for the second (…ROUND2.md). Same TEST_DATABASE_URL-must-
// differ-from-DATABASE_URL safety gate as tests/batchCompletion.test.ts
// and tests/reservationMixRevision.test.ts — see those files' own header
// comments for the full rationale.
//
// Fixture isolation: every fixture this file creates uses the
// "TEST-SUITE-PL-" prefix, distinct from every other suite's own prefix.
// Teardown deletes ONLY the ids tracked in the arrays below, in FK-safe
// order, never a name-prefix sweep.
//
// Scope note (same as reservationMixRevision.test.ts's own): this file
// proves the DOMAIN layer. Permission refusal and the Server Action
// wrappers' own thin parsing (production/actions.ts, trips/actions.ts,
// quality/actions.ts) are not reachable from a plain node:test process —
// every fix that needed to be independently testable was extracted into
// a pure domain function that takes its actor/scope as plain parameters
// (startTripForTicket, reassignTrip, advanceTripState, closeTripFullForId,
// closeTripWithReturnForId, decideWasteIncidentMemo,
// setDrumReturnFateForId), matching the same split already established
// for closeReservationForId/releaseTicketForReservation. dispatchTrip
// below calls startTripForTicket directly — the one real production
// domain command — rather than hand-assembling a paraphrase of it
// (PL-R2-P2-06, second production-lifecycle review).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

createRequire(import.meta.url)("./setup/stubServerOnly.cjs");

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must be set to run these tests — see prisma/MIGRATIONS.md. Refusing to guess a database.");
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — refusing to run destructive tests against what may be a real database.");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { PrismaClient, Prisma } = await import("@prisma/client");
const { startTripForTicket } = await import("../src/lib/tripDispatch");
const { reassignTrip } = await import("../src/lib/tripAssignment");
const {
  advanceTripState,
  closeTripFullForId,
  closeTripWithReturnForId,
  decideWasteIncidentMemo,
  setDrumReturnFateForId,
  reportTripDelayForId,
  attachDeliveryPhotoForId,
} = await import("../src/lib/tripLifecycle");
const { completeBatchTicket, cancelBatchTicket } = await import("../src/lib/batchCompletion");
const { closeReservationForId, getRemainingVolumeM3 } = await import("../src/lib/reservations");
const { releaseTicketForReservation } = await import("../src/lib/reservationRelease");

const prisma = new PrismaClient();
// A second, independent connection — needed for the genuine two-
// connection races below (Plant transfer vs. dispatch, and the crew
// advisory lock under plain READ COMMITTED) where two real backends
// must hold locks against each other, not just two logical calls
// sharing one connection pool.
const prisma2 = new PrismaClient();

let siteId: string;
let plantId: string;
let siteBId: string;
let plantBId: string;
let materialId: string;
let siloId: string;
let mixId: string;
let projectId: string;
let customerId: string;
let adminUserId: string;

const reservationIds: string[] = [];
const ticketIds: string[] = [];
const truckIds: string[] = [];
const employeeIds: string[] = [];
const pumpIds: string[] = [];
const crewIds: string[] = [];
const tripIds: string[] = [];
const drumReturnIds: string[] = [];
const wasteMemoIds: string[] = [];
// Dedicated Plant rows created by individual tests below (PL-R5-P2-06's
// selected-truck/pump transfer races need a truck/pump on its OWN plant,
// separate from the shared fixture plant every other test's ticket
// lives on) — deleted after truckIds/pumpIds, before the two fixture
// plants, same FK-safe ordering as the rest of this teardown.
const extraPlantIds: string[] = [];

before(async () => {
  const site = await prisma.site.create({ data: { code: `TEST-SUITE-PL-${Date.now()}`, name: "TEST-SUITE-PL-SITE-A", city: "Test", country: "Test" } });
  siteId = site.id;
  const plant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-PL-PLANT-A" } });
  plantId = plant.id;

  const siteB = await prisma.site.create({ data: { code: `TEST-SUITE-PL-B-${Date.now()}`, name: "TEST-SUITE-PL-SITE-B", city: "Test", country: "Test" } });
  siteBId = siteB.id;
  const plantB = await prisma.plant.create({ data: { siteId: siteBId, name: "TEST-SUITE-PL-PLANT-B" } });
  plantBId = plantB.id;

  const material = await prisma.material.create({ data: { name: "TEST-SUITE-PL-CEMENT", type: "CEMENT" } });
  materialId = material.id;
  const silo = await prisma.silo.create({
    data: { plantId, name: "TEST-SUITE-PL-SILO", materialType: "CEMENT", materialId, capacityTons: 500, currentLevelTons: 200, minThresholdPct: 15 },
  });
  siloId = silo.id;

  const customer = await prisma.customer.create({ data: { legalName: "TEST-SUITE-PL-CUSTOMER", creditLimit: 999999 } });
  customerId = customer.id;
  const project = await prisma.project.create({ data: { name: "TEST-SUITE-PL-PROJECT", customerId, siteAddress: "Test Address" } });
  projectId = project.id;
  const mix = await prisma.mixDesign.create({
    data: { code: `TEST-SUITE-PL-MIX-${Date.now()}`, grade: "C25", slumpTargetMm: 100, wcRatio: 0.5, components: { create: [{ materialId, designMassKgPerM3: 300 }] } },
  });
  mixId = mix.id;

  const admin = await prisma.user.create({
    data: { email: `test-suite-pl-admin-${Date.now()}@example.invalid`, name: "TEST-SUITE-PL-ADMIN", passwordHash: "not-a-real-hash", role: "ADMIN" },
  });
  adminUserId = admin.id;
});

function isRecordNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2025";
}

async function cleanupDelete(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
}

// Deletes every AuditEvent this file's own actor ever wrote, regardless
// of which recordId it was written against (trips, drum returns, waste
// memos, and reservations all get their own audit events from the
// domain calls this suite makes) — a single by-actor sweep instead of a
// per-recordId tracking list that's easy to under-track and leave an
// AuditEvent row referencing a User this teardown is about to delete
// (AuditEvent.actorId -> User is an optional FK; Postgres nulls it via
// an UPDATE when the User row is deleted, and that UPDATE is exactly
// what the new immutability trigger exists to block outside this
// bypass).
async function deleteAuditEventsByActor(actorId: string) {
  await prisma.$transaction([prisma.$executeRaw`SET LOCAL app.bypass_audit_event_immutability = 'on'`, prisma.auditEvent.deleteMany({ where: { actorId } })]);
}

async function deleteMovements(sourceId: string) {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.bypass_movement_immutability = 'on'`,
    prisma.inventoryMovement.deleteMany({ where: { sourceType: "BatchTicket", sourceId } }),
  ]);
}

after(async () => {
  await deleteAuditEventsByActor(adminUserId);
  for (const id of wasteMemoIds) await cleanupDelete(() => prisma.wasteIncidentMemo.delete({ where: { id } }));
  for (const id of drumReturnIds) await cleanupDelete(() => prisma.drumReturn.delete({ where: { id } }));
  // PL-R9-P1-02, ninth production-lifecycle review: TripDelayReport.tripId
  // has no ON DELETE CASCADE — the new driver-ownership-race tests
  // (PL-R8-P1-04) create real TripDelayReport rows, and CI proved the
  // trip delete below failed a real FK violation without this first.
  if (tripIds.length > 0) await cleanupDelete(() => prisma.tripDelayReport.deleteMany({ where: { tripId: { in: tripIds } } }));
  for (const id of tripIds) await cleanupDelete(() => prisma.trip.delete({ where: { id } }));
  for (const id of ticketIds) {
    await deleteMovements(id);
    await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: id } });
    await cleanupDelete(() => prisma.batchTicket.delete({ where: { id } }));
  }
  for (const id of reservationIds) await cleanupDelete(() => prisma.reservation.delete({ where: { id } }));
  for (const id of truckIds) await cleanupDelete(() => prisma.truck.delete({ where: { id } }));
  for (const id of employeeIds) await cleanupDelete(() => prisma.employee.delete({ where: { id } }));
  for (const id of pumpIds) await cleanupDelete(() => prisma.pump.delete({ where: { id } }));
  for (const id of crewIds) await cleanupDelete(() => prisma.pumpCrewMember.delete({ where: { id } }));
  for (const id of extraPlantIds) await cleanupDelete(() => prisma.plant.delete({ where: { id } }));

  await cleanupDelete(() => prisma.mixDesign.delete({ where: { id: mixId } }));
  await cleanupDelete(() => prisma.silo.delete({ where: { id: siloId } }));
  await cleanupDelete(() => prisma.material.delete({ where: { id: materialId } }));
  await cleanupDelete(() => prisma.project.delete({ where: { id: projectId } }));
  await cleanupDelete(() => prisma.customer.delete({ where: { id: customerId } }));
  await cleanupDelete(() => prisma.user.delete({ where: { id: adminUserId } }));
  await cleanupDelete(() => prisma.plant.delete({ where: { id: plantId } }));
  await cleanupDelete(() => prisma.plant.delete({ where: { id: plantBId } }));
  await cleanupDelete(() => prisma.site.delete({ where: { id: siteId } }));
  await cleanupDelete(() => prisma.site.delete({ where: { id: siteBId } }));

  // Zero-residue assertion (same acceptance standard as the other two
  // suites) — only counts rows under THIS file's own unique prefix.
  const leftoverSites = await prisma.site.count({ where: { name: { startsWith: "TEST-SUITE-PL-" } } });
  assert.equal(leftoverSites, 0, "productionLifecycle.test.ts left residue behind");

  // PL-R9-P1-02: explicit count, not just reliance on the trip delete
  // loop above throwing on an FK violation — the review's own acceptance
  // criterion #3 calls out delay reports by name as a zero-residue check
  // this suite must prove, not merely fail loudly if violated.
  const leftoverDelayReports = await prisma.tripDelayReport.count({ where: { tripId: { in: tripIds } } });
  assert.equal(leftoverDelayReports, 0, "productionLifecycle.test.ts left TripDelayReport residue behind");

  await prisma.$disconnect();
  await prisma2.$disconnect();
});

// Polls pg_stat_activity to PROVE a backend is genuinely blocked waiting
// on a real Postgres lock, rather than a fixed-duration sleep guessing
// that it probably is by now — same pattern already established in
// tests/reservationMixRevision.test.ts's own waitUntilBlockedOnLock. A
// generous ceiling (10s) so a genuinely broken lock fails the test
// instead of hanging forever.
async function waitUntilBlockedOn(queryFragment: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ pid: number }[]>(
      `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%' || $1 || '%' AND pid <> pg_backend_pid()`,
      queryFragment,
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for a backend to be observed genuinely blocked on: ${queryFragment}`);
}

type Outcome<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

// PL-R5-P1-01, fifth production-lifecycle review: a PrismaPromise is
// LAZY — merely holding a reference to `prisma.trip.update(...)` does not
// send the query. The four lock-order tests below used to poll
// pg_stat_activity for a blocked backend before ever attaching a
// `.then`/await to the competing query, so there was sometimes no
// competing backend for the poll to observe at all, and the held
// transaction (Prisma's own 5s default interactive-transaction timeout)
// could close before the competing query was even dispatched. Wrapping
// the query in `.then(...)` immediately — right where it's created, not
// after the poll — both starts it eagerly and attaches a rejection
// handler up front, so an expected database rejection can never surface
// as an `unhandledRejection` while this settles.
function startObserved<T>(query: Promise<T>): Promise<Outcome<T>> {
  return query.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  );
}

// ---- Fixture helpers --------------------------------------------------

async function makeReservation(overrides: Partial<{ siteId: string; deliveryMethod: string; minPumpReachM: number; requestedVolumeM3: number }> = {}) {
  const now = new Date();
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `TEST-SUITE-PL-RES-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      projectId,
      siteId: overrides.siteId ?? siteId,
      mixId,
      requestedVolumeM3: overrides.requestedVolumeM3 ?? 16,
      originalVolumeM3: overrides.requestedVolumeM3 ?? 16,
      pourWindowStart: now,
      status: "CONFIRMED",
      initialApprovedAt: now,
      initialApprovedById: adminUserId,
      finalApprovedAt: now,
      finalApprovedById: adminUserId,
      deliveryMethod: overrides.deliveryMethod ?? "CHUTE",
      minPumpReachM: overrides.minPumpReachM ?? null,
    },
  });
  reservationIds.push(reservation.id);
  return reservation.id;
}

async function makeTicket(reservationId: string, overrides: Partial<{ plantId: string; volumeM3: number }> = {}) {
  const ticket = await prisma.batchTicket.create({
    data: {
      reservationId,
      mixId,
      plantId: overrides.plantId ?? plantId,
      ticketNumber: `TEST-SUITE-PL-BT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      volumeM3: overrides.volumeM3 ?? 8,
      status: "COMPLETE",
      batchCompletedAt: new Date(),
      components: { create: [{ materialId, targetMassKg: (overrides.volumeM3 ?? 8) * 300 }] },
    },
  });
  ticketIds.push(ticket.id);
  return ticket.id;
}

async function makeTruck(overrides: Partial<{ plantId: string; status: string; drumCapacityM3: number }> = {}) {
  const truck = await prisma.truck.create({
    data: { plantId: overrides.plantId ?? plantId, code: `TEST-SUITE-PL-TRK-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, drumCapacityM3: overrides.drumCapacityM3 ?? 12, status: overrides.status ?? "ACTIVE" },
  });
  truckIds.push(truck.id);
  return truck.id;
}

async function makeDriver(overrides: Partial<{ plantId: string; status: string }> = {}) {
  const employee = await prisma.employee.create({
    data: { plantId: overrides.plantId ?? plantId, name: `TEST-SUITE-PL-DRV-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, role: "DRIVER", status: overrides.status ?? "ACTIVE" },
  });
  employeeIds.push(employee.id);
  return employee.id;
}

async function makePump(overrides: Partial<{ plantId: string; status: string; reachM: number | null }> = {}) {
  // "reachM" in overrides, not `overrides.reachM ?? 30` — an explicit
  // `reachM: null` (a pump with genuinely unknown reach, PL-R2-P2-03)
  // must NOT fall through to the 30 default the way `??` would collapse
  // it to.
  const reachM = "reachM" in overrides ? overrides.reachM : 30;
  const pump = await prisma.pump.create({
    data: { plantId: overrides.plantId ?? plantId, code: `TEST-SUITE-PL-PMP-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, pumpType: "LINE", hourlyRate: 100, status: overrides.status ?? "ACTIVE", reachM },
  });
  pumpIds.push(pump.id);
  return pump.id;
}

async function makeCrew(role: "OPERATOR" | "HELPER", overrides: Partial<{ plantId: string; status: string }> = {}) {
  const crew = await prisma.pumpCrewMember.create({
    data: { plantId: overrides.plantId ?? plantId, name: `TEST-SUITE-PL-CREW-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, role, status: overrides.status ?? "ACTIVE" },
  });
  crewIds.push(crew.id);
  return crew.id;
}

// Calls the REAL production domain command (src/lib/tripDispatch.ts) —
// the exact function startTrip's own Server Action calls, not a
// hand-assembled paraphrase of claimTripSlot+claimTripResources+
// trip.create that could silently diverge from it (PL-R2-P2-06, second
// production-lifecycle review). truckId/driverId/pump* are the only
// per-call choices; volume, delivery method, and minimum reach all come
// from the real ticket/reservation rows this file's own fixtures
// created, exactly as startTripForTicket itself reads them.
async function dispatchTrip(
  ticketId: string,
  opts: {
    truckId: string;
    driverId: string;
    allowedSiteId?: string | null;
    pumpId?: string | null;
    pumpOperatorId?: string | null;
    pumpAssistantId?: string | null;
  },
) {
  return startTripForTicket(ticketId, {
    truckId: opts.truckId,
    driverId: opts.driverId,
    pumpId: opts.pumpId ?? null,
    pumpOperatorId: opts.pumpOperatorId ?? null,
    pumpAssistantId: opts.pumpAssistantId ?? null,
    allowedSiteId: opts.allowedSiteId ?? null,
    actorId: adminUserId,
    actorRole: "ADMIN",
  });
}

function actor(role = "ADMIN") {
  return { actorId: adminUserId, actorRole: role };
}

// Walks a freshly-dispatched (LOADING) trip all the way to DISCHARGING —
// reads the trip's own CURRENT status before each advanceTripState call
// and passes it as expectedStatus, since that's now a required part of
// the command (PL-R2-P1-01, second production-lifecycle review). Used
// by every test below that just needs a trip AT DISCHARGING to exercise
// close/return/quality behavior, not the advance mechanism itself.
async function advanceToDischarging(tripId: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId }, select: { status: true } });
    const result = await advanceTripState(tripId, trip.status as "LOADING" | "IN_TRANSIT" | "ON_SITE", { allowedSiteId: siteId, ...actor() });
    if (result.status !== "OK") throw new Error(`advanceToDischarging: unexpected ${result.status} from status ${trip.status}`);
  }
}

// ======================================================================
// PL-P1-01 / PL-P1-02 — reassignTrip: cross-site authorization and full
// resource validation.
// ======================================================================

test("reassignTrip refuses a site-A operator reassigning a site-B trip, and changes nothing", async () => {
  const resB = await makeReservation({ siteId: siteBId });
  const ticketB = await makeTicket(resB, { plantId: plantBId });
  const truckB = await makeTruck({ plantId: plantBId });
  const driverB = await makeDriver({ plantId: plantBId });
  const dispatch = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const otherTruck = await makeTruck({ plantId: plantBId });
  const otherDriver = await makeDriver({ plantId: plantBId });
  const before_ = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  const auditBefore = await prisma.auditEvent.count({ where: { recordId: dispatch.tripId } });

  const result = await reassignTrip(dispatch.tripId, {
    truckId: otherTruck,
    driverId: otherDriver,
    pumpId: null,
    pumpOperatorId: null,
    pumpAssistantId: null,
    allowedSiteId: siteId, // site A's own scope — trip actually belongs to site B
    ...actor(),
  });
  assert.equal(result.status, "NOT_FOUND");

  const after_ = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(after_.truckId, before_.truckId);
  assert.equal(after_.driverId, before_.driverId);
  const auditAfter = await prisma.auditEvent.count({ where: { recordId: dispatch.tripId } });
  assert.equal(auditAfter, auditBefore);
});

test("reassignTrip succeeds for an in-scope operator and writes one atomic audit event", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck1 = await makeTruck();
  const driver1 = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driver1, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const truck2 = await makeTruck();
  const driver2 = await makeDriver();
  const result = await reassignTrip(dispatch.tripId, { truckId: truck2, driverId: driver2, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(result.status, "OK");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.truckId, truck2);
  assert.equal(trip.driverId, driver2);
  const audit = await prisma.auditEvent.findFirst({ where: { recordId: dispatch.tripId, reasonCode: "TRIP_ASSIGNMENT_UPDATED" } });
  assert.ok(audit);
});

// ======================================================================
// PL-R8-P1-04, eighth production-lifecycle review — driver/actions.ts's
// requireOwnTrip used to be the ONLY ownership check for reportTripDelay/
// uploadDeliveryPhoto, run as a plain pre-transaction read. A dispatch
// reassignment landing in the gap between that check and the (Round-7)
// audit-atomic transaction let the FORMER driver still act on a trip no
// longer theirs. reportTripDelayForId/attachDeliveryPhotoForId
// (tripLifecycle.ts) now re-verify ownership under the SAME Trip-row
// lock their own write uses. Proven two ways below: a fully
// deterministic "already reassigned" case (no latch needed — the
// re-check is unconditional), and a genuine concurrent race against a
// real reassignTrip call using the same two-latch pattern as the
// existing Plant-transfer tests.
// ======================================================================

test("reportTripDelayForId and attachDeliveryPhotoForId both refuse a driver no longer assigned to the trip", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck1 = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const truck2 = await makeTruck();
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driverA, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const reassign = await reassignTrip(dispatch.tripId, { truckId: truck2, driverId: driverB, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(reassign.status, "OK");

  const delayResult = await reportTripDelayForId(dispatch.tripId, { requireOwnDriverEmployeeId: driverA, reason: "TRAFFIC", note: null, ...actor() });
  assert.equal(delayResult.status, "NOT_FOUND", "the former driver must be refused once the trip has been reassigned");
  const delayCount = await prisma.tripDelayReport.count({ where: { tripId: dispatch.tripId } });
  assert.equal(delayCount, 0);

  const photoResult = await attachDeliveryPhotoForId(dispatch.tripId, { requireOwnDriverEmployeeId: driverA, url: "https://example.invalid/test-suite-pl-photo.jpg", ...actor() });
  assert.equal(photoResult.status, "NOT_FOUND", "the former driver must be refused once the trip has been reassigned");
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.deliveryPhotoUrl, null, "a refused attach must never have written a URL");

  // The NEW driver can legitimately act on it.
  const realDelay = await reportTripDelayForId(dispatch.tripId, { requireOwnDriverEmployeeId: driverB, reason: "TRAFFIC", note: null, ...actor() });
  assert.equal(realDelay.status, "OK");
});

test("attachDeliveryPhotoForId returns the freshest old URL, so a genuine race between two uploads never orphans the wrong blob", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  // PL-R9-P2-02: attachDeliveryPhotoForId now only accepts a photo while
  // actually DISCHARGING — a freshly dispatched trip starts at LOADING.
  await advanceToDischarging(dispatch.tripId);

  const first = await attachDeliveryPhotoForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, url: "https://example.invalid/photo-1.jpg", ...actor() });
  assert.equal(first.status, "OK");
  if (first.status === "OK") assert.equal(first.oldUrl, null, "no photo existed yet");

  const second = await attachDeliveryPhotoForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, url: "https://example.invalid/photo-2.jpg", ...actor() });
  assert.equal(second.status, "OK");
  if (second.status === "OK") assert.equal(second.oldUrl, "https://example.invalid/photo-1.jpg", "must return exactly the URL this write is replacing, read fresh under the lock");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.deliveryPhotoUrl, "https://example.invalid/photo-2.jpg");
});

// PL-R9-P2-02, ninth production-lifecycle review: neither function
// checked trip lifecycle status at all before this — a delay could be
// logged against a trip that closed days ago, and a photo could be
// attached before discharge even started or long after close, with no
// way to tell a meaningful report from a stray one. These prove the
// review's own recommended defaults: delays refused only once CLOSED;
// photo attach allowed only while DISCHARGING.

test("reportTripDelayForId is refused once the trip is CLOSED, and accepted at every state before that", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  // LOADING — allowed.
  const whileLoading = await reportTripDelayForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, reason: "TRAFFIC", note: null, ...actor() });
  assert.equal(whileLoading.status, "OK");

  await advanceToDischarging(dispatch.tripId);
  // DISCHARGING — still allowed.
  const whileDischarging = await reportTripDelayForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, reason: "WEATHER", note: null, ...actor() });
  assert.equal(whileDischarging.status, "OK");

  const close = await closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, requireOwnDriverEmployeeId: driver, ...actor() });
  assert.equal(close.status, "OK");

  const afterClose = await reportTripDelayForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, reason: "BREAKDOWN", note: null, ...actor() });
  assert.equal(afterClose.status, "TRIP_CLOSED", "a delay report against an already-closed trip must be refused, not silently recorded");

  const delayCount = await prisma.tripDelayReport.count({ where: { tripId: dispatch.tripId } });
  assert.equal(delayCount, 2, "only the two reports before close may have been written");
});

test("attachDeliveryPhotoForId is refused before DISCHARGING and after CLOSED, accepted only while actually discharging", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  // LOADING — refused, nothing written.
  const whileLoading = await attachDeliveryPhotoForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, url: "https://example.invalid/too-early.jpg", ...actor() });
  assert.equal(whileLoading.status, "NOT_DISCHARGING");

  await advanceToDischarging(dispatch.tripId);
  const whileDischarging = await attachDeliveryPhotoForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, url: "https://example.invalid/on-time.jpg", ...actor() });
  assert.equal(whileDischarging.status, "OK");

  const close = await closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, requireOwnDriverEmployeeId: driver, ...actor() });
  assert.equal(close.status, "OK");

  const afterClose = await attachDeliveryPhotoForId(dispatch.tripId, { requireOwnDriverEmployeeId: driver, url: "https://example.invalid/too-late.jpg", ...actor() });
  assert.equal(afterClose.status, "NOT_DISCHARGING", "a photo attach after close must be refused, not silently overwrite the delivery record");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.deliveryPhotoUrl, "https://example.invalid/on-time.jpg", "only the DISCHARGING-time attach may have taken effect");
});

test("a concurrent reassignment blocks reportTripDelayForId, and is correctly re-checked afterward", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck1 = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const truck2 = await makeTruck();
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driverA, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  let signalReassignLocked: () => void;
  const reassignLocked = new Promise<void>((resolve) => {
    signalReassignLocked = resolve;
  });
  let releaseReassign: () => void;
  const holdReassign = new Promise<void>((resolve) => {
    releaseReassign = resolve;
  });

  try {
    const reassignTx = prisma2.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Trip" WHERE "id" = ${dispatch.tripId} FOR UPDATE`;
      await tx.trip.update({ where: { id: dispatch.tripId }, data: { truckId: truck2, driverId: driverB } });
      signalReassignLocked();
      await holdReassign;
    });
    await reassignLocked;

    const delayOutcome = startObserved(reportTripDelayForId(dispatch.tripId, { requireOwnDriverEmployeeId: driverA, reason: "TRAFFIC", note: null, ...actor() }));
    await waitUntilBlockedOn(`FROM "Trip"`, 8_000);

    releaseReassign!();
    await reassignTx;

    const outcome = await delayOutcome;
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") assert.equal(outcome.value.status, "NOT_FOUND", "must see the committed reassignment, not the pre-race driver");
    const delayCount = await prisma.tripDelayReport.count({ where: { tripId: dispatch.tripId } });
    assert.equal(delayCount, 0, "a refused report must never have been created");
  } finally {
    releaseReassign!();
  }
});

test("a concurrent reassignment blocks attachDeliveryPhotoForId, and is correctly re-checked afterward", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck1 = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const truck2 = await makeTruck();
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driverA, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  let signalReassignLocked: () => void;
  const reassignLocked = new Promise<void>((resolve) => {
    signalReassignLocked = resolve;
  });
  let releaseReassign: () => void;
  const holdReassign = new Promise<void>((resolve) => {
    releaseReassign = resolve;
  });

  try {
    const reassignTx = prisma2.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Trip" WHERE "id" = ${dispatch.tripId} FOR UPDATE`;
      await tx.trip.update({ where: { id: dispatch.tripId }, data: { truckId: truck2, driverId: driverB } });
      signalReassignLocked();
      await holdReassign;
    });
    await reassignLocked;

    const photoOutcome = startObserved(
      attachDeliveryPhotoForId(dispatch.tripId, { requireOwnDriverEmployeeId: driverA, url: "https://example.invalid/race-photo.jpg", ...actor() }),
    );
    await waitUntilBlockedOn(`FROM "Trip"`, 8_000);

    releaseReassign!();
    await reassignTx;

    const outcome = await photoOutcome;
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") assert.equal(outcome.value.status, "NOT_FOUND", "must see the committed reassignment, not the pre-race driver");
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
    assert.equal(trip.deliveryPhotoUrl, null, "a refused attach must never have written a URL");
  } finally {
    releaseReassign!();
  }
});

test("reassignTrip refuses an out-of-service truck, a busy driver, and a trip that already left LOADING", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truck1 = await makeTruck();
  const driver1 = await makeDriver();
  const driver2 = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truck1, driverId: driver1, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  if (dispatchA.status !== "OK") return;
  tripIds.push(dispatchA.tripId);

  const truck2 = await makeTruck();
  const dispatchB = await dispatchTrip(ticketB, { truckId: truck2, driverId: driver2, allowedSiteId: siteId });
  assert.equal(dispatchB.status, "OK");
  if (dispatchB.status !== "OK") return;
  tripIds.push(dispatchB.tripId);

  // Busy driver: driver1 already has an open trip (dispatchA).
  const busyResult = await reassignTrip(dispatchB.tripId, { truckId: truck2, driverId: driver1, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(busyResult.status, "DRIVER_BUSY");

  // Out-of-service truck.
  const brokenTruck = await makeTruck({ status: "OUT_OF_SERVICE" });
  const outOfServiceResult = await reassignTrip(dispatchB.tripId, { truckId: brokenTruck, driverId: driver2, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(outOfServiceResult.status, "TRUCK_OUT_OF_SERVICE");

  // Trip already past LOADING — advance it, then reassignment must refuse.
  const advanceResult = await advanceTripState(dispatchB.tripId, "LOADING", { allowedSiteId: siteId, ...actor() });
  assert.equal(advanceResult.status, "OK");
  const notLoadingResult = await reassignTrip(dispatchB.tripId, { truckId: truck2, driverId: driver2, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(notLoadingResult.status, "NOT_LOADING");
});

// PL-R6-P2-03, sixth production-lifecycle review: both ticket-detail
// pages' driver picker used to list every driver regardless of status,
// even though claimTripResources always rejects one that isn't ACTIVE —
// the same picker/domain mismatch already fixed for cross-site trucks
// and pumps. The picker-side fix (filtering the option list) isn't
// reachable from this domain-only suite (see this file's own scope
// note), so this proves the domain guard itself, both at dispatch and
// at reassignment.
test("startTripForTicket and reassignTrip both refuse an inactive driver", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const inactiveDriver = await makeDriver({ status: "INACTIVE" });

  const dispatchResult = await dispatchTrip(ticket, { truckId: truck, driverId: inactiveDriver, allowedSiteId: siteId });
  assert.equal(dispatchResult.status, "DRIVER_INACTIVE");
  const tripCount = await prisma.trip.count({ where: { batchTicketId: ticket } });
  assert.equal(tripCount, 0, "a refused dispatch must never have created a trip");

  const activeDriver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: activeDriver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const reassignResult = await reassignTrip(dispatch.tripId, { truckId: truck, driverId: inactiveDriver, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(reassignResult.status, "DRIVER_INACTIVE");
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.driverId, activeDriver, "a refused reassignment must never have applied");
});

test("reassignTrip refuses a truck whose rated capacity is smaller than the ticket's own volume", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 10 });
  const truck1 = await makeTruck();
  const driver1 = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driver1, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const undersizedTruck = await makeTruck({ drumCapacityM3: 6 });
  const result = await reassignTrip(dispatch.tripId, { truckId: undersizedTruck, driverId: driver1, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(result.status, "TRUCK_CAPACITY_EXCEEDED");
});

// ======================================================================
// PL-P1-03 — claimTripSlot/claimTripResources: fresh, in-transaction
// dispatch validation, including a real concurrent race for the same
// truck and the same driver.
// ======================================================================

test("claimTripSlot refuses dispatch out of the actor's own site scope", async () => {
  const resB = await makeReservation({ siteId: siteBId });
  const ticketB = await makeTicket(resB, { plantId: plantBId });
  const truckB = await makeTruck({ plantId: plantBId });
  const driverB = await makeDriver({ plantId: plantBId });

  const result = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(result.status, "OUT_OF_SCOPE");
});

// Both dispatch transactions run under Serializable isolation, same as
// startTrip's own real transaction — the row lock claimTripResources
// takes on the contested resource means the SECOND transaction to reach
// it blocks until the first commits, but Postgres's own serializable-
// snapshot conflict detection can still abort a genuinely concurrent
// transaction outright (surfacing as a thrown write-conflict error, not
// a clean typed result) rather than let it wake up and see a clean busy
// status — exactly the same "the caller just needs to retry" outcome
// startTrip's own real catch block already documents for this case, not
// a bug in claimTripResources itself. Mirrors tryDispatch's own
// catch-and-normalize shape in tests/batchCompletion.test.ts.
async function dispatchTripOrRejected(ticketId: string, opts: Parameters<typeof dispatchTrip>[1]) {
  try {
    return await dispatchTrip(ticketId, opts);
  } catch {
    return { status: "REJECTED" as const };
  }
}

test("two concurrent dispatches for the same truck: exactly one succeeds, the other is refused", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truck = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();

  const [resultA, resultB] = await Promise.all([
    dispatchTripOrRejected(ticketA, { truckId: truck, driverId: driverA, allowedSiteId: siteId }),
    dispatchTripOrRejected(ticketB, { truckId: truck, driverId: driverB, allowedSiteId: siteId }),
  ]);
  const oks = [resultA, resultB].filter((r) => r.status === "OK");
  const losers = [resultA, resultB].filter((r) => r.status !== "OK");
  assert.equal(oks.length, 1, "exactly one of the two concurrent dispatches must win the truck");
  assert.equal(losers.length, 1);
  assert.ok(losers[0].status === "TRUCK_BUSY" || losers[0].status === "REJECTED", `unexpected loser status: ${losers[0].status}`);
  if (oks[0].status === "OK") tripIds.push(oks[0].tripId);
});

test("two concurrent dispatches for the same driver (different trucks): exactly one succeeds, the other is refused", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driver = await makeDriver();

  const [resultA, resultB] = await Promise.all([
    dispatchTripOrRejected(ticketA, { truckId: truckA, driverId: driver, allowedSiteId: siteId }),
    dispatchTripOrRejected(ticketB, { truckId: truckB, driverId: driver, allowedSiteId: siteId }),
  ]);
  const oks = [resultA, resultB].filter((r) => r.status === "OK");
  const losers = [resultA, resultB].filter((r) => r.status !== "OK");
  assert.equal(oks.length, 1, "exactly one of the two concurrent dispatches must win the driver");
  assert.equal(losers.length, 1);
  assert.ok(losers[0].status === "DRIVER_BUSY" || losers[0].status === "REJECTED", `unexpected loser status: ${losers[0].status}`);
  if (oks[0].status === "OK") tripIds.push(oks[0].tripId);
});

test("dispatch refuses a pump delivery with no pump, an out-of-reach pump, and the same person as operator and assistant", async () => {
  const res = await makeReservation({ deliveryMethod: "PUMP", minPumpReachM: 40 });
  const ticket1 = await makeTicket(res);
  const truck1 = await makeTruck();
  const driver1 = await makeDriver();

  const noPumpResult = await dispatchTrip(ticket1, { truckId: truck1, driverId: driver1, allowedSiteId: siteId });
  assert.equal(noPumpResult.status, "PUMP_REQUIRED");

  // An operator is required before reach is even considered (PL-R2-P2-03
  // validates operator presence first) — supplying one here is what lets
  // this call actually reach the reach check it claims to test, rather
  // than stopping earlier at PUMP_OPERATOR_REQUIRED (PL-R3-CI-01, third
  // production-lifecycle review).
  const shortPump = await makePump({ reachM: 20 });
  const shortReachOperator = await makeCrew("OPERATOR");
  const ticket2 = await makeTicket(res);
  const truck2 = await makeTruck();
  const shortReachResult = await dispatchTrip(ticket2, { truckId: truck2, driverId: driver1, pumpId: shortPump, pumpOperatorId: shortReachOperator, allowedSiteId: siteId });
  assert.equal(shortReachResult.status, "PUMP_INSUFFICIENT_REACH");

  const goodPump = await makePump({ reachM: 50 });
  const crewMember = await makeCrew("OPERATOR");
  const ticket3 = await makeTicket(res);
  const truck3 = await makeTruck();
  const samePersonResult = await dispatchTrip(ticket3, {
    truckId: truck3,
    driverId: driver1,
    pumpId: goodPump,
    pumpOperatorId: crewMember,
    pumpAssistantId: crewMember,
    allowedSiteId: siteId,
  });
  assert.equal(samePersonResult.status, "PUMP_CREW_SAME_PERSON");
});

test("dispatch refuses a pump delivery with no operator, and a pump with unknown reach can never satisfy a stated minimum", async () => {
  const res = await makeReservation({ deliveryMethod: "PUMP", minPumpReachM: 40 });
  const goodPump = await makePump({ reachM: 50 });
  const driver1 = await makeDriver();

  const ticket1 = await makeTicket(res);
  const truck1 = await makeTruck();
  const noOperatorResult = await dispatchTrip(ticket1, { truckId: truck1, driverId: driver1, pumpId: goodPump, allowedSiteId: siteId });
  assert.equal(noOperatorResult.status, "PUMP_OPERATOR_REQUIRED");

  // A pump whose reach was simply never recorded must never satisfy a
  // stated minimum (PL-R2-P2-03, second production-lifecycle review) —
  // the old check only rejected a KNOWN reach below the minimum,
  // silently passing an unknown one.
  const unknownReachPump = await makePump({ reachM: null });
  const operator = await makeCrew("OPERATOR");
  const ticket2 = await makeTicket(res);
  const truck2 = await makeTruck();
  const unknownReachResult = await dispatchTrip(ticket2, { truckId: truck2, driverId: driver1, pumpId: unknownReachPump, pumpOperatorId: operator, allowedSiteId: siteId });
  assert.equal(unknownReachResult.status, "PUMP_REACH_UNKNOWN");
});

// ======================================================================
// PL-P1-04 — a completed ticket can never be cancelled: the hard-delete
// path this used to race is gone entirely (production/actions.ts no
// longer exports deleteBatchTicket at all), so the only remaining
// removal path — cancelBatchTicket's own atomic claim — is what this
// proves refuses a terminal ticket outright, leaving its posted movement
// intact.
// ======================================================================

test("cancelBatchTicket refuses a ticket that has already completed, and its posted movement stays intact", async () => {
  const res = await makeReservation();
  const ticket = await prisma.batchTicket.create({
    data: {
      reservationId: res,
      mixId,
      plantId,
      ticketNumber: `TEST-SUITE-PL-BT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      volumeM3: 4,
      status: "RELEASED",
      components: { create: [{ materialId, targetMassKg: 1200 }] },
    },
  });
  ticketIds.push(ticket.id);

  const completion = await completeBatchTicket(ticket.id, { actorId: adminUserId });
  assert.equal(completion.status, "SUCCESS");

  const cancelResult = await cancelBatchTicket(ticket.id, { actorId: adminUserId, actorRole: "ADMIN", reason: "TEST-SUITE-PL-late-cancel-attempt" });
  assert.equal(cancelResult.status, "INVALID_STATE");

  const freshTicket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  assert.equal(freshTicket.status, "COMPLETE");
  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticket.id } });
  assert.equal(movements.length, 1);
});

// ======================================================================
// PL-P1-05 — atomic trip state machine: fresh row-locked reads, a
// DISCHARGING-only close boundary, idempotent duplicate closes, and
// reservation finalization folded into the same transaction as the
// close that might trigger it.
// ======================================================================

test("advanceTripState walks LOADING -> IN_TRANSIT -> ON_SITE -> DISCHARGING and then refuses to advance further", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const sequence: ["LOADING" | "IN_TRANSIT" | "ON_SITE", string][] = [
    ["LOADING", "IN_TRANSIT"],
    ["IN_TRANSIT", "ON_SITE"],
    ["ON_SITE", "DISCHARGING"],
  ];
  for (const [expectedCurrent, expectedNext] of sequence) {
    const result = await advanceTripState(dispatch.tripId, expectedCurrent, { allowedSiteId: siteId, ...actor() });
    assert.equal(result.status, "OK");
    if (result.status === "OK") assert.equal(result.next, expectedNext);
  }
  // DISCHARGING is not a real AdvanceableTripStatus — the Server Action
  // layer itself (trips/actions.ts) already refuses anything outside
  // LOADING/IN_TRANSIT/ON_SITE before ever reaching this domain function,
  // so this exact call is unreachable through a real typed caller. The
  // cast proves the defensive NEXT_STATUS lookup itself still refuses
  // cleanly if it were ever reached some other way.
  const noNext = await advanceTripState(dispatch.tripId, "DISCHARGING" as "LOADING", { allowedSiteId: siteId, ...actor() });
  assert.equal(noNext.status, "NO_NEXT_STATE");
});

test("advanceTripState and closeTripFullForId both refuse a DRIVER acting on someone else's trip", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const otherDriver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const result = await advanceTripState(dispatch.tripId, "LOADING", { allowedSiteId: siteId, requireOwnDriverEmployeeId: otherDriver, ...actor("DRIVER") });
  assert.equal(result.status, "NOT_FOUND");
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.status, "LOADING");
});

test("closeTripFullForId refuses a crafted close straight from LOADING, and closes cleanly once DISCHARGING", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const craftedClose = await closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(craftedClose.status, "NOT_DISCHARGING");

  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, ...actor(), deliverySignedBy: "TEST-SUITE-PL-SIGNATURE" });
  assert.equal(close.status, "OK");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.status, "CLOSED");
  assert.equal(trip.volumeDeliveredM3, 8);
  assert.equal(trip.deliverySignedBy, "TEST-SUITE-PL-SIGNATURE");
  assert.ok(trip.deliverySignedAt);

  // Duplicate close is idempotent — a second attempt on the now-CLOSED
  // trip is refused, not a second CLOSED/DELIVERED side effect.
  const duplicateClose = await closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(duplicateClose.status, "NOT_DISCHARGING");
});

test("two concurrent close attempts on the same trip (full-close vs. return-close) have exactly one winner, with no double audit", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  await advanceToDischarging(dispatch.tripId);

  // PL-R4-P1-01, fourth production-lifecycle review: advanceToDischarging
  // above already wrote three legitimate TRIP_ADVANCED audit rows (all
  // field:"status", the same field a full-close's own audit row uses), so
  // a bare count of field IN ("status","drumReturn") for this trip counts
  // those three PLUS the one real close event — 4, not 1. A baseline
  // taken right before the race, keyed to close-specific rows only
  // (TRIP_CLOSED_FULL_LOAD's own reasonCode, or field:"drumReturn" for a
  // return-close), isolates the delta the race actually produced.
  const closeRelevantWhere = {
    recordId: dispatch.tripId,
    OR: [{ reasonCode: "TRIP_CLOSED_FULL_LOAD" }, { field: "drumReturn" }],
  };
  const auditsBefore = await prisma.auditEvent.count({ where: closeRelevantWhere });

  const [fullResult, returnResult] = await Promise.all([
    closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, ...actor() }),
    closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 2, reasonCode: "OVER_ORDERED", fate: null }),
  ]);
  const statuses = [fullResult.status, returnResult.status].sort();
  assert.deepEqual(statuses, ["NOT_DISCHARGING", "OK"], "exactly one close may win — the loser must see the trip already past DISCHARGING, never both succeed");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.status, "CLOSED");
  // The winner's own side effects (a DrumReturn) exist only if
  // return-close won — either outcome is a single, unambiguous result,
  // never a mix of both closes' effects.
  const drumReturnCount = await prisma.drumReturn.count({ where: { tripId: dispatch.tripId } });
  assert.equal(drumReturnCount, returnResult.status === "OK" ? 1 : 0);
  if (returnResult.status === "OK") {
    const dr = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
    drumReturnIds.push(dr.id);
  }
  const auditsAfter = await prisma.auditEvent.count({ where: closeRelevantWhere });
  assert.equal(auditsAfter - auditsBefore, 1, "exactly one NEW close audit event, never two — the three prior advance events must not be counted");
});

test("finalizing a reservation is deferred until every sibling ticket's trip has closed, and never overwrites an already-cancelled reservation", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res, { volumeM3: 8 });
  const ticketB = await makeTicket(res, { volumeM3: 8 });
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  await advanceToDischarging(dispatchA.tripId);
  const closeA = await closeTripFullForId(dispatchA.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(closeA.status, "OK");

  // Only trip A of two has closed — the reservation must not flip yet.
  let reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "CONFIRMED");

  // The reservation is closed early (a real terminal state) BEFORE the
  // second trip ever finishes — closing the last trip afterward must
  // never overwrite that.
  const closeReservationResult = await closeReservationForId(res, { actorId: adminUserId, actorRole: "ADMIN", allowedSiteId: siteId, closeReasonCode: "TEST-SUITE-PL-EARLY-CLOSE", closeNote: null });
  assert.equal(closeReservationResult.status, "OK");

  await advanceToDischarging(dispatchB.tripId);
  const closeB = await closeTripFullForId(dispatchB.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(closeB.status, "OK");

  reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "DELIVERED", "closeReservationForId already stamps DELIVERED for an early close, so this reservation was already terminal before trip B ever closed");
});

test("two final trips of the same reservation closing concurrently leave exactly one DELIVERED reservation", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res, { volumeM3: 8 });
  const ticketB = await makeTicket(res, { volumeM3: 8 });
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  await advanceToDischarging(dispatchA.tripId);
  await advanceToDischarging(dispatchB.tripId);

  const [closeA, closeB] = await Promise.all([
    closeTripFullForId(dispatchA.tripId, { allowedSiteId: siteId, ...actor() }),
    closeTripFullForId(dispatchB.tripId, { allowedSiteId: siteId, ...actor() }),
  ]);
  assert.equal(closeA.status, "OK");
  assert.equal(closeB.status, "OK");

  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "DELIVERED");
  const tripA = await prisma.trip.findUniqueOrThrow({ where: { id: dispatchA.tripId } });
  const tripB = await prisma.trip.findUniqueOrThrow({ where: { id: dispatchB.tripId } });
  assert.equal(tripA.status, "CLOSED");
  assert.equal(tripB.status, "CLOSED");
});

// ======================================================================
// PL-R2-P1-01 — a duplicate concurrent advance request must never apply
// the same stale user intent twice (LOADING -> IN_TRANSIT -> ON_SITE
// instead of the intended single LOADING -> IN_TRANSIT).
// ======================================================================

test("two concurrent advance requests both carrying expectedStatus LOADING: exactly one succeeds, the trip never skips a state", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const [resultA, resultB] = await Promise.all([
    advanceTripState(dispatch.tripId, "LOADING", { allowedSiteId: siteId, ...actor() }),
    advanceTripState(dispatch.tripId, "LOADING", { allowedSiteId: siteId, ...actor() }),
  ]);
  const statuses = [resultA.status, resultB.status].sort();
  assert.deepEqual(statuses, ["OK", "STALE_STATE"], "a duplicate request (double-click, retry, replay) must be told its belief was stale, not silently advance a second time");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.status, "IN_TRANSIT", "must land on IN_TRANSIT exactly once, never skip straight to ON_SITE");
});

// ======================================================================
// PL-R2-P1-03 — lifecycle authorization must share a real Plant row
// lock with the supported Plant-transfer path (plants/actions.ts's
// updatePlant), not just re-read Plant.siteId without locking it.
// ======================================================================

test("advanceTripState re-checks site authorization against the POST-transfer Plant row, never a value read before a concurrent transfer committed", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  // Two separate latches, not one (PL-R3-CI-02, third production-
  // lifecycle review): the old version started transferTx and
  // advanceTripState back-to-back with nothing between them, so either
  // side could reach the Plant row first — if advanceTripState won,
  // waitUntilBlockedOn was polling for the WRONG statement (the
  // transfer's own UPDATE would be the one blocked, not
  // advanceTripState's SELECT ... FOR UPDATE) and just timed out. This
  // is a test-coordination fix only; lockPlantSiteId itself was never in
  // question.
  let signalTransferLocked: () => void;
  const transferLocked = new Promise<void>((resolve) => {
    signalTransferLocked = resolve;
  });
  let releaseTransfer: () => void;
  const holdTransfer = new Promise<void>((resolve) => {
    releaseTransfer = resolve;
  });

  try {
    // A real Plant-transfer, on its own connection — updatePlant's own
    // single UPDATE statement already takes an equivalent row lock for
    // the duration of its transaction; wrapping it explicitly and
    // pausing right after the write (before commit) holds that exact
    // lock open so the assertion below can prove the other side
    // genuinely waits on it, not just races it.
    const transferTx = prisma2.$transaction(async (tx) => {
      await tx.plant.update({ where: { id: plantId }, data: { siteId: siteBId } });
      signalTransferLocked();
      await holdTransfer;
    });

    // Proves the UPDATE has actually completed and the transfer now
    // owns the Plant row's lock, before advanceTripState ever starts —
    // eliminating the race the old version had.
    await transferLocked;

    // advanceTripState locks the Trip (uncontested) then tries to lock
    // the ticket's own Plant row (src/lib/siteScope.ts's
    // lockPlantSiteId) — which the transfer above is already holding, so
    // this genuinely blocks rather than racing on timing.
    const advancePromise = advanceTripState(dispatch.tripId, "LOADING", { allowedSiteId: siteId, ...actor() });
    await waitUntilBlockedOn(`FROM "Plant"`);

    releaseTransfer!();
    await transferTx;

    const result = await advancePromise;
    // The plant now belongs to siteBId — an actor whose own allowed
    // scope is siteId (site A) must be refused, exactly as if the trip
    // had always belonged to a different site, never authorized against
    // the value that was true before the transfer committed.
    assert.equal(result.status, "NOT_FOUND");

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
    assert.equal(trip.status, "LOADING", "a refused authorization check must never have advanced the trip");
  } finally {
    // Releasing again here is a safe no-op on the normal path (a
    // Promise resolver ignores a second call) — it only matters if an
    // assertion above threw before the normal release point was
    // reached, which would otherwise leave transferTx's transaction
    // paused forever and hang teardown.
    releaseTransfer!();
    // Restore the shared fixture plant's site — every other test in
    // this file assumes plantId belongs to siteId.
    await prisma.plant.update({ where: { id: plantId }, data: { siteId } });
  }
});

test("a concurrent Plant transfer also blocks and is correctly re-checked by startTripForTicket, not only advanceTripState", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();

  let signalTransferLocked: () => void;
  const transferLocked = new Promise<void>((resolve) => {
    signalTransferLocked = resolve;
  });
  let releaseTransfer: () => void;
  const holdTransfer = new Promise<void>((resolve) => {
    releaseTransfer = resolve;
  });

  try {
    const transferTx = prisma2.$transaction(async (tx) => {
      await tx.plant.update({ where: { id: plantId }, data: { siteId: siteBId } });
      signalTransferLocked();
      await holdTransfer;
    });
    await transferLocked;

    // claimTripSlot (inside startTripForTicket) locks the Ticket's own
    // Plant row via lockPlantSiteId, same as advanceTripState — this
    // proves the dispatch path shares the same real backstop, not only
    // the already-covered advance path.
    const dispatchPromise = dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
    await waitUntilBlockedOn(`FROM "Plant"`);

    releaseTransfer!();
    await transferTx;

    const result = await dispatchPromise;
    assert.equal(result.status, "OUT_OF_SCOPE");

    const tripCount = await prisma.trip.count({ where: { batchTicketId: ticket } });
    assert.equal(tripCount, 0, "a refused dispatch must never have created a Trip");
  } finally {
    releaseTransfer!();
    await prisma.plant.update({ where: { id: plantId }, data: { siteId } });
  }
});

// ======================================================================
// PL-P1-06 — a quality rejection is provisional: closing the trip never
// reduces billed volume on its own, and the audit trail always carries
// the real actor/role.
// ======================================================================

test("closeTripWithReturnForId never reduces volumeDeliveredM3 on its own, even for a quality rejection, and records the real actor/role", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);

  // A DRIVER (not Quality/Admin) is exactly who this finding is about —
  // closing with a quality rejection must never self-authorize a billing
  // reduction, and the audit must say DRIVER really did this, never an
  // impersonated QUALITY_SUPERVISOR/ACCOUNTANT.
  const close = await closeTripWithReturnForId(dispatch.tripId, {
    allowedSiteId: siteId,
    ...actor("DRIVER"),
    returnedVolumeM3: 3,
    reasonCode: "QUALITY_REJECTED",
    fate: null,
  });
  assert.equal(close.status, "OK");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.volumeDeliveredM3, 8, "billed volume must stay the full ticket amount until Quality actually approves the memo");

  const memo = await prisma.wasteIncidentMemo.findFirst({ where: { batchTicketId: ticket } });
  assert.ok(memo);
  assert.equal(memo!.status, "PENDING");
  wasteMemoIds.push(memo!.id);
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  const audit = await prisma.auditEvent.findFirstOrThrow({ where: { recordId: dispatch.tripId, field: "drumReturn" } });
  assert.equal(audit.role, "DRIVER");
  assert.equal(audit.actorId, adminUserId);
});

test("decideWasteIncidentMemo(APPROVE) applies the billing reduction exactly once, atomically, with the real approving actor", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 3, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  const approval = await decideWasteIncidentMemo(memo.id, "APPROVE", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-confirmed contamination" });
  assert.equal(approval.status, "OK");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.volumeDeliveredM3, 5); // 8 - 3

  const duplicateApproval = await decideWasteIncidentMemo(memo.id, "APPROVE", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-second-attempt" });
  assert.equal(duplicateApproval.status, "ALREADY_DECIDED");
  const tripAfterDuplicate = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(tripAfterDuplicate.volumeDeliveredM3, 5, "a second approval attempt must never reduce the billed volume twice");
});

// ======================================================================
// PL-R2-P1-02 — quality decisions reconcile the owning Reservation
// atomically: a single-ticket reservation stays non-terminal while a
// quality memo is unresolved, approval reopens/adjusts it so the
// shortfall can actually be released, and denial finalizes it untouched.
// ======================================================================

test("a single-ticket reservation stays non-terminal while its quality memo is PENDING, then reopens for the shortfall once approved, permitting exactly the replacement volume", async () => {
  const res = await makeReservation({ requestedVolumeM3: 8 });
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 3, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  // Full provisional volume (8) already equals requestedVolumeM3 (8), but
  // the memo is still PENDING — this reservation must NOT finalize yet.
  let reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "CONFIRMED", "must not finalize DELIVERED while a quality memo is still unresolved");

  // Simulates a row already in the exact bad state the OLD code could
  // produce (finalized DELIVERED despite a PENDING memo, before this
  // review's fix existed) — the review explicitly requires that approval
  // can repair such a row, not only prevent new ones. A real caller can
  // never reach DELIVERED-with-a-PENDING-memo through the current code
  // (reconcileReservationDeliveryState's own PENDING gate blocks it at
  // every close), so this direct write stands in for pre-existing data.
  await prisma.reservation.update({ where: { id: res }, data: { status: "DELIVERED" } });

  const approval = await decideWasteIncidentMemo(memo.id, "APPROVE", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-confirmed contamination" });
  assert.equal(approval.status, "OK");

  // Approval reduces accepted volume to 5 of 8 requested — a reservation
  // that was (wrongly) DELIVERED must reopen to IN_PRODUCTION so the
  // shortfall can actually be released, never stay stuck DELIVERED-but-short.
  reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "IN_PRODUCTION", "must reopen so the shortfall can actually be released");

  const remaining = await getRemainingVolumeM3(res, reservation.requestedVolumeM3);
  assert.equal(remaining, 3);

  // The replacement ticket can actually be released now that the
  // reservation is IN_PRODUCTION again — proving this isn't just a
  // status flip with no real operational effect.
  const replacement = await releaseTicketForReservation(res, remaining, plantId, { id: adminUserId, role: "ADMIN", allowedSiteId: siteId });
  assert.equal(replacement.status, "OK");
  if (replacement.status === "OK") ticketIds.push(replacement.ticket.id);
});

test("denying a waste memo leaves the delivered volume unchanged and finalizes the reservation once otherwise complete", async () => {
  const res = await makeReservation({ requestedVolumeM3: 8 });
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 3, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  const denial = await decideWasteIncidentMemo(memo.id, "DENY", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-inspection found no defect" });
  assert.equal(denial.status, "OK");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.volumeDeliveredM3, 8, "a denied suspicion never reduces billed volume");
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "DELIVERED", "resolving the memo (even by denial) unblocks finalization once the ticket was otherwise complete");

  const memoAfter = await prisma.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memo.id } });
  assert.equal(memoAfter.status, "REJECTED");

  // Duplicate/racing decision on an already-decided memo.
  const duplicateDenial = await decideWasteIncidentMemo(memo.id, "DENY", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-second-attempt" });
  assert.equal(duplicateDenial.status, "ALREADY_DECIDED");
});

test("concurrent approve-vs-deny on the same memo has exactly one winner", async () => {
  const res = await makeReservation({ requestedVolumeM3: 8 });
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 3, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  const [approveResult, denyResult] = await Promise.all([
    decideWasteIncidentMemo(memo.id, "APPROVE", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-race-approve" }),
    decideWasteIncidentMemo(memo.id, "DENY", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-race-deny" }),
  ]);
  const statuses = [approveResult.status, denyResult.status].sort();
  assert.deepEqual(statuses, ["ALREADY_DECIDED", "OK"]);
});

// PL-R3-P2-03, third production-lifecycle review — decideWasteIncidentMemo
// is transactionally shaped correctly, but that was never actually
// proven with a real injected failure. A nonexistent actorId violates
// AuditEvent.actorId's own FK the same way an earlier round's test
// already proved for a different domain function.
//
// PL-R4-P2-01, fourth production-lifecycle review, corrected this: the
// audit insert is now the true LAST write (see tripLifecycle.ts's own
// comment on the reorder), so the injected failure genuinely lands after
// reconcileReservationDeliveryState has already run. But that alone
// isn't enough — the fixture also has to put the Reservation somewhere
// reconciliation actually MUTATES, or there is nothing to roll back and
// the assertion passes trivially. A normal CONFIRMED reservation with a
// PENDING memo was never touched by reconciliation either way. Instead,
// this manufactures the one legacy-repairable state reconciliation
// exists to fix (see reconcileReservationDeliveryState's own comment):
// DELIVERED with closedAt still null, alongside a PENDING memo — a state
// application code can no longer reach on its own (a pending memo always
// blocks the natural DELIVERED transition), forced here directly the
// same way an earlier round's reconciliation test already did to reach
// this branch at all.
test("decideWasteIncidentMemo rolls back the memo, Trip volume, and Reservation reconciliation together when the audit write fails", async () => {
  const res = await makeReservation({ requestedVolumeM3: 8 });
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 3, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  // Manufacture the legacy-repairable fixture: force DELIVERED with
  // closedAt still null. Trip.volumeDeliveredM3 is currently the full 8
  // (closeTripWithReturnForId never reduces it provisionally, PL-P1-06),
  // so approving this 3 m³ memo will drop accepted volume to 5 — short of
  // the reservation's own 8 m³ requested — which is exactly the shortfall
  // reconcileReservationDeliveryState must react to by reopening to
  // IN_PRODUCTION, a real, observable mutation of this row.
  await prisma.reservation.update({ where: { id: res }, data: { status: "DELIVERED" } });

  const beforeMemo = await prisma.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memo.id } });
  const beforeTrip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  const beforeReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(beforeReservation.status, "DELIVERED");
  assert.equal(beforeReservation.closedAt, null);
  const auditCountBefore = await prisma.auditEvent.count({ where: { recordId: memo.id } });

  await assert.rejects(() =>
    decideWasteIncidentMemo(memo.id, "APPROVE", {
      allowedSiteId: siteId,
      actorId: "test-suite-pl-nonexistent-actor",
      actorRole: "QUALITY_SUPERVISOR",
      decisionNote: "TEST-SUITE-PL-forced-rollback",
    }),
  );

  const [afterMemo, afterTrip, afterReservation, auditCountAfter] = await Promise.all([
    prisma.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memo.id } }),
    prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } }),
    prisma.reservation.findUniqueOrThrow({ where: { id: res } }),
    prisma.auditEvent.count({ where: { recordId: memo.id } }),
  ]);
  assert.equal(afterMemo.status, beforeMemo.status, "memo status must roll back");
  assert.equal(afterMemo.approvedById, beforeMemo.approvedById);
  assert.equal(afterTrip.volumeDeliveredM3, beforeTrip.volumeDeliveredM3, "the Trip volume reduction must roll back with everything else");
  // The real proof this time (PL-R4-P2-01): reconciliation actually ran
  // and actually flipped this row to IN_PRODUCTION inside the failed
  // transaction — this asserts that mutation itself was undone, not just
  // that a value which was never going to change stayed the same.
  assert.equal(afterReservation.status, "DELIVERED", "the forced-legacy DELIVERED state must survive the rollback unchanged");
  assert.equal(afterReservation.status, beforeReservation.status, "reservation reconciliation must roll back too");
  assert.equal(auditCountAfter, auditCountBefore, "no partial audit row may survive");

  // The memo is still genuinely PENDING and can still be decided for
  // real, once a real actor decides it — proves this wasn't left in some
  // half-claimed state by the failed attempt, and this time reconciliation
  // really does reopen the reservation for the shortfall.
  const realDecision = await decideWasteIncidentMemo(memo.id, "APPROVE", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-real-decision-after-rollback" });
  assert.equal(realDecision.status, "OK");
  const finalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(finalReservation.status, "IN_PRODUCTION", "a genuinely short delivery must reopen the legacy-DELIVERED reservation");
  const finalTrip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(finalTrip.volumeDeliveredM3, 5);
});

test("a multi-ticket reservation's totals and terminal status reconcile correctly after a quality approval on one of its tickets", async () => {
  const res = await makeReservation({ requestedVolumeM3: 16 });
  const ticketA = await makeTicket(res, { volumeM3: 8 });
  const ticketB = await makeTicket(res, { volumeM3: 8 });
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  await advanceToDischarging(dispatchA.tripId);
  const closeA = await closeTripWithReturnForId(dispatchA.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 2, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(closeA.status, "OK");
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticketA } });
  wasteMemoIds.push(memo.id);
  const drumReturnA = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatchA.tripId } });
  drumReturnIds.push(drumReturnA.id);

  await advanceToDischarging(dispatchB.tripId);
  const closeB = await closeTripFullForId(dispatchB.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(closeB.status, "OK");

  // Ticket A's memo is still PENDING — even with ticket B fully closed,
  // 8 (B) + 8 (A, provisional) already reaches 16, but finalization must
  // still wait on the unresolved memo.
  let reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "CONFIRMED");

  const approval = await decideWasteIncidentMemo(memo.id, "APPROVE", { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", decisionNote: "TEST-SUITE-PL-confirmed" });
  assert.equal(approval.status, "OK");

  // Now 6 (A, reduced) + 8 (B) = 14 of 16 — still short. This reservation
  // was never wrongly finalized DELIVERED in the first place (A's memo
  // was already blocking it), so there's nothing to reopen — it simply
  // stays CONFIRMED, which is just as releasable as IN_PRODUCTION
  // (releaseTicketForReservation accepts either).
  reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: res } });
  assert.equal(reservation.status, "CONFIRMED");
  const remaining = await getRemainingVolumeM3(res, reservation.requestedVolumeM3);
  assert.equal(remaining, 2);
});

test("closeTripWithReturnForId records the real actor/role for a non-quality PARTIAL_CREDIT return too", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  // Fresh trip (batchTime ~ now) + a return volume above the plant's
  // default 0.2 m3 absorption threshold, no quality rejection -> PARTIAL_CREDIT.
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("PLANT_OPERATOR"), returnedVolumeM3: 2, reasonCode: "OVER_ORDERED", fate: "DUMPED" });
  assert.equal(close.status, "OK");

  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);
  assert.equal(drumReturn.disposition, "PARTIAL_CREDIT");
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.volumeDeliveredM3, 8, "a non-quality return still bills the full ticket volume");

  const audit = await prisma.auditEvent.findFirstOrThrow({ where: { recordId: dispatch.tripId, field: "drumReturn" } });
  assert.equal(audit.role, "PLANT_OPERATOR", "the real actor's role, never an impersonated ACCOUNTANT");
});

// ======================================================================
// PL-P2-04 — closed allow-lists for return reasonCode/fate, and a
// one-way fate decision that can never be re-decided or set after the
// returned material was actually consumed.
// ======================================================================

test("closeTripWithReturnForId rejects an invalid reasonCode, fate, or volume before touching the database", async () => {
  const badReason = await closeTripWithReturnForId("nonexistent-trip-id", { allowedSiteId: null, ...actor(), returnedVolumeM3: 2, reasonCode: "TEST-SUITE-PL-MADE-UP-REASON", fate: null });
  assert.equal(badReason.status, "INVALID_REASON_CODE");

  // A reason is mandatory for every returned quantity (PL-R2-P2-04,
  // second production-lifecycle review) — null used to be accepted.
  const nullReason = await closeTripWithReturnForId("nonexistent-trip-id", { allowedSiteId: null, ...actor(), returnedVolumeM3: 2, reasonCode: null, fate: null });
  assert.equal(nullReason.status, "INVALID_REASON_CODE");

  const badFate = await closeTripWithReturnForId("nonexistent-trip-id", { allowedSiteId: null, ...actor(), returnedVolumeM3: 2, reasonCode: "OTHER", fate: "TEST-SUITE-PL-MADE-UP-FATE" });
  assert.equal(badFate.status, "INVALID_FATE");

  for (const bad of [0, -1, Infinity, NaN]) {
    const badVolume = await closeTripWithReturnForId("nonexistent-trip-id", { allowedSiteId: null, ...actor(), returnedVolumeM3: bad, reasonCode: "OTHER", fate: null });
    assert.equal(badVolume.status, "INVALID_VOLUME");
  }
});

test("setDrumReturnFateForId is a one-way decision, refused after the material was already consumed", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor(), returnedVolumeM3: 2, reasonCode: "OVER_ORDERED", fate: null });
  assert.equal(close.status, "OK");
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  const invalidFate = await setDrumReturnFateForId(drumReturn.id, "TEST-SUITE-PL-MADE-UP", { allowedSiteId: siteId, ...actor() });
  assert.equal(invalidFate.status, "INVALID_FATE");

  const first = await setDrumReturnFateForId(drumReturn.id, "RECLAIMED", { allowedSiteId: siteId, ...actor() });
  assert.equal(first.status, "OK");

  const second = await setDrumReturnFateForId(drumReturn.id, "DUMPED", { allowedSiteId: siteId, ...actor() });
  assert.equal(second.status, "ALREADY_SET");
  const stillReclaimed = await prisma.drumReturn.findUniqueOrThrow({ where: { id: drumReturn.id } });
  assert.equal(stillReclaimed.fate, "RECLAIMED");

  // Simulate the reclaim actually being consumed by a later trip (the
  // real consumption path is startTrip's own reclaim-credit block,
  // src/lib/tripDispatch.ts's applyReclaimCredit — out of scope for this
  // domain-only test) and confirm fate can never move again after that.
  await prisma.drumReturn.update({ where: { id: drumReturn.id }, data: { consumedAt: new Date() } });
  const afterConsumption = await setDrumReturnFateForId(drumReturn.id, "DUMPED", { allowedSiteId: siteId, ...actor() });
  assert.equal(afterConsumption.status, "ALREADY_CONSUMED");
});

test("setDrumReturnFateForId refuses a FULL_WASTE return — there is nothing left to reclaim", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceToDischarging(dispatch.tripId);
  // Backdate batchTime past the plant's default 90-minute drum timer so
  // the disposition math computes FULL_WASTE without a real 90-minute wait.
  await prisma.trip.update({ where: { id: dispatch.tripId }, data: { batchTime: new Date(Date.now() - 120 * 60000) } });
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor(), returnedVolumeM3: 2, reasonCode: "OVER_ORDERED", fate: null });
  assert.equal(close.status, "OK");
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);
  assert.equal(drumReturn.disposition, "FULL_WASTE");

  const result = await setDrumReturnFateForId(drumReturn.id, "RECLAIMED", { allowedSiteId: siteId, ...actor() });
  assert.equal(result.status, "NOT_ELIGIBLE");
});

// ======================================================================
// PL-P2-05 — database-level backstops behind every invariant above.
// ======================================================================

test("the database itself rejects an illegal Trip status, a duplicate open trip on the same truck, and same-person pump crew", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await assert.rejects(() => prisma.trip.update({ where: { id: dispatch.tripId }, data: { status: "TEST-SUITE-PL-NOT-A-REAL-STATUS" } }), /constraint|check/i);

  const ticket2 = await makeTicket(res);
  await assert.rejects(
    () => prisma.trip.create({ data: { batchTicketId: ticket2, truckId: truck, driverId: driver, status: "LOADING", batchTime: new Date() } }),
    /unique|constraint/i,
  );

  const crewMember = await makeCrew("OPERATOR");
  const pump = await makePump();
  const ticket3 = await makeTicket(res);
  const truck3 = await makeTruck();
  const driver3 = await makeDriver();
  await assert.rejects(
    () =>
      prisma.trip.create({
        data: { batchTicketId: ticket3, truckId: truck3, driverId: driver3, pumpId: pump, pumpOperatorId: crewMember, pumpAssistantId: crewMember, status: "LOADING", batchTime: new Date() },
      }),
    /constraint|check/i,
  );
});

test("the database itself blocks updating or deleting an AuditEvent row outside the test bypass", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceTripState(dispatch.tripId, "LOADING", { allowedSiteId: siteId, ...actor() });
  const audit = await prisma.auditEvent.findFirstOrThrow({ where: { recordId: dispatch.tripId } });

  await assert.rejects(() => prisma.auditEvent.update({ where: { id: audit.id }, data: { afterValue: "TEST-SUITE-PL-TAMPERED" } }), /immutable/i);
  await assert.rejects(() => prisma.auditEvent.delete({ where: { id: audit.id } }), /immutable/i);
});

// PL-R7-P1-01, seventh production-lifecycle review: AuditEvent.actorId's
// FK used to be ON DELETE SET NULL, which Postgres implements as an
// UPDATE on the audited row — one the immutability trigger above
// correctly refused, so a real hard delete of an audited user failed
// with a confusing "AuditEvent rows are immutable" error rather than a
// direct, correctly-worded FK violation. Migration
// harden_production_lifecycle_round7 changed the FK to ON DELETE
// RESTRICT instead; this proves it fails clean (a real FK violation,
// not the trigger) and that the audit row itself survives untouched.
test("the database refuses to hard-delete a User who still has an AuditEvent on file — a clean FK violation, not the immutability trigger", async () => {
  const throwawayUser = await prisma.user.create({
    data: { email: `test-suite-pl-throwaway-${Date.now()}@example.invalid`, name: "TEST-SUITE-PL-THROWAWAY", passwordHash: "not-a-real-hash", role: "ADMIN", status: "ACTIVE" },
  });
  const audit = await prisma.auditEvent.create({
    data: { actorId: throwawayUser.id, role: "ADMIN", module: "Fleet", recordId: "test-suite-pl-fk-restrict-check", reasonCode: "TEST_FIXTURE" },
  });

  // PL-R8-P2-01, eighth production-lifecycle review: "any rejection whose
  // text doesn't say immutable" is too weak — it would also pass for an
  // unrelated connection error or a completely different bug. Assert the
  // actual Prisma error class AND the real Postgres FK-violation SQLSTATE
  // (23503, wrapped as P2003) specifically, the same structured-matcher
  // discipline PL-R3-CI-03 already established for a different domain
  // function's own FK check.
  await assert.rejects(
    () => prisma.user.delete({ where: { id: throwawayUser.id } }),
    (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
  );
  const stillThere = await prisma.auditEvent.findUnique({ where: { id: audit.id } });
  assert.ok(stillThere, "the audit row itself must be completely untouched by the refused delete");

  // Clean up through the same bypass real teardown uses — proves the
  // ONLY sanctioned way to remove an audited user's history still works.
  await deleteAuditEventsByActor(throwawayUser.id);
  await prisma.user.delete({ where: { id: throwawayUser.id } });
});

// A structured matcher for a raw-query NOT NULL violation — PostgreSQL's
// own stable SQLSTATE (23502) wrapped by Prisma as P2010 with the real
// code inside meta.code, not a human-readable message string (PL-R3-CI-03,
// third production-lifecycle review: the driver's actual wording doesn't
// contain any of "null value"/"not-null"/"violates", so a text regex
// rejected a genuinely correct rejection).
function isNotNullViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2010" && String((error.meta as { code?: unknown } | undefined)?.code) === "23502";
}

// Deliberately does NOT pattern-match the error's exact shape (class,
// code, or message text) — a CHECK constraint and a trigger's own RAISE
// EXCEPTION can surface through Prisma's normal (non-raw) query path in
// more than one wrapped shape depending on Prisma/driver version, and
// PL-R3-CI-03 already showed how fragile matching wrapped text is. Every
// caller below pairs assert.rejects(fn) (any rejection at all — proof
// the write never applied) with a follow-up read confirming the row's
// actual value is unchanged, which is the real, version-independent
// proof of the invariant.
async function assertRejectedAndUnchanged<T>(fn: () => Promise<unknown>, readBack: () => Promise<T>): Promise<void> {
  const before = await readBack();
  await assert.rejects(fn);
  const after = await readBack();
  assert.deepEqual(after, before, "the rejected write must never have taken effect");
}

// Split into one assertion per invariant (PL-R3-P2-04) — the prior
// combined test aborted at its first failing assertion (the NOT NULL
// matcher bug above), which silently prevented every later bounds check
// in the same test from ever running at all.

test("the database itself requires a return reason (raw SQLSTATE 23502, not domain-layer text)", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  await advanceToDischarging(dispatch.tripId);

  await assert.rejects(
    () => prisma.$executeRawUnsafe(`INSERT INTO "DrumReturn" (id, "tripId", "returnedVolumeM3", "minutesSinceBatch", disposition) VALUES ($1, $2, 1, 0, 'NO_CHARGE')`, `test-suite-pl-dr-${Date.now()}`, dispatch.tripId),
    isNotNullViolation,
  );
});

test("the database itself bounds moisturePct to 0..100", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const component = await prisma.batchComponentActual.findFirstOrThrow({ where: { batchTicketId: ticket } });
  const readMoisture = () => prisma.batchComponentActual.findUniqueOrThrow({ where: { id: component.id }, select: { moisturePct: true } });
  await assertRejectedAndUnchanged(() => prisma.batchComponentActual.update({ where: { id: component.id }, data: { moisturePct: 150 } }), readMoisture);
  await assertRejectedAndUnchanged(() => prisma.batchComponentActual.update({ where: { id: component.id }, data: { moisturePct: -1 } }), readMoisture);
});

test("the database itself bounds Trip.volumeDeliveredM3 to its own ticket's volume", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const readDelivered = () => prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId }, select: { volumeDeliveredM3: true } });
  await assertRejectedAndUnchanged(() => prisma.trip.update({ where: { id: dispatch.tripId }, data: { volumeDeliveredM3: 999 } }), readDelivered);
});

test("the database itself bounds Trip.reclaimedVolumeM3 to its own ticket's volume", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const readReclaimed = () => prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId }, select: { reclaimedVolumeM3: true } });
  await assertRejectedAndUnchanged(() => prisma.trip.update({ where: { id: dispatch.tripId }, data: { reclaimedVolumeM3: 999 } }), readReclaimed);
});

test("the database itself bounds DrumReturn.returnedVolumeM3 to its trip ticket's volume, and WasteIncidentMemo.wastedVolumeM3 to its DrumReturn", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  await advanceToDischarging(dispatch.tripId);

  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 2, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);

  const readReturned = () => prisma.drumReturn.findUniqueOrThrow({ where: { id: drumReturn.id }, select: { returnedVolumeM3: true } });
  const readWasted = () => prisma.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memo.id }, select: { wastedVolumeM3: true } });
  await assertRejectedAndUnchanged(() => prisma.drumReturn.update({ where: { id: drumReturn.id }, data: { returnedVolumeM3: 999 } }), readReturned);
  await assertRejectedAndUnchanged(() => prisma.wasteIncidentMemo.update({ where: { id: memo.id }, data: { wastedVolumeM3: 999 } }), readWasted);
});

// PL-R3-P2-04 — the inverse direction: a PARENT quantity being lowered
// below an already-existing dependent child must be rejected too, not
// only an oversized child. No application code path ever updates
// BatchTicket.volumeM3 or DrumReturn.returnedVolumeM3 after creation, so
// this is a pure defensive database backstop, not a fix for a reachable
// application bug — proven with direct SQL/Prisma writes only.

test("the database itself refuses to lower a BatchTicket's volumeM3 below an existing dependent Trip/DrumReturn quantity", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(close.status, "OK");

  // Trip.volumeDeliveredM3 is now 8 — lowering the ticket's own volumeM3
  // below that must be refused.
  const readTicketVolume = () => prisma.batchTicket.findUniqueOrThrow({ where: { id: ticket }, select: { volumeM3: true } });
  await assertRejectedAndUnchanged(() => prisma.batchTicket.update({ where: { id: ticket }, data: { volumeM3: 3 } }), readTicketVolume);
  // Raising it, or leaving it unchanged, is never a problem.
  await prisma.batchTicket.update({ where: { id: ticket }, data: { volumeM3: 8 } });
});

test("the database itself refuses to lower a DrumReturn's returnedVolumeM3 below an existing WasteIncidentMemo's wastedVolumeM3", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 3, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);

  // The memo's own wastedVolumeM3 is 3 — lowering the return below that
  // must be refused.
  const readReturnedVolume = () => prisma.drumReturn.findUniqueOrThrow({ where: { id: drumReturn.id }, select: { returnedVolumeM3: true } });
  await assertRejectedAndUnchanged(() => prisma.drumReturn.update({ where: { id: drumReturn.id }, data: { returnedVolumeM3: 1 } }), readReturnedVolume);
  await prisma.drumReturn.update({ where: { id: drumReturn.id }, data: { returnedVolumeM3: 3 } });
});

// PL-R5-P2-02, fifth production-lifecycle review: drum_return_check_
// volume_bound reads Trip.batchTicketId without locking it, relying on
// an application-only convention that this identity FK never changes —
// true of every real code path, but not enforced by the database itself
// until the Round-5 migration below. These three tests prove that
// enforcement directly: re-parenting a Trip/DrumReturn/WasteIncidentMemo
// to a different owner is now rejected outright, closing the gap a
// direct SQL/maintenance write could otherwise have exploited (a real
// two-connection race test is unnecessary for this specific fix, unlike
// the volume-bound triggers above — immutability makes the race
// impossible rather than merely serializing it).
test("the database itself refuses to re-parent a Trip to a different BatchTicket", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res, { volumeM3: 8 });
  const ticketB = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticketA, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const readBatchTicketId = () => prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId }, select: { batchTicketId: true } });
  await assertRejectedAndUnchanged(() => prisma.trip.update({ where: { id: dispatch.tripId }, data: { batchTicketId: ticketB } }), readBatchTicketId);
});

test("the database itself refuses to re-parent a DrumReturn to a different Trip", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res, { volumeM3: 8 });
  const ticketB = await makeTicket(res, { volumeM3: 8 });
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);
  await advanceToDischarging(dispatchA.tripId);
  const close = await closeTripWithReturnForId(dispatchA.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 2, reasonCode: "OVER_ORDERED", fate: null });
  assert.equal(close.status, "OK");
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatchA.tripId } });
  drumReturnIds.push(drumReturn.id);

  const readTripId = () => prisma.drumReturn.findUniqueOrThrow({ where: { id: drumReturn.id }, select: { tripId: true } });
  await assertRejectedAndUnchanged(() => prisma.drumReturn.update({ where: { id: drumReturn.id }, data: { tripId: dispatchB.tripId } }), readTripId);
});

test("the database itself refuses to re-parent a WasteIncidentMemo to a different DrumReturn or BatchTicket", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res, { volumeM3: 8 });
  const ticketB = await makeTicket(res, { volumeM3: 8 });
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);
  await advanceToDischarging(dispatchA.tripId);
  await advanceToDischarging(dispatchB.tripId);
  const closeA = await closeTripWithReturnForId(dispatchA.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 2, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(closeA.status, "OK");
  const closeB = await closeTripWithReturnForId(dispatchB.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 2, reasonCode: "OVER_ORDERED", fate: null });
  assert.equal(closeB.status, "OK");
  const drumReturnA = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatchA.tripId } });
  drumReturnIds.push(drumReturnA.id);
  const drumReturnB = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatchB.tripId } });
  drumReturnIds.push(drumReturnB.id);
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticketA } });
  wasteMemoIds.push(memo.id);

  const readIdentity = () => prisma.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memo.id }, select: { drumReturnId: true, batchTicketId: true } });
  await assertRejectedAndUnchanged(() => prisma.wasteIncidentMemo.update({ where: { id: memo.id }, data: { drumReturnId: drumReturnB.id } }), readIdentity);
  await assertRejectedAndUnchanged(() => prisma.wasteIncidentMemo.update({ where: { id: memo.id }, data: { batchTicketId: ticketB } }), readIdentity);
});

// ======================================================================
// PL-R4-P1-02, fourth production-lifecycle review — the sequential bound
// tests above only prove each trigger correct in isolation; they say
// nothing about two genuinely concurrent transactions racing the SAME
// parent/child pair. The migration this round (harden_production_
// lifecycle_round4) made every child-side trigger take a locking read
// (SELECT ... FOR UPDATE) on its parent row before comparing, so the two
// directions now serialize on that shared row instead of each reading a
// pre-commit snapshot of the other. Four deterministic two-connection
// tests below prove both lock orders, for both relationships, using the
// same two-latch + waitUntilBlockedOn pattern as the Plant-transfer
// tests above — never a fixed sleep.
// ======================================================================

test("BatchTicket/Trip bound: a parent volumeM3 reduction holding the lock first makes a concurrent Trip increase wait, then reject against the reduced parent", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  let signalParentLocked: () => void;
  const parentLocked = new Promise<void>((resolve) => {
    signalParentLocked = resolve;
  });
  let releaseParent: () => void;
  const holdParent = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });

  try {
    // No Trip has claimed any of it yet, so lowering to 3 passes
    // batch_ticket_check_volume_lower_bound's own check (dependent max is
    // still 0) — this transaction's own UPDATE holds BatchTicket's row
    // lock until it commits. An explicit 20s timeout (well past
    // waitUntilBlockedOn's own 10s ceiling) — Prisma's 5s default
    // interactive-transaction timeout was what actually closed this
    // transaction out from under the test (PL-R5-P1-01).
    const parentTx = prisma2.$transaction(async (tx) => {
      await tx.batchTicket.update({ where: { id: ticket }, data: { volumeM3: 3 } });
      signalParentLocked();
      await holdParent;
    }, { timeout: 20_000 });
    await parentLocked;

    // trip_check_volume_bounds now takes FOR UPDATE on the BatchTicket
    // row before comparing — genuinely blocked behind the parent
    // transaction above, not racing it. startObserved (not a bare
    // reference) both sends the query eagerly and attaches its rejection
    // handler up front, so waitUntilBlockedOn is guaranteed something to
    // actually observe (PL-R5-P1-01).
    const childOutcome = startObserved(prisma.trip.update({ where: { id: dispatch.tripId }, data: { volumeDeliveredM3: 5 } }));
    await waitUntilBlockedOn(`SET "volumeDeliveredM3"`, 8_000);

    releaseParent!();
    await parentTx;

    const outcome = await childOutcome;
    assert.equal(outcome.status, "rejected", "5 exceeds the now-committed volumeM3 of 3");

    const finalTicket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticket }, select: { volumeM3: true } });
    assert.equal(finalTicket.volumeM3, 3);
    const finalTrip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId }, select: { volumeDeliveredM3: true } });
    assert.equal(finalTrip.volumeDeliveredM3, null, "the rejected child write must never have applied");
  } finally {
    releaseParent!();
    await prisma.batchTicket.update({ where: { id: ticket }, data: { volumeM3: 8 } });
  }
});

test("BatchTicket/Trip bound: a Trip increase holding the parent lock first makes a concurrent volumeM3 reduction wait, then reject against the committed child", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  let signalChildLocked: () => void;
  const childLocked = new Promise<void>((resolve) => {
    signalChildLocked = resolve;
  });
  let releaseChild: () => void;
  const holdChild = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });

  try {
    // 6 <= 8, passes trip_check_volume_bounds — but that trigger's own
    // locking read now holds the BatchTicket row's lock for the rest of
    // this transaction, exactly like an explicit lock would.
    const childTx = prisma2.$transaction(async (tx) => {
      await tx.trip.update({ where: { id: dispatch.tripId }, data: { volumeDeliveredM3: 6 } });
      signalChildLocked();
      await holdChild;
    }, { timeout: 20_000 });
    await childLocked;

    const parentOutcome = startObserved(prisma.batchTicket.update({ where: { id: ticket }, data: { volumeM3: 3 } }));
    await waitUntilBlockedOn(`SET "volumeM3"`, 8_000);

    releaseChild!();
    await childTx;

    const outcome = await parentOutcome;
    assert.equal(outcome.status, "rejected", "3 is below the now-committed Trip.volumeDeliveredM3 of 6");

    const finalTicket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticket }, select: { volumeM3: true } });
    assert.equal(finalTicket.volumeM3, 8, "the rejected parent write must never have applied");
    const finalTrip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId }, select: { volumeDeliveredM3: true } });
    assert.equal(finalTrip.volumeDeliveredM3, 6);
  } finally {
    releaseChild!();
    await prisma.batchTicket.update({ where: { id: ticket }, data: { volumeM3: 8 } });
  }
});

test("DrumReturn/WasteIncidentMemo bound: a parent returnedVolumeM3 reduction holding the lock first makes a concurrent memo increase wait, then reject against the reduced parent", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  await advanceToDischarging(dispatch.tripId);
  // OVER_ORDERED, not QUALITY_REJECTED — creates the DrumReturn without
  // its own auto-created WasteIncidentMemo, so a memo can be inserted
  // directly below with whatever wastedVolumeM3 this test needs.
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 6, reasonCode: "OVER_ORDERED", fate: null });
  assert.equal(close.status, "OK");
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);
  const memo = await prisma.wasteIncidentMemo.create({ data: { drumReturnId: drumReturn.id, batchTicketId: ticket, wastedVolumeM3: 2, reasonCode: "QUALITY_REJECTED" } });
  wasteMemoIds.push(memo.id);

  let signalParentLocked: () => void;
  const parentLocked = new Promise<void>((resolve) => {
    signalParentLocked = resolve;
  });
  let releaseParent: () => void;
  const holdParent = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });

  try {
    // 3 >= the memo's own 2, passes drum_return_check_volume_lower_bound.
    const parentTx = prisma2.$transaction(async (tx) => {
      await tx.drumReturn.update({ where: { id: drumReturn.id }, data: { returnedVolumeM3: 3 } });
      signalParentLocked();
      await holdParent;
    }, { timeout: 20_000 });
    await parentLocked;

    const childOutcome = startObserved(prisma.wasteIncidentMemo.update({ where: { id: memo.id }, data: { wastedVolumeM3: 5 } }));
    await waitUntilBlockedOn(`SET "wastedVolumeM3"`, 8_000);

    releaseParent!();
    await parentTx;

    const outcome = await childOutcome;
    assert.equal(outcome.status, "rejected", "5 exceeds the now-committed returnedVolumeM3 of 3");

    const finalReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { id: drumReturn.id }, select: { returnedVolumeM3: true } });
    assert.equal(finalReturn.returnedVolumeM3, 3);
    const finalMemo = await prisma.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memo.id }, select: { wastedVolumeM3: true } });
    assert.equal(finalMemo.wastedVolumeM3, 2, "the rejected child write must never have applied");
  } finally {
    releaseParent!();
  }
});

test("DrumReturn/WasteIncidentMemo bound: a memo increase holding the parent lock first makes a concurrent returnedVolumeM3 reduction wait, then reject against the committed child", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  await advanceToDischarging(dispatch.tripId);
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 6, reasonCode: "OVER_ORDERED", fate: null });
  assert.equal(close.status, "OK");
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);
  const memo = await prisma.wasteIncidentMemo.create({ data: { drumReturnId: drumReturn.id, batchTicketId: ticket, wastedVolumeM3: 2, reasonCode: "QUALITY_REJECTED" } });
  wasteMemoIds.push(memo.id);

  let signalChildLocked: () => void;
  const childLocked = new Promise<void>((resolve) => {
    signalChildLocked = resolve;
  });
  let releaseChild: () => void;
  const holdChild = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });

  try {
    // 5 <= the return's own 6, passes waste_memo_check_volume_bound — but
    // its own locking read now holds the DrumReturn row's lock for the
    // rest of this transaction.
    const childTx = prisma2.$transaction(async (tx) => {
      await tx.wasteIncidentMemo.update({ where: { id: memo.id }, data: { wastedVolumeM3: 5 } });
      signalChildLocked();
      await holdChild;
    }, { timeout: 20_000 });
    await childLocked;

    const parentOutcome = startObserved(prisma.drumReturn.update({ where: { id: drumReturn.id }, data: { returnedVolumeM3: 3 } }));
    await waitUntilBlockedOn(`SET "returnedVolumeM3"`, 8_000);

    releaseChild!();
    await childTx;

    const outcome = await parentOutcome;
    assert.equal(outcome.status, "rejected", "3 is below the now-committed WasteIncidentMemo.wastedVolumeM3 of 5");

    const finalReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { id: drumReturn.id }, select: { returnedVolumeM3: true } });
    assert.equal(finalReturn.returnedVolumeM3, 6, "the rejected parent write must never have applied");
    const finalMemo = await prisma.wasteIncidentMemo.findUniqueOrThrow({ where: { id: memo.id }, select: { wastedVolumeM3: true } });
    assert.equal(finalMemo.wastedVolumeM3, 5);
  } finally {
    releaseChild!();
  }
});

// ======================================================================
// PL-R2-P2-05 — the cross-column pump-crew collision trigger must be a
// genuine, independent database backstop: correct even when both
// callers use plain READ COMMITTED (Postgres's own default), not only
// when every caller happens to use Serializable isolation.
// ======================================================================

test("the pump-crew collision trigger serializes two genuinely concurrent READ COMMITTED connections, using its own advisory lock", async () => {
  const res = await makeReservation({ deliveryMethod: "PUMP" });
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const pumpA = await makePump();
  const pumpB = await makePump();
  const crewMember = await makeCrew("OPERATOR");

  // Two separate connections (prisma, prisma2), neither requesting
  // Serializable isolation — plain default READ COMMITTED, the case the
  // prior version of this trigger explicitly could not handle safely on
  // its own (its own comment said so).
  const [resultA, resultB] = await Promise.allSettled([
    prisma.trip.create({ data: { batchTicketId: ticketA, truckId: truckA, driverId: driverA, pumpId: pumpA, pumpOperatorId: crewMember, status: "LOADING", batchTime: new Date() } }),
    prisma2.trip.create({ data: { batchTicketId: ticketB, truckId: truckB, driverId: driverB, pumpId: pumpB, pumpOperatorId: crewMember, status: "LOADING", batchTime: new Date() } }),
  ]);

  const fulfilled = [resultA, resultB].filter((r) => r.status === "fulfilled");
  const rejected = [resultA, resultB].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one of the two concurrent trips may claim this crew member");
  assert.equal(rejected.length, 1);
  if (rejected[0].status === "rejected") assert.match(String(rejected[0].reason), /already the operator or assistant/i);
  for (const r of fulfilled) {
    if (r.status === "fulfilled") tripIds.push(r.value.id);
  }
});

// ======================================================================
// PL-R4-P2-04, fourth production-lifecycle review — reassignTrip itself
// (not just startTripForTicket/advanceTripState, already covered above)
// needs its own concurrency coverage: a Plant transfer racing a
// reassignment, and reassignments racing each other for the same truck,
// driver, or pump crew member. reassignTrip uses Serializable isolation
// + withRetry (src/lib/tripAssignment.ts's own comment on why), so a
// plain Promise.all is enough to prove exactly one side wins — Postgres's
// own write-skew detection under true SERIALIZABLE aborts the loser with
// a serialization failure, which withRetry re-runs against a fresh
// snapshot that then correctly sees the resource as busy. No manual
// latch is needed for the same-resource races below; the Plant-transfer
// race still needs one, same reasoning as the existing Plant-transfer
// tests above.
// ======================================================================

test("a concurrent Plant transfer also blocks and is correctly re-checked by reassignTrip", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck1 = await makeTruck();
  const driver1 = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driver1, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  const truck2 = await makeTruck();
  const driver2 = await makeDriver();

  let signalTransferLocked: () => void;
  const transferLocked = new Promise<void>((resolve) => {
    signalTransferLocked = resolve;
  });
  let releaseTransfer: () => void;
  const holdTransfer = new Promise<void>((resolve) => {
    releaseTransfer = resolve;
  });

  try {
    const transferTx = prisma2.$transaction(async (tx) => {
      await tx.plant.update({ where: { id: plantId }, data: { siteId: siteBId } });
      signalTransferLocked();
      await holdTransfer;
    });
    await transferLocked;

    // reassignTrip locks the Trip (uncontested) then tries to lock the
    // ticket's own Plant row (lockPlantSiteId) — held by the transfer
    // above, so this genuinely blocks.
    const reassignPromise = reassignTrip(dispatch.tripId, {
      truckId: truck2,
      driverId: driver2,
      pumpId: null,
      pumpOperatorId: null,
      pumpAssistantId: null,
      allowedSiteId: siteId,
      ...actor(),
    });
    await waitUntilBlockedOn(`FROM "Plant"`);

    releaseTransfer!();
    await transferTx;

    const result = await reassignPromise;
    assert.equal(result.status, "NOT_FOUND", "the plant now belongs to a different site than the actor's own allowed scope");

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
    assert.equal(trip.truckId, truck1, "a refused authorization check must never have reassigned the trip");
  } finally {
    releaseTransfer!();
    await prisma.plant.update({ where: { id: plantId }, data: { siteId } });
  }
});

// PL-R5-P2-06, fifth production-lifecycle review: the Plant-transfer
// races above all transfer the TICKET's own plant. claimTripResources
// separately locks the SELECTED truck's and pump's own plant too
// (lockPlantSiteId at tripAssignment.ts:95/119) — this was implemented
// but never actually proven with a two-connection test. Each test below
// gives the truck/pump its own dedicated Plant (distinct from the
// shared fixture plant every ticket lives on), so transferring THAT
// specific plant can't be confused with the ticket's-own-plant races
// already covered.

test("a concurrent transfer of the SELECTED TRUCK's own Plant blocks startTripForTicket, and is correctly re-checked", async () => {
  const truckPlant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-PL-TRUCK-PLANT" } });
  extraPlantIds.push(truckPlant.id);
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck({ plantId: truckPlant.id });
  const driver = await makeDriver();

  let signalTransferLocked: () => void;
  const transferLocked = new Promise<void>((resolve) => {
    signalTransferLocked = resolve;
  });
  let releaseTransfer: () => void;
  const holdTransfer = new Promise<void>((resolve) => {
    releaseTransfer = resolve;
  });

  try {
    const transferTx = prisma2.$transaction(async (tx) => {
      await tx.plant.update({ where: { id: truckPlant.id }, data: { siteId: siteBId } });
      signalTransferLocked();
      await holdTransfer;
    });
    await transferLocked;

    // claimTripResources locks the ticket's own plant (uncontested, a
    // different row), validates the truck exists, then tries to lock
    // the TRUCK's own plant — held by the transfer above.
    const dispatchOutcome = startObserved(dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId }));
    await waitUntilBlockedOn(`FROM "Plant"`, 8_000);

    releaseTransfer!();
    await transferTx;

    const outcome = await dispatchOutcome;
    assert.equal(outcome.status, "fulfilled", "startTripForTicket must return a typed result, not throw");
    if (outcome.status === "fulfilled") {
      assert.equal(outcome.value.status, "TRUCK_OUT_OF_SCOPE", "the truck's plant now belongs to a different site than the actor's own allowed scope");
    }

    const tripCount = await prisma.trip.count({ where: { batchTicketId: ticket } });
    assert.equal(tripCount, 0, "a refused authorization check must never have dispatched a trip");
  } finally {
    releaseTransfer!();
    await prisma.plant.update({ where: { id: truckPlant.id }, data: { siteId } });
  }
});

test("a concurrent transfer of the SELECTED TRUCK's own Plant blocks reassignTrip, and is correctly re-checked", async () => {
  const truckPlant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-PL-TRUCK-PLANT-2" } });
  extraPlantIds.push(truckPlant.id);
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const originalTruck = await makeTruck();
  const driver1 = await makeDriver();
  const driver2 = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: originalTruck, driverId: driver1, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);
  const newTruck = await makeTruck({ plantId: truckPlant.id });

  let signalTransferLocked: () => void;
  const transferLocked = new Promise<void>((resolve) => {
    signalTransferLocked = resolve;
  });
  let releaseTransfer: () => void;
  const holdTransfer = new Promise<void>((resolve) => {
    releaseTransfer = resolve;
  });

  try {
    const transferTx = prisma2.$transaction(async (tx) => {
      await tx.plant.update({ where: { id: truckPlant.id }, data: { siteId: siteBId } });
      signalTransferLocked();
      await holdTransfer;
    });
    await transferLocked;

    const reassignOutcome = startObserved(
      reassignTrip(dispatch.tripId, { truckId: newTruck, driverId: driver2, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() }),
    );
    await waitUntilBlockedOn(`FROM "Plant"`, 8_000);

    releaseTransfer!();
    await transferTx;

    const outcome = await reassignOutcome;
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") assert.equal(outcome.value.status, "TRUCK_OUT_OF_SCOPE");

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
    assert.equal(trip.truckId, originalTruck, "a refused authorization check must never have reassigned the trip");
  } finally {
    releaseTransfer!();
    await prisma.plant.update({ where: { id: truckPlant.id }, data: { siteId } });
  }
});

test("a concurrent transfer of the SELECTED PUMP's own Plant blocks a pump-delivery dispatch, and is correctly re-checked", async () => {
  const pumpPlant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-PL-PUMP-PLANT" } });
  extraPlantIds.push(pumpPlant.id);
  const res = await makeReservation({ deliveryMethod: "PUMP" });
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const pump = await makePump({ plantId: pumpPlant.id });
  const operator = await makeCrew("OPERATOR");

  let signalTransferLocked: () => void;
  const transferLocked = new Promise<void>((resolve) => {
    signalTransferLocked = resolve;
  });
  let releaseTransfer: () => void;
  const holdTransfer = new Promise<void>((resolve) => {
    releaseTransfer = resolve;
  });

  try {
    const transferTx = prisma2.$transaction(async (tx) => {
      await tx.plant.update({ where: { id: pumpPlant.id }, data: { siteId: siteBId } });
      signalTransferLocked();
      await holdTransfer;
    });
    await transferLocked;

    const dispatchOutcome = startObserved(dispatchTrip(ticket, { truckId: truck, driverId: driver, allowedSiteId: siteId, pumpId: pump, pumpOperatorId: operator }));
    await waitUntilBlockedOn(`FROM "Plant"`, 8_000);

    releaseTransfer!();
    await transferTx;

    const outcome = await dispatchOutcome;
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") {
      assert.equal(outcome.value.status, "PUMP_OUT_OF_SCOPE", "the pump's plant now belongs to a different site than the actor's own allowed scope");
    }

    const tripCount = await prisma.trip.count({ where: { batchTicketId: ticket } });
    assert.equal(tripCount, 0, "a refused authorization check must never have dispatched a trip");
  } finally {
    releaseTransfer!();
    await prisma.plant.update({ where: { id: pumpPlant.id }, data: { siteId } });
  }
});

test("two concurrent reassignments contending for the same truck have exactly one winner, and the loser sees TRUCK_BUSY", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const sharedTruck = await makeTruck();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  const [resultA, resultB] = await Promise.all([
    reassignTrip(dispatchA.tripId, { truckId: sharedTruck, driverId: driverA, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() }),
    reassignTrip(dispatchB.tripId, { truckId: sharedTruck, driverId: driverB, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() }),
  ]);
  const statuses = [resultA.status, resultB.status].sort();
  assert.deepEqual(statuses, ["OK", "TRUCK_BUSY"], "exactly one reassignment may claim the shared truck");

  const [tripA, tripB] = await Promise.all([
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchA.tripId } }),
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchB.tripId } }),
  ]);
  const claimants = [tripA, tripB].filter((t) => t.truckId === sharedTruck);
  assert.equal(claimants.length, 1, "the shared truck must end up assigned to exactly one of the two trips");
});

test("two concurrent reassignments contending for the same driver have exactly one winner, and the loser sees DRIVER_BUSY", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const sharedDriver = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  const [resultA, resultB] = await Promise.all([
    reassignTrip(dispatchA.tripId, { truckId: truckA, driverId: sharedDriver, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() }),
    reassignTrip(dispatchB.tripId, { truckId: truckB, driverId: sharedDriver, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() }),
  ]);
  const statuses = [resultA.status, resultB.status].sort();
  assert.deepEqual(statuses, ["DRIVER_BUSY", "OK"], "exactly one reassignment may claim the shared driver");

  const [tripA, tripB] = await Promise.all([
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchA.tripId } }),
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchB.tripId } }),
  ]);
  const claimants = [tripA, tripB].filter((t) => t.driverId === sharedDriver);
  assert.equal(claimants.length, 1, "the shared driver must end up assigned to exactly one of the two trips");
});

// PL-R5-P2-01, fifth production-lifecycle review: the previous version
// of this test created its "shared crew member" with role OPERATOR, then
// submitted that same id as the OTHER trip's pumpAssistantId.
// claimTripResources intentionally requires operator.role === "OPERATOR"
// AND assistant.role === "HELPER" — no roster member can ever satisfy
// both, so that reassignment always failed on PUMP_ASSISTANT_INVALID
// before it ever reached the busy check, proving nothing about
// contention. Fixed as two separate, valid-role domain tests (same
// column, contended) plus one direct-DB test below that bypasses
// reassignTrip/claimTripResources entirely to prove the trigger's own
// cross-column backstop independent of the domain's role validation.

test("two concurrent reassignments contending for the same pump OPERATOR have exactly one winner", async () => {
  const res = await makeReservation({ deliveryMethod: "PUMP" });
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const pumpA = await makePump();
  const pumpB = await makePump();
  const operatorA = await makeCrew("OPERATOR");
  const operatorB = await makeCrew("OPERATOR");
  const sharedOperator = await makeCrew("OPERATOR");
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId, pumpId: pumpA, pumpOperatorId: operatorA });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId, pumpId: pumpB, pumpOperatorId: operatorB });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  // Promise.allSettled: the backstop that actually decides the loser here
  // is the advisory-lock trigger (trip_check_pump_crew_collision), which
  // BLOCKS the second UPDATE until the first commits, then RAISES —
  // surfacing as a rejected promise, not always a typed CREW_BUSY result.
  // claimTripResources' own plain-read busy check can still win the race
  // in either transaction's favor depending on timing, so the loser may
  // legitimately come back as either shape (same reasoning already
  // established for the truck/driver races above, but the trigger raise
  // is possible here in a way it never is for truck/driver).
  const [resultA, resultB] = await Promise.allSettled([
    reassignTrip(dispatchA.tripId, { truckId: truckA, driverId: driverA, pumpId: pumpA, pumpOperatorId: sharedOperator, pumpAssistantId: null, allowedSiteId: siteId, ...actor() }),
    reassignTrip(dispatchB.tripId, { truckId: truckB, driverId: driverB, pumpId: pumpB, pumpOperatorId: sharedOperator, pumpAssistantId: null, allowedSiteId: siteId, ...actor() }),
  ]);
  const winners = [resultA, resultB].filter((r) => r.status === "fulfilled" && r.value.status === "OK");
  const losers = [resultA, resultB].filter((r) => !(r.status === "fulfilled" && r.value.status === "OK"));
  assert.equal(winners.length, 1, "exactly one reassignment may claim the shared pump operator");
  assert.equal(losers.length, 1);
  const loser = losers[0];
  if (loser.status === "rejected") {
    assert.match(String(loser.reason), /already the operator or assistant/i);
  } else {
    assert.equal(loser.value.status, "CREW_BUSY");
  }

  const [tripA, tripB] = await Promise.all([
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchA.tripId } }),
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchB.tripId } }),
  ]);
  const claimants = [tripA, tripB].filter((t) => t.pumpOperatorId === sharedOperator);
  assert.equal(claimants.length, 1, "the shared operator must end up assigned to exactly one of the two trips");
});

test("two concurrent reassignments contending for the same pump HELPER (assistant) have exactly one winner", async () => {
  const res = await makeReservation({ deliveryMethod: "PUMP" });
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const pumpA = await makePump();
  const pumpB = await makePump();
  const operatorA = await makeCrew("OPERATOR");
  const operatorB = await makeCrew("OPERATOR");
  const sharedHelper = await makeCrew("HELPER");
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, allowedSiteId: siteId, pumpId: pumpA, pumpOperatorId: operatorA });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, allowedSiteId: siteId, pumpId: pumpB, pumpOperatorId: operatorB });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  const [resultA, resultB] = await Promise.allSettled([
    reassignTrip(dispatchA.tripId, { truckId: truckA, driverId: driverA, pumpId: pumpA, pumpOperatorId: operatorA, pumpAssistantId: sharedHelper, allowedSiteId: siteId, ...actor() }),
    reassignTrip(dispatchB.tripId, { truckId: truckB, driverId: driverB, pumpId: pumpB, pumpOperatorId: operatorB, pumpAssistantId: sharedHelper, allowedSiteId: siteId, ...actor() }),
  ]);
  const winners = [resultA, resultB].filter((r) => r.status === "fulfilled" && r.value.status === "OK");
  const losers = [resultA, resultB].filter((r) => !(r.status === "fulfilled" && r.value.status === "OK"));
  assert.equal(winners.length, 1, "exactly one reassignment may claim the shared pump helper");
  assert.equal(losers.length, 1);
  const loser = losers[0];
  if (loser.status === "rejected") {
    assert.match(String(loser.reason), /already the operator or assistant/i);
  } else {
    assert.equal(loser.value.status, "CREW_BUSY");
  }

  const [tripA, tripB] = await Promise.all([
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchA.tripId } }),
    prisma.trip.findUniqueOrThrow({ where: { id: dispatchB.tripId } }),
  ]);
  const claimants = [tripA, tripB].filter((t) => t.pumpAssistantId === sharedHelper);
  assert.equal(claimants.length, 1, "the shared helper must end up assigned to exactly one of the two trips");
});

test("the pump-crew collision trigger catches a genuine cross-column collision (operator column vs. assistant column) at the database level, independent of domain role validation", async () => {
  const res = await makeReservation({ deliveryMethod: "PUMP" });
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const pumpA = await makePump();
  const pumpB = await makePump();
  // A single crew member's role never matters to the trigger — it only
  // ever compares raw ids in the pumpOperatorId/pumpAssistantId columns
  // (PL-R5-P2-01) — so one role is enough to prove this independent of
  // claimTripResources' own domain-level role check, which these two raw
  // trip.create calls bypass entirely, the same way a direct maintenance
  // write or a future domain bug could.
  const sharedCrewMember = await makeCrew("OPERATOR");

  const [resultA, resultB] = await Promise.allSettled([
    prisma.trip.create({ data: { batchTicketId: ticketA, truckId: truckA, driverId: driverA, pumpId: pumpA, pumpOperatorId: sharedCrewMember, status: "LOADING", batchTime: new Date() } }),
    prisma2.trip.create({ data: { batchTicketId: ticketB, truckId: truckB, driverId: driverB, pumpId: pumpB, pumpAssistantId: sharedCrewMember, status: "LOADING", batchTime: new Date() } }),
  ]);

  const fulfilled = [resultA, resultB].filter((r) => r.status === "fulfilled");
  const rejected = [resultA, resultB].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one of the two concurrent trips may claim this crew member, even across different columns");
  assert.equal(rejected.length, 1);
  if (rejected[0].status === "rejected") assert.match(String(rejected[0].reason), /already the operator or assistant/i);
  for (const r of fulfilled) {
    if (r.status === "fulfilled") tripIds.push(r.value.id);
  }
});
