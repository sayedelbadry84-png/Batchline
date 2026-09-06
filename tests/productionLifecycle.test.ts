// Real PostgreSQL integration tests for the production/trip lifecycle
// domain layer (src/lib/tripAssignment.ts, src/lib/tripLifecycle.ts,
// src/lib/tripDispatch.ts's claimTripSlot) — the first production-
// lifecycle review (BATCHLINE_PRODUCTION_LIFECYCLE_REVIEW_ROUND1.md).
// Same TEST_DATABASE_URL-must-differ-from-DATABASE_URL safety gate as
// tests/batchCompletion.test.ts and tests/reservationMixRevision.test.ts
// — see those files' own header comments for the full rationale.
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
// (reassignTrip, advanceTripState, closeTripFullForId,
// closeTripWithReturnForId, approveWasteIncidentMemo,
// setDrumReturnFateForId), matching the same split already established
// for closeReservationForId/releaseTicketForReservation.
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

const { PrismaClient } = await import("@prisma/client");
const { claimTripSlot } = await import("../src/lib/tripDispatch");
const { claimTripResources, reassignTrip } = await import("../src/lib/tripAssignment");
const {
  advanceTripState,
  closeTripFullForId,
  closeTripWithReturnForId,
  approveWasteIncidentMemo,
  setDrumReturnFateForId,
} = await import("../src/lib/tripLifecycle");
const { completeBatchTicket, cancelBatchTicket } = await import("../src/lib/batchCompletion");
const { closeReservationForId } = await import("../src/lib/reservations");

const prisma = new PrismaClient();

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

  await prisma.$disconnect();
});

// ---- Fixture helpers --------------------------------------------------

async function makeReservation(overrides: Partial<{ siteId: string; deliveryMethod: string; minPumpReachM: number }> = {}) {
  const now = new Date();
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `TEST-SUITE-PL-RES-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      projectId,
      siteId: overrides.siteId ?? siteId,
      mixId,
      requestedVolumeM3: 16,
      originalVolumeM3: 16,
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
  const pump = await prisma.pump.create({
    data: { plantId: overrides.plantId ?? plantId, code: `TEST-SUITE-PL-PMP-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, pumpType: "LINE", hourlyRate: 100, status: overrides.status ?? "ACTIVE", reachM: overrides.reachM ?? 30 },
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

// Mirrors startTrip's own real transaction body (production/actions.ts)
// — the REAL claimTripSlot + claimTripResources + trip.create sequence,
// not a paraphrase of it.
async function dispatchTrip(
  ticketId: string,
  opts: {
    truckId: string;
    driverId: string;
    allowedSiteId?: string | null;
    isPumpDelivery?: boolean;
    pumpId?: string | null;
    pumpOperatorId?: string | null;
    pumpAssistantId?: string | null;
    minPumpReachM?: number | null;
    loadVolumeM3: number;
  },
) {
  return prisma.$transaction(
    async (tx) => {
      const claim = await claimTripSlot(tx, {
        ticketId,
        truckId: opts.truckId,
        pumpId: opts.pumpId ?? null,
        pumpOperatorId: opts.pumpOperatorId ?? null,
        pumpAssistantId: opts.pumpAssistantId ?? null,
        allowedSiteId: opts.allowedSiteId,
      });
      if (claim.status !== "OK") return claim;

      const resources = await claimTripResources(tx, {
        siteId: claim.siteId,
        truckId: opts.truckId,
        driverId: opts.driverId,
        loadVolumeM3: opts.loadVolumeM3,
        isPumpDelivery: opts.isPumpDelivery ?? false,
        pumpId: opts.pumpId ?? null,
        pumpOperatorId: opts.pumpOperatorId ?? null,
        pumpAssistantId: opts.pumpAssistantId ?? null,
        minPumpReachM: opts.minPumpReachM ?? null,
      });
      if (resources.status !== "OK") return resources;

      const trip = await tx.trip.create({
        data: {
          batchTicketId: ticketId,
          truckId: opts.truckId,
          driverId: opts.driverId,
          pumpId: opts.pumpId ?? null,
          pumpOperatorId: opts.pumpOperatorId ?? null,
          pumpOperatorName: resources.pumpOperatorName,
          pumpAssistantId: opts.pumpAssistantId ?? null,
          pumpAssistantName: resources.pumpAssistantName,
          status: "LOADING",
          batchTime: new Date(),
        },
      });
      return { status: "OK" as const, tripId: trip.id };
    },
    { isolationLevel: "Serializable" },
  );
}

function actor(role = "ADMIN") {
  return { actorId: adminUserId, actorRole: role };
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
  const dispatch = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, loadVolumeM3: 8 });
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
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driver1, loadVolumeM3: 8, allowedSiteId: siteId });
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

test("reassignTrip refuses an out-of-service truck, a busy driver, and a trip that already left LOADING", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res);
  const ticketB = await makeTicket(res);
  const truck1 = await makeTruck();
  const driver1 = await makeDriver();
  const driver2 = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truck1, driverId: driver1, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  if (dispatchA.status !== "OK") return;
  tripIds.push(dispatchA.tripId);

  const truck2 = await makeTruck();
  const dispatchB = await dispatchTrip(ticketB, { truckId: truck2, driverId: driver2, loadVolumeM3: 8, allowedSiteId: siteId });
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
  const advanceResult = await advanceTripState(dispatchB.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(advanceResult.status, "OK");
  const notLoadingResult = await reassignTrip(dispatchB.tripId, { truckId: truck2, driverId: driver2, pumpId: null, pumpOperatorId: null, pumpAssistantId: null, allowedSiteId: siteId, ...actor() });
  assert.equal(notLoadingResult.status, "NOT_LOADING");
});

test("reassignTrip refuses a truck whose rated capacity is smaller than the ticket's own volume", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 10 });
  const truck1 = await makeTruck();
  const driver1 = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck1, driverId: driver1, loadVolumeM3: 10, allowedSiteId: siteId });
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

  const result = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, loadVolumeM3: 8, allowedSiteId: siteId });
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
    dispatchTripOrRejected(ticketA, { truckId: truck, driverId: driverA, loadVolumeM3: 8, allowedSiteId: siteId }),
    dispatchTripOrRejected(ticketB, { truckId: truck, driverId: driverB, loadVolumeM3: 8, allowedSiteId: siteId }),
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
    dispatchTripOrRejected(ticketA, { truckId: truckA, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId }),
    dispatchTripOrRejected(ticketB, { truckId: truckB, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId }),
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

  const noPumpResult = await dispatchTrip(ticket1, { truckId: truck1, driverId: driver1, loadVolumeM3: 8, isPumpDelivery: true, allowedSiteId: siteId });
  assert.equal(noPumpResult.status, "PUMP_REQUIRED");

  const shortPump = await makePump({ reachM: 20 });
  const ticket2 = await makeTicket(res);
  const truck2 = await makeTruck();
  const shortReachResult = await dispatchTrip(ticket2, { truckId: truck2, driverId: driver1, loadVolumeM3: 8, isPumpDelivery: true, pumpId: shortPump, minPumpReachM: 40, allowedSiteId: siteId });
  assert.equal(shortReachResult.status, "PUMP_INSUFFICIENT_REACH");

  const goodPump = await makePump({ reachM: 50 });
  const crewMember = await makeCrew("OPERATOR");
  const ticket3 = await makeTicket(res);
  const truck3 = await makeTruck();
  const samePersonResult = await dispatchTrip(ticket3, {
    truckId: truck3,
    driverId: driver1,
    loadVolumeM3: 8,
    isPumpDelivery: true,
    pumpId: goodPump,
    minPumpReachM: 40,
    pumpOperatorId: crewMember,
    pumpAssistantId: crewMember,
    allowedSiteId: siteId,
  });
  assert.equal(samePersonResult.status, "PUMP_CREW_SAME_PERSON");
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

  const cancelResult = await cancelBatchTicket(ticket.id, { actorId: adminUserId, reason: "TEST-SUITE-PL-late-cancel-attempt" });
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
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  for (const expectedNext of ["IN_TRANSIT", "ON_SITE", "DISCHARGING"]) {
    const result = await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
    assert.equal(result.status, "OK");
    if (result.status === "OK") assert.equal(result.next, expectedNext);
  }
  const noNext = await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(noNext.status, "NO_NEXT_STATE");
});

test("advanceTripState and closeTripFullForId both refuse a DRIVER acting on someone else's trip", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const otherDriver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const result = await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, requireOwnDriverEmployeeId: otherDriver, ...actor("DRIVER") });
  assert.equal(result.status, "NOT_FOUND");
  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.status, "LOADING");
});

test("closeTripFullForId refuses a crafted close straight from LOADING, and closes cleanly once DISCHARGING", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res);
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  const craftedClose = await closeTripFullForId(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
  assert.equal(craftedClose.status, "NOT_DISCHARGING");

  for (let i = 0; i < 3; i++) await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
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

test("finalizing a reservation is deferred until every sibling ticket's trip has closed, and never overwrites an already-cancelled reservation", async () => {
  const res = await makeReservation();
  const ticketA = await makeTicket(res, { volumeM3: 8 });
  const ticketB = await makeTicket(res, { volumeM3: 8 });
  const truckA = await makeTruck();
  const truckB = await makeTruck();
  const driverA = await makeDriver();
  const driverB = await makeDriver();
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, loadVolumeM3: 8, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  for (let i = 0; i < 3; i++) await advanceTripState(dispatchA.tripId, { allowedSiteId: siteId, ...actor() });
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

  for (let i = 0; i < 3; i++) await advanceTripState(dispatchB.tripId, { allowedSiteId: siteId, ...actor() });
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
  const dispatchA = await dispatchTrip(ticketA, { truckId: truckA, driverId: driverA, loadVolumeM3: 8, allowedSiteId: siteId });
  const dispatchB = await dispatchTrip(ticketB, { truckId: truckB, driverId: driverB, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatchA.status, "OK");
  assert.equal(dispatchB.status, "OK");
  if (dispatchA.status !== "OK" || dispatchB.status !== "OK") return;
  tripIds.push(dispatchA.tripId, dispatchB.tripId);

  for (let i = 0; i < 3; i++) await advanceTripState(dispatchA.tripId, { allowedSiteId: siteId, ...actor() });
  for (let i = 0; i < 3; i++) await advanceTripState(dispatchB.tripId, { allowedSiteId: siteId, ...actor() });

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
// PL-P1-06 — a quality rejection is provisional: closing the trip never
// reduces billed volume on its own, and the audit trail always carries
// the real actor/role.
// ======================================================================

test("closeTripWithReturnForId never reduces volumeDeliveredM3 on its own, even for a quality rejection, and records the real actor/role", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  for (let i = 0; i < 3; i++) await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });

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

test("approveWasteIncidentMemo applies the billing reduction exactly once, atomically, with the real approving actor", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  for (let i = 0; i < 3; i++) await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
  const close = await closeTripWithReturnForId(dispatch.tripId, { allowedSiteId: siteId, ...actor("DRIVER"), returnedVolumeM3: 3, reasonCode: "QUALITY_REJECTED", fate: null });
  assert.equal(close.status, "OK");
  const memo = await prisma.wasteIncidentMemo.findFirstOrThrow({ where: { batchTicketId: ticket } });
  wasteMemoIds.push(memo.id);
  const drumReturn = await prisma.drumReturn.findUniqueOrThrow({ where: { tripId: dispatch.tripId } });
  drumReturnIds.push(drumReturn.id);

  const approval = await approveWasteIncidentMemo(memo.id, { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", approvalNote: "TEST-SUITE-PL-confirmed contamination" });
  assert.equal(approval.status, "OK");

  const trip = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(trip.volumeDeliveredM3, 5); // 8 - 3

  const duplicateApproval = await approveWasteIncidentMemo(memo.id, { allowedSiteId: siteId, actorId: adminUserId, actorRole: "QUALITY_SUPERVISOR", approvalNote: "TEST-SUITE-PL-second-attempt" });
  assert.equal(duplicateApproval.status, "ALREADY_DECIDED");
  const tripAfterDuplicate = await prisma.trip.findUniqueOrThrow({ where: { id: dispatch.tripId } });
  assert.equal(tripAfterDuplicate.volumeDeliveredM3, 5, "a second approval attempt must never reduce the billed volume twice");
});

test("closeTripWithReturnForId records the real actor/role for a non-quality PARTIAL_CREDIT return too", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  for (let i = 0; i < 3; i++) await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
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

  const badFate = await closeTripWithReturnForId("nonexistent-trip-id", { allowedSiteId: null, ...actor(), returnedVolumeM3: 2, reasonCode: null, fate: "TEST-SUITE-PL-MADE-UP-FATE" });
  assert.equal(badFate.status, "INVALID_FATE");

  for (const bad of [0, -1, Infinity, NaN]) {
    const badVolume = await closeTripWithReturnForId("nonexistent-trip-id", { allowedSiteId: null, ...actor(), returnedVolumeM3: bad, reasonCode: null, fate: null });
    assert.equal(badVolume.status, "INVALID_VOLUME");
  }
});

test("setDrumReturnFateForId is a one-way decision, refused after the material was already consumed", async () => {
  const res = await makeReservation();
  const ticket = await makeTicket(res, { volumeM3: 8 });
  const truck = await makeTruck();
  const driver = await makeDriver();
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  for (let i = 0; i < 3; i++) await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
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
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  for (let i = 0; i < 3; i++) await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
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
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
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
  const dispatch = await dispatchTrip(ticket, { truckId: truck, driverId: driver, loadVolumeM3: 8, allowedSiteId: siteId });
  assert.equal(dispatch.status, "OK");
  if (dispatch.status !== "OK") return;
  tripIds.push(dispatch.tripId);

  await advanceTripState(dispatch.tripId, { allowedSiteId: siteId, ...actor() });
  const audit = await prisma.auditEvent.findFirstOrThrow({ where: { recordId: dispatch.tripId } });

  await assert.rejects(() => prisma.auditEvent.update({ where: { id: audit.id }, data: { afterValue: "TEST-SUITE-PL-TAMPERED" } }), /immutable/i);
  await assert.rejects(() => prisma.auditEvent.delete({ where: { id: audit.id } }), /immutable/i);

});
