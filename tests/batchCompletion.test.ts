// Real PostgreSQL integration tests for the batch-completion inventory
// ledger (src/lib/inventoryLedger.ts, src/lib/batchCompletion.ts) — no
// mocks for transaction behavior, since the whole point of this suite is
// proving Postgres-level atomicity/idempotency under concurrency, which a
// mock can't exercise.
//
// Requires TEST_DATABASE_URL, a real Postgres database that already has
// this project's migrations applied (see prisma/MIGRATIONS.md) — and it
// must differ from DATABASE_URL. That's not just documentation: the check
// below refuses to run otherwise, because this suite creates and deletes
// real rows and an earlier verification pass this project's history
// nearly clobbered real production data by testing against a database
// that turned out not to be disposable.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// "server-only" throws unless Next.js's own webpack config aliases it to
// a no-op, which only happens inside a real Next.js build — every lib
// file this suite imports below has `import "server-only"` at its top.
// Stub it out for this test run (see tests/setup/stubServerOnly.cjs) —
// done here, synchronously, before any of those imports run, rather than
// via a `--require`/NODE_OPTIONS CLI flag, so `npm test` stays one plain
// portable command regardless of shell.
createRequire(import.meta.url)("./setup/stubServerOnly.cjs");

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must be set to run these tests — see prisma/MIGRATIONS.md. Refusing to guess a database.");
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — refusing to run destructive tests against what may be a real database.");
}
// The app's own PrismaClient singleton (src/lib/prisma.ts) reads
// DATABASE_URL at construction time — redirect it to the test database
// BEFORE anything under src/ is imported, so every domain function this
// suite calls transparently uses the test database. This is why the
// imports below are dynamic rather than top-level: a static import would
// be hoisted and evaluated before this line ever runs.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { PrismaClient } = await import("@prisma/client");
const { completeBatchTicket, reverseBatchTicket, cancelBatchTicket } = await import("../src/lib/batchCompletion");
const { postSiloMovement } = await import("../src/lib/inventoryLedger");
const { claimAndRecordActuals, claimAndRecordActualField, claimAndAddTicketComponent, claimAndDeleteTicketComponent } = await import("../src/lib/batchComponentEdits");
const { claimTripSlot, applyReclaimCredit } = await import("../src/lib/tripDispatch");
const { requestShortageOverride, approveShortageOverrideRequest, rejectShortageOverrideRequest } = await import("../src/lib/shortageOverrideRequests");

const prisma = new PrismaClient();

// ---- Fixtures -------------------------------------------------------
// One isolated Plant/Site/Material/Silo/Mix/Reservation, created fresh
// for this whole file and destroyed in `after`. Nothing here is shared
// with any other data, so nothing outside this suite can ever touch it.
let siteId: string;
let plantId: string;
let materialId: string; // explicitly-assigned test material
let siloId: string; // explicitly assigned to materialId
let fallbackSiloId: string; // same materialType, NOT assigned to materialId
let mixId: string;
let reservationId: string;
let projectId: string;
let customerId: string;
let adminUserId: string;
let truckId: string;
let driverId: string;

const ticketIds: string[] = [];
const tripIds: string[] = [];

before(async () => {
  const site = await prisma.site.create({ data: { code: `TEST-SUITE-${Date.now()}`, name: "TEST-SUITE-SITE", city: "Test", country: "Test" } });
  siteId = site.id;
  const plant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-PLANT" } });
  plantId = plant.id;
  const material = await prisma.material.create({ data: { name: "TEST-SUITE-CEMENT", type: "CEMENT" } });
  materialId = material.id;
  const silo = await prisma.silo.create({
    data: { plantId, name: "TEST-SUITE-SILO", materialType: "CEMENT", materialId, capacityTons: 500, currentLevelTons: 0, minThresholdPct: 15 },
  });
  siloId = silo.id;
  const fallbackSilo = await prisma.silo.create({
    data: { plantId, name: "TEST-SUITE-FALLBACK-SILO", materialType: "CEMENT", materialId: null, capacityTons: 500, currentLevelTons: 1000, minThresholdPct: 15 },
  });
  fallbackSiloId = fallbackSilo.id;

  const customer = await prisma.customer.create({ data: { legalName: "TEST-SUITE-CUSTOMER", creditLimit: 999999 } });
  customerId = customer.id;
  const project = await prisma.project.create({ data: { name: "TEST-SUITE-PROJECT", customerId, siteAddress: "Test Address" } });
  projectId = project.id;
  const mix = await prisma.mixDesign.create({ data: { code: `TEST-SUITE-MIX-${Date.now()}`, grade: "C25", slumpTargetMm: 100, wcRatio: 0.5 } });
  mixId = mix.id;
  const reservation = await prisma.reservation.create({
    data: { reservationNumber: `TEST-SUITE-RES-${Date.now()}`, projectId, siteId, mixId, requestedVolumeM3: 100, originalVolumeM3: 100, pourWindowStart: new Date(), status: "CONFIRMED" },
  });
  reservationId = reservation.id;

  // reverseBatchTicket only needs a real User row to satisfy
  // BatchTicket.reversedById's foreign key — created here rather than
  // depending on an external seed step, so this suite runs against any
  // freshly-migrated, otherwise-empty test database.
  const admin = await prisma.user.create({
    data: { email: `test-suite-admin-${Date.now()}@example.invalid`, name: "TEST-SUITE-ADMIN", passwordHash: "not-a-real-hash", role: "ADMIN" },
  });
  adminUserId = admin.id;

  // For the dispatch-related tests (CR-01) — a real Truck/Employee so a
  // Trip row can be created directly, satisfying the same FKs startTrip
  // itself would populate.
  const truck = await prisma.truck.create({ data: { plantId, code: "TEST-SUITE-TRUCK", drumCapacityM3: 12 } });
  truckId = truck.id;
  const driver = await prisma.employee.create({ data: { plantId, name: "TEST-SUITE-DRIVER", role: "DRIVER", status: "ACTIVE" } });
  driverId = driver.id;
});

// Immutability trigger bypass (see the migration
// prisma/migrations/*_harden_inventory_movement/migration.sql) — this
// suite is the ONLY caller allowed to set this, and only for its own
// teardown; every other write in this file goes through
// completeBatchTicket/reverseBatchTicket like real application code
// would.
async function deleteMovements(where: NonNullable<Parameters<typeof prisma.inventoryMovement.findMany>[0]>["where"]) {
  await prisma.$transaction([prisma.$executeRaw`SET LOCAL app.bypass_movement_immutability = 'on'`, prisma.inventoryMovement.deleteMany({ where })]);
}

// P2025 ("record not found") is the one expected outcome here — some
// tests already delete their own fixture (e.g. an extra Material) in
// their own `finally` block, so by the time this runs it's legitimately
// already gone. Anything else (a real foreign-key violation, most
// notably) means cleanup is actually broken and must fail the suite
// loudly, not disappear into a silent `.catch(() => {})` — that silence
// is exactly what let a real bug (P2-03, fourth review: teardown deleted
// tickets before their own ShortageOverrideRequest rows, which have an
// ON DELETE RESTRICT FK to BatchTicket) hide behind a still-green CI for
// this whole file's worth of new tests.
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

after(async () => {
  for (const id of tripIds) {
    await prisma.drumReturn.deleteMany({ where: { tripId: id } });
    await cleanupDelete(() => prisma.trip.delete({ where: { id } }));
  }
  for (const id of ticketIds) {
    await deleteMovements({ OR: [{ sourceType: "BatchTicket", sourceId: id }, { sourceType: "Trip", sourceId: id }] });
    // Required, not optional — ShortageOverrideRequest.batchTicketId is
    // ON DELETE RESTRICT (deliberately, see its own schema comment), so
    // the ticket delete below fails a real FK check without this first.
    await prisma.shortageOverrideRequest.deleteMany({ where: { batchTicketId: id } });
    await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: id } });
    await cleanupDelete(() => prisma.batchTicket.delete({ where: { id } }));
  }
  await deleteMovements({ OR: [{ storageId: siloId }, { storageId: fallbackSiloId }] });
  await cleanupDelete(() => prisma.truck.delete({ where: { id: truckId } }));
  await cleanupDelete(() => prisma.employee.delete({ where: { id: driverId } }));
  await cleanupDelete(() => prisma.reservation.delete({ where: { id: reservationId } }));
  await cleanupDelete(() => prisma.mixDesign.delete({ where: { id: mixId } }));
  await cleanupDelete(() => prisma.project.delete({ where: { id: projectId } }));
  await cleanupDelete(() => prisma.customer.delete({ where: { id: customerId } }));
  await cleanupDelete(() => prisma.silo.delete({ where: { id: fallbackSiloId } }));
  await cleanupDelete(() => prisma.silo.delete({ where: { id: siloId } }));
  await cleanupDelete(() => prisma.material.delete({ where: { id: materialId } }));
  await cleanupDelete(() => prisma.plant.delete({ where: { id: plantId } }));
  await cleanupDelete(() => prisma.site.delete({ where: { id: siteId } }));
  await cleanupDelete(() => prisma.user.delete({ where: { id: adminUserId } }));
  await prisma.$disconnect();
});

async function makeTicket(components: { materialId: string; targetMassKg: number }[]) {
  const ticket = await prisma.batchTicket.create({
    data: {
      reservationId,
      mixId,
      plantId,
      ticketNumber: `TEST-SUITE-BT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      volumeM3: 5,
      status: "RELEASED",
      components: { create: components },
    },
  });
  ticketIds.push(ticket.id);
  return ticket.id;
}

async function siloLevel(id: string) {
  return (await prisma.silo.findUniqueOrThrow({ where: { id } })).currentLevelTons;
}

async function resetSilo(level: number) {
  await prisma.silo.update({ where: { id: siloId }, data: { currentLevelTons: level } });
}

// ---- 1/2. Double completion, concurrent completion -------------------

test("completing a ticket twice changes inventory once", async () => {
  await resetSilo(100);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 5000 }]);

  const first = await completeBatchTicket(ticketId, {});
  assert.equal(first.status, "SUCCESS");
  const levelAfterFirst = await siloLevel(siloId);
  assert.equal(levelAfterFirst, 95);

  const second = await completeBatchTicket(ticketId, {});
  assert.equal(second.status, "ALREADY_COMPLETED");
  assert.equal(await siloLevel(siloId), 95);

  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 1);
});

test("concurrent completion requests create one posting only", async () => {
  await resetSilo(100);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 7000 }]);

  const [a, b] = await Promise.all([completeBatchTicket(ticketId, {}), completeBatchTicket(ticketId, {})]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["ALREADY_COMPLETED", "SUCCESS"]);
  assert.equal(await siloLevel(siloId), 93);

  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 1);
});

// ---- 3. Two tickets consuming the same silo produce the correct balance --
// Genuinely concurrent (Promise.all, not sequential awaits) — this is the
// scenario the ledger's row lock (SELECT ... FOR UPDATE in
// src/lib/inventoryLedger.ts) exists for: two different tickets, two
// different completions, racing the exact same storage row.

test("two different tickets consuming the same silo net correctly under real concurrency", async () => {
  await resetSilo(100);
  const ticketA = await makeTicket([{ materialId, targetMassKg: 6000 }]);
  const ticketB = await makeTicket([{ materialId, targetMassKg: 9000 }]);

  const [resultA, resultB] = await Promise.all([completeBatchTicket(ticketA, {}), completeBatchTicket(ticketB, {})]);
  assert.equal(resultA.status, "SUCCESS");
  assert.equal(resultB.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 85); // 100 - 6 - 9, never a lost update

  const movementsA = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketA } });
  const movementsB = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketB } });
  assert.equal(movementsA.length, 1);
  assert.equal(movementsB.length, 1);
});

// ---- 4. Insufficient stock fails clean --------------------------------

test("insufficient stock fails without changing ticket, ledger, or balance", async () => {
  await resetSilo(2);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 5000 }]); // needs 5t, only 2t on hand

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "INSUFFICIENT_STOCK");

  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.status, "RELEASED");
  assert.equal(await siloLevel(siloId), 2);

  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 0);
});

// ---- 4b. A total stockout with an authorized override succeeds without
// ---- posting a zero-quantity ledger row (P0-01) -----------------------
// The very first version of postMovement tried to INSERT quantity=0
// whenever a shortage override hit a completely empty store (applied
// clamps all the way to 0) and got an unhandled CHECK-constraint failure
// (InventoryMovement_quantity_nonzero) instead of a clean SUCCESS.

test("a total stockout with an approved override request succeeds and posts no zero-quantity row", async () => {
  await resetSilo(0); // completely empty
  const ticketId = await makeTicket([{ materialId, targetMassKg: 5000 }]); // needs 5t, 0t on hand

  const request = await requestShortageOverride(ticketId, { reason: "authorized total shortage", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;
  const approval = await approveShortageOverrideRequest(request.requestId, adminUserId);
  assert.equal(approval.status, "OK");

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "SUCCESS");
  if (result.status === "SUCCESS") {
    assert.ok(result.shortages.length > 0, "expected the shortage to be reported even though completion succeeded");
    assert.equal(result.consumedOverrideRequestId, request.requestId); // the approval was actually used, not left dangling
  }

  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.status, "COMPLETE");
  assert.equal(await siloLevel(siloId), 0); // never went negative, never "gained" anything either

  // No ledger row at all for this component — a zero-effect movement
  // isn't a real event, and the CHECK constraint would reject it anyway.
  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 0);

  const consumedRequest = await prisma.shortageOverrideRequest.findUniqueOrThrow({ where: { id: request.requestId } });
  assert.equal(consumedRequest.status, "CONSUMED");
  assert.notEqual(consumedRequest.consumedAt, null);
});

test("insufficient stock without an override is still rejected even from a completely empty store", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 5000 }]);

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "INSUFFICIENT_STOCK");
  assert.equal((await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } })).status, "RELEASED");
  assert.equal(await siloLevel(siloId), 0);
});

// ---- 4c. P1-04 — the shortage-override request/approval workflow ------

test("a request without approval doesn't let a real shortage through", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 5000 }]);

  const request = await requestShortageOverride(ticketId, { reason: "waiting on manager", requestedById: adminUserId });
  assert.equal(request.status, "OK");

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "INSUFFICIENT_STOCK"); // PENDING, not APPROVED — must not grant anything
  assert.equal((await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } })).status, "RELEASED");
});

test("requesting again while one is already pending is refused, not duplicated", async () => {
  await resetSilo(0); // requestShortageOverride now requires a real shortage to exist (NO_SHORTAGE otherwise)
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);

  const first = await requestShortageOverride(ticketId, { reason: "first", requestedById: adminUserId });
  assert.equal(first.status, "OK");
  const second = await requestShortageOverride(ticketId, { reason: "second", requestedById: adminUserId });
  assert.equal(second.status, "ALREADY_PENDING");

  const requests = await prisma.shortageOverrideRequest.findMany({ where: { batchTicketId: ticketId } });
  assert.equal(requests.length, 1); // the DB's own partial unique index, not just the app-level check, is what actually held here
});

test("two concurrent requests for the same ticket — only one lands", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);

  const [a, b] = await Promise.all([
    requestShortageOverride(ticketId, { reason: "race A", requestedById: adminUserId }),
    requestShortageOverride(ticketId, { reason: "race B", requestedById: adminUserId }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["ALREADY_PENDING", "OK"]);

  const requests = await prisma.shortageOverrideRequest.findMany({ where: { batchTicketId: ticketId } });
  assert.equal(requests.length, 1);
});

test("a rejected request is no longer active — a new one can be made", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);

  const request = await requestShortageOverride(ticketId, { reason: "first attempt", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;

  const rejection = await rejectShortageOverrideRequest(request.requestId, adminUserId, "not enough justification");
  assert.equal(rejection.status, "OK");
  const rejected = await prisma.shortageOverrideRequest.findUniqueOrThrow({ where: { id: request.requestId } });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.rejectionNote, "not enough justification");

  const again = await requestShortageOverride(ticketId, { reason: "second attempt", requestedById: adminUserId });
  assert.equal(again.status, "OK"); // REJECTED doesn't count as active — a fresh request is allowed
});

test("only one of two concurrent decisions on the same request wins", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const request = await requestShortageOverride(ticketId, { reason: "race decision", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;

  const [approve, reject] = await Promise.all([
    approveShortageOverrideRequest(request.requestId, adminUserId),
    rejectShortageOverrideRequest(request.requestId, adminUserId, "trying to reject the same request"),
  ]);
  const statuses = [approve.status, reject.status].sort();
  assert.deepEqual(statuses, ["NOT_PENDING", "OK"]); // whichever claimed the PENDING row first wins; the other sees it's no longer pending

  const finalRequest = await prisma.shortageOverrideRequest.findUniqueOrThrow({ where: { id: request.requestId } });
  assert.ok(finalRequest.status === "APPROVED" || finalRequest.status === "REJECTED");
});

test("an approved request for one ticket doesn't leak to a different ticket", async () => {
  await resetSilo(0);
  const approvedTicketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const otherTicketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);

  const request = await requestShortageOverride(approvedTicketId, { reason: "for the first ticket only", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;
  const approval = await approveShortageOverrideRequest(request.requestId, adminUserId);
  assert.equal(approval.status, "OK");

  const otherResult = await completeBatchTicket(otherTicketId, {});
  assert.equal(otherResult.status, "INSUFFICIENT_STOCK"); // the approval is scoped to approvedTicketId, not usable here

  const approvedResult = await completeBatchTicket(approvedTicketId, {});
  assert.equal(approvedResult.status, "SUCCESS");
});

// ---- 4d. Regressions from the fourth external review -------------------

// FR-P1-01: the zero-effect skip in postMovement used to key off a whole
// kg/liter (0.001), not a floating-point epsilon — silently dropping the
// ledger row for any genuinely tiny but real movement while the balance
// itself still changed. A component this small is unusual but reachable
// (e.g. a corrected admixture reading).
test("a genuinely tiny but real quantity still posts a movement and reverses cleanly (FR-P1-01)", async () => {
  await resetSilo(10);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 0.5 }]); // 0.5kg = 0.0005t — below the old 0.001 threshold, not zero

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 9.9995);

  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 1); // the old bug posted zero rows here
  assert.ok(Math.abs(movements[0].quantity - -0.0005) < 1e-6, `expected ~-0.0005, got ${movements[0].quantity}`); // exact equality isn't safe here — this is a real float round-trip, not a literal

  const reversal = await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "test reversal of a tiny quantity" });
  assert.equal(reversal.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 10); // restored exactly, nothing left unreconciled
});

// FR-P2-01: ShortageOverrideRequest.batchTicketId is ON DELETE RESTRICT
// (deliberately — deleting a ticket must never silently erase an
// approval decision's history) but deleteBatchTicket didn't check for
// one before calling delete(), so it would throw a raw, unhandled
// foreign-key-violation error. This confirms the constraint the
// application-level guard (production/actions.ts) is now built around
// actually exists and actually blocks the delete at the database level —
// the same "the database itself rejects X" style as the immutability
// trigger's own test below.
test("the database itself rejects deleting a BatchTicket with a ShortageOverrideRequest on file (FR-P2-01)", async () => {
  await resetSilo(0); // requestShortageOverride now requires a real shortage to exist
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const request = await requestShortageOverride(ticketId, { reason: "for the delete-guard test", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;

  await assert.rejects(() => prisma.batchTicket.delete({ where: { id: ticketId } }));

  const rejection = await rejectShortageOverrideRequest(request.requestId, adminUserId, "resolving so cleanup can proceed");
  assert.equal(rejection.status, "OK");
  // Even a resolved (REJECTED/CONSUMED) request still restricts the
  // delete — the constraint has no status carve-out, matching the
  // application guard's own "any request on file at all" check.
  await assert.rejects(() => prisma.batchTicket.delete({ where: { id: ticketId } }));

  await prisma.shortageOverrideRequest.delete({ where: { id: request.requestId } });
});

// FR-P1-02: notifyRoles used to broadcast to every active user with a
// matching role org-wide, with no way to narrow it — a manager at an
// unrelated site had no business reason to be notified about, or to
// decide on, a shortage override raised at a different site. The new
// optional siteId narrows recipients to that site (ADMIN still included
// everywhere, same "ADMIN sees every site" rule effectiveSiteId itself
// uses).
test("notifyRoles with a siteId only notifies users at that site, plus ADMIN (FR-P1-02)", async () => {
  const { notifyRoles } = await import("../src/lib/notify");

  const otherSite = await prisma.site.create({ data: { code: `TEST-SUITE-OTHER-${Date.now()}`, name: "TEST-SUITE-OTHER-SITE", city: "Test", country: "Test" } });
  const otherPlant = await prisma.plant.create({ data: { siteId: otherSite.id, name: "TEST-SUITE-OTHER-PLANT" } });
  const sameSiteManager = await prisma.user.create({
    data: { email: `test-suite-same-site-${Date.now()}@example.invalid`, name: "TEST-SUITE-SAME-SITE-MANAGER", passwordHash: "not-a-real-hash", role: "PLANT_MANAGER", plantId },
  });
  const otherSiteManager = await prisma.user.create({
    data: { email: `test-suite-other-site-${Date.now()}@example.invalid`, name: "TEST-SUITE-OTHER-SITE-MANAGER", passwordHash: "not-a-real-hash", role: "PLANT_MANAGER", plantId: otherPlant.id },
  });

  try {
    await notifyRoles(["PLANT_MANAGER", "ADMIN"], { module: "Production", title: "TEST-SUITE-SITE-SCOPED-NOTIFICATION" }, { siteId });

    const recipientIds = (await prisma.notification.findMany({ where: { title: "TEST-SUITE-SITE-SCOPED-NOTIFICATION" }, select: { userId: true } })).map((n) => n.userId);
    assert.ok(recipientIds.includes(sameSiteManager.id));
    assert.ok(recipientIds.includes(adminUserId)); // ADMIN always included regardless of site
    assert.ok(!recipientIds.includes(otherSiteManager.id));
  } finally {
    await prisma.notification.deleteMany({ where: { title: "TEST-SUITE-SITE-SCOPED-NOTIFICATION" } });
    await prisma.user.delete({ where: { id: sameSiteManager.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: otherSiteManager.id } }).catch(() => {});
    await prisma.plant.delete({ where: { id: otherPlant.id } }).catch(() => {});
    await prisma.site.delete({ where: { id: otherSite.id } }).catch(() => {});
  }
});

// ---- 4e. Regressions from the fifth external review (Codex) -----------

// P1-01: the SHORTFALL threshold (not the zero-effect one, already fixed
// above) was still a whole kg/liter (0.001) — a real shortfall smaller
// than that slipped through with no INSUFFICIENT_STOCK at all, override
// or not, since 0.001 was being used as an implicit "this doesn't really
// count" business cutoff rather than a floating-point epsilon.
test("a tiny consumption from a completely empty silo without an override is still INSUFFICIENT_STOCK (P1-01)", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 0.5 }]); // 0.5kg = 0.0005t — below the old 0.001 shortfall threshold

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "INSUFFICIENT_STOCK");
  assert.equal((await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } })).status, "RELEASED");
  assert.equal(await siloLevel(siloId), 0);
  assert.equal((await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } })).length, 0);
});

test("a genuinely small authorized shortage is still recorded and consumes the approved request (P1-01)", async () => {
  await resetSilo(9.9995);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 10000 }]); // needs 10t, 9.9995t on hand — 0.5kg short

  const request = await requestShortageOverride(ticketId, { reason: "tiny shortage", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;
  const approval = await approveShortageOverrideRequest(request.requestId, adminUserId);
  assert.equal(approval.status, "OK");

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "SUCCESS");
  if (result.status === "SUCCESS") {
    assert.ok(result.shortages.length > 0);
    assert.equal(result.consumedOverrideRequestId, request.requestId);
  }
  assert.equal(await siloLevel(siloId), 0); // clamped, not negative
  assert.equal((await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } })).length, 1); // small but real — still posted
});

test("a reversal that would exceed capacity fails and reversedAt stays unset (P1-01 boundary)", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 10000 }]); // 10t
  const completion = await completeBatchTicket(ticketId, {});
  assert.equal(completion.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 40);

  // Something else filled the silo almost to capacity in the meantime —
  // crediting the full 10t back on reversal would overflow it.
  await prisma.silo.update({ where: { id: siloId }, data: { currentLevelTons: 495 } });

  const reversal = await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "test capacity boundary" });
  assert.equal(reversal.status, "CAPACITY_EXCEEDED");

  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.reversedAt, null);
  assert.equal(await siloLevel(siloId), 495); // untouched — the whole reversal rolled back

  await resetSilo(40); // restore, so this test doesn't leave the fixture silo in a weird state for whatever runs next
});

// P1-02: a request could be created for (or decided on) a ticket that had
// already gone terminal, since requestShortageOverride only read ticket
// status once, outside any lock, and nothing ever resolved a request left
// PENDING/APPROVED once its ticket completed without needing it.
test("requesting an override on an already-complete ticket is refused (P1-02)", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const completion = await completeBatchTicket(ticketId, {});
  assert.equal(completion.status, "SUCCESS");

  const request = await requestShortageOverride(ticketId, { reason: "too late", requestedById: adminUserId });
  assert.equal(request.status, "TICKET_TERMINAL");
});

test("a request left undecided when its ticket completes without needing it is expired, not left dangling (P1-02)", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]); // a real shortage right now

  const request = await requestShortageOverride(ticketId, { reason: "shortage that resolves itself", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;

  await resetSilo(50); // a delivery arrives before anyone decides the request
  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "SUCCESS");
  if (result.status === "SUCCESS") assert.equal(result.consumedOverrideRequestId, null); // never needed

  const finalRequest = await prisma.shortageOverrideRequest.findUniqueOrThrow({ where: { id: request.requestId } });
  assert.equal(finalRequest.status, "EXPIRED"); // was PENDING, never decided — the ticket is terminal now regardless
});

test("approving a request after its ticket expired it returns NOT_PENDING, not OK (P1-02)", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const request = await requestShortageOverride(ticketId, { reason: "will expire", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;

  await resetSilo(50);
  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "SUCCESS");

  const decision = await approveShortageOverrideRequest(request.requestId, adminUserId);
  assert.equal(decision.status, "NOT_PENDING"); // EXPIRED, not PENDING — nothing left to decide
});

// P1-03: an approval used to be a blanket "there's a shortage, trust me"
// for the whole ticket — not bound to the specific material/quantity a
// manager actually saw, and it stayed valid even after a component was
// edited to need more, or a different material became short too.
test("an approval for one material cannot authorize a shortage on a different material (P1-03)", async () => {
  await resetSilo(0); // materialId already short at request time
  const secondMaterial = await prisma.material.create({ data: { name: "TEST-SUITE-SNAPSHOT-B", type: "CEMENT" } });
  const secondSilo = await prisma.silo.create({
    data: { plantId, name: "TEST-SUITE-SNAPSHOT-SILO-B", materialType: "CEMENT", materialId: secondMaterial.id, capacityTons: 500, currentLevelTons: 10 }, // plenty for now
  });
  try {
    const ticketId = await makeTicket([
      { materialId, targetMassKg: 1000 }, // 1t needed, 0 on hand — short
      { materialId: secondMaterial.id, targetMassKg: 1000 }, // 1t needed, 10 on hand — fine for now
    ]);

    const request = await requestShortageOverride(ticketId, { reason: "only material A is short right now", requestedById: adminUserId });
    assert.equal(request.status, "OK");
    if (request.status !== "OK") return;
    const approval = await approveShortageOverrideRequest(request.requestId, adminUserId);
    assert.equal(approval.status, "OK");

    // A shortage appears for material B AFTER approval — never in the
    // snapshot, so the approval must not cover it.
    await prisma.silo.update({ where: { id: secondSilo.id }, data: { currentLevelTons: 0 } });

    const result = await completeBatchTicket(ticketId, {});
    assert.equal(result.status, "INSUFFICIENT_STOCK"); // material B's new shortage isn't authorized by an approval scoped to material A only
    assert.equal((await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } })).status, "RELEASED");
    assert.equal(await siloLevel(siloId), 0); // whole completion rolled back — material A never deducted either
  } finally {
    await prisma.batchComponentActual.deleteMany({ where: { materialId: secondMaterial.id } });
    await prisma.silo.delete({ where: { id: secondSilo.id } }).catch(() => {});
    await prisma.material.delete({ where: { id: secondMaterial.id } }).catch(() => {});
  }
});

test("an approval for a smaller shortage cannot authorize a larger one after a component edit (P1-03)", async () => {
  await resetSilo(1);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 2000 }]); // needs 2t — 1t short

  const request = await requestShortageOverride(ticketId, { reason: "1 ton short", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;
  const approval = await approveShortageOverrideRequest(request.requestId, adminUserId);
  assert.equal(approval.status, "OK");

  // Edited to need MORE after approval — a bigger shortage than what was
  // actually approved (only 1t was ever snapshotted).
  const [component] = await prisma.batchComponentActual.findMany({ where: { batchTicketId: ticketId } });
  await prisma.batchComponentActual.update({ where: { id: component.id }, data: { targetMassKg: 5000 } }); // now needs 5t — 4t short

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "INSUFFICIENT_STOCK"); // the extra 3t of shortage was never approved
});

// P1-04: startTrip's reclaim-credit block used to invent credits for
// inventoryTracked:false materials, pro-rate the full recipe/actual
// target instead of what completion actually applied, and re-resolve
// "the current matching silo/hopper" instead of the exact storageId
// completion posted to. Extracted into applyReclaimCredit
// (tripDispatch.ts) specifically so these tests call the REAL logic —
// the previous reclaim test only ever exercised a bare postSiloMovement
// call, never this code path.
test("applyReclaimCredit never credits an inventoryTracked:false material (P1-04)", async () => {
  await resetSilo(50);
  const untrackedMaterial = await prisma.material.create({ data: { name: "TEST-SUITE-UNTRACKED-RECLAIM", type: "WATER", inventoryTracked: false } });
  try {
    const ticketId = await makeTicket([
      { materialId, targetMassKg: 1000 },
      { materialId: untrackedMaterial.id, targetMassKg: 200 },
    ]);
    const completion = await completeBatchTicket(ticketId, {});
    assert.equal(completion.status, "SUCCESS");

    const trip = await prisma.trip.create({ data: { batchTicketId: ticketId, truckId, driverId, status: "CLOSED", batchTime: new Date(), reclaimedVolumeM3: 2 } });
    tripIds.push(trip.id);

    const ticketWithComponents = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { components: { include: { material: true } } } });
    const creditResult = await prisma.$transaction((tx) =>
      applyReclaimCredit(tx, { batchTicketId: ticketId, tripId: trip.id, components: ticketWithComponents.components, reclaimedFraction: 0.5, actorId: adminUserId }),
    );
    assert.equal(creditResult.status, "OK");

    const untrackedComponent = ticketWithComponents.components.find((c) => c.materialId === untrackedMaterial.id)!;
    const freshComponent = await prisma.batchComponentActual.findUniqueOrThrow({ where: { id: untrackedComponent.id } });
    assert.equal(freshComponent.reclaimCreditMassKg, 0); // no credit at all — it was never deducted in the first place

    const creditMovements = await prisma.inventoryMovement.findMany({ where: { sourceType: "Trip", sourceId: trip.id } });
    assert.equal(creditMovements.length, 1); // only the tracked component got a RECLAIM_CREDIT row
    assert.equal(creditMovements[0].materialId, materialId);
  } finally {
    await prisma.material.delete({ where: { id: untrackedMaterial.id } }).catch(() => {});
  }
});

test("applyReclaimCredit credits only the fraction of what was ACTUALLY deducted, not the recipe target (P1-04)", async () => {
  await resetSilo(0.5); // only 0.5t on hand
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]); // needs 1t — 0.5t short

  const request = await requestShortageOverride(ticketId, { reason: "half short", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;
  assert.equal((await approveShortageOverrideRequest(request.requestId, adminUserId)).status, "OK");

  const completion = await completeBatchTicket(ticketId, {});
  assert.equal(completion.status, "SUCCESS"); // only 0.5t actually applied — all that was on hand
  assert.equal(await siloLevel(siloId), 0);

  const trip = await prisma.trip.create({ data: { batchTicketId: ticketId, truckId, driverId, status: "CLOSED", batchTime: new Date(), reclaimedVolumeM3: 5 } });
  tripIds.push(trip.id);
  const ticketWithComponents = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { components: { include: { material: true } } } });
  const creditResult = await prisma.$transaction((tx) =>
    applyReclaimCredit(tx, { batchTicketId: ticketId, tripId: trip.id, components: ticketWithComponents.components, reclaimedFraction: 1, actorId: adminUserId }),
  );
  assert.equal(creditResult.status, "OK");
  assert.equal(await siloLevel(siloId), 0.5); // 100% of the ACTUAL 0.5t applied, not the 1t recipe target
});

test("applyReclaimCredit credits the ORIGINAL storage even if the material's assignment changed since (P1-04)", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const completion = await completeBatchTicket(ticketId, {});
  assert.equal(completion.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 49);

  const newSilo = await prisma.silo.create({ data: { plantId, name: "TEST-SUITE-RECLAIM-NEW-SILO", materialType: "CEMENT", materialId, capacityTons: 500, currentLevelTons: 0 } });
  try {
    // The material gets reassigned to a DIFFERENT silo after completion —
    // the credit must still go back to the ORIGINAL one, not wherever
    // the material happens to point now.
    await prisma.silo.update({ where: { id: siloId }, data: { materialId: null } });

    const trip = await prisma.trip.create({ data: { batchTicketId: ticketId, truckId, driverId, status: "CLOSED", batchTime: new Date(), reclaimedVolumeM3: 5 } });
    tripIds.push(trip.id);
    const ticketWithComponents = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { components: { include: { material: true } } } });
    const creditResult = await prisma.$transaction((tx) =>
      applyReclaimCredit(tx, { batchTicketId: ticketId, tripId: trip.id, components: ticketWithComponents.components, reclaimedFraction: 1, actorId: adminUserId }),
    );
    assert.equal(creditResult.status, "OK");

    assert.equal(await siloLevel(siloId), 50); // credited back to the ORIGINAL silo
    assert.equal((await prisma.silo.findUniqueOrThrow({ where: { id: newSilo.id } })).currentLevelTons, 0); // the new one untouched
  } finally {
    await prisma.silo.update({ where: { id: siloId }, data: { materialId } }).catch(() => {});
    await prisma.silo.delete({ where: { id: newSilo.id } }).catch(() => {});
  }
});

test("applyReclaimCredit reports failure when the original storage no longer exists (P1-04)", async () => {
  const throwawayMaterial = await prisma.material.create({ data: { name: "TEST-SUITE-RECLAIM-MISSING-STORAGE", type: "CEMENT" } });
  const throwawaySilo = await prisma.silo.create({ data: { plantId, name: "TEST-SUITE-RECLAIM-THROWAWAY-SILO", materialType: "CEMENT", materialId: throwawayMaterial.id, capacityTons: 500, currentLevelTons: 50 } });
  try {
    const ticketId = await makeTicket([{ materialId: throwawayMaterial.id, targetMassKg: 1000 }]);
    const completion = await completeBatchTicket(ticketId, {});
    assert.equal(completion.status, "SUCCESS");

    // storageId on InventoryMovement has no FK (intentionally polymorphic
    // — see the model comment), so deleting the silo the ticket already
    // posted against doesn't cascade-fail; it just leaves nothing for a
    // later reclaim credit to land on.
    await prisma.silo.delete({ where: { id: throwawaySilo.id } });

    const trip = await prisma.trip.create({ data: { batchTicketId: ticketId, truckId, driverId, status: "CLOSED", batchTime: new Date(), reclaimedVolumeM3: 5 } });
    tripIds.push(trip.id);
    const ticketWithComponents = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { components: { include: { material: true } } } });
    const creditResult = await prisma.$transaction((tx) =>
      applyReclaimCredit(tx, { batchTicketId: ticketId, tripId: trip.id, components: ticketWithComponents.components, reclaimedFraction: 1, actorId: adminUserId }),
    );
    assert.equal(creditResult.status, "CREDIT_FAILED");
    if (creditResult.status === "CREDIT_FAILED") assert.equal(creditResult.reason, "STORAGE_NOT_CONFIGURED");
  } finally {
    await prisma.material.delete({ where: { id: throwawayMaterial.id } }).catch(() => {});
  }
});

test("a capacity failure rolls back every reclaim credit already applied in the same transaction (P1-04)", async () => {
  await resetSilo(50);
  const secondMaterial = await prisma.material.create({ data: { name: "TEST-SUITE-RECLAIM-CAPACITY-B", type: "CEMENT" } });
  const secondSilo = await prisma.silo.create({ data: { plantId, name: "TEST-SUITE-RECLAIM-CAPACITY-SILO-B", materialType: "CEMENT", materialId: secondMaterial.id, capacityTons: 10, currentLevelTons: 10 } });
  try {
    const ticketId = await makeTicket([
      { materialId, targetMassKg: 1000 }, // 1t — plenty of room to credit back later
      { materialId: secondMaterial.id, targetMassKg: 2000 }, // 2t
    ]);
    const completion = await completeBatchTicket(ticketId, {});
    assert.equal(completion.status, "SUCCESS");
    assert.equal(await siloLevel(siloId), 49);
    assert.equal((await prisma.silo.findUniqueOrThrow({ where: { id: secondSilo.id } })).currentLevelTons, 8);

    // Something else nearly refilled secondSilo in the meantime —
    // crediting the full 2t back would overflow its 10t capacity.
    await prisma.silo.update({ where: { id: secondSilo.id }, data: { currentLevelTons: 9 } });

    const trip = await prisma.trip.create({ data: { batchTicketId: ticketId, truckId, driverId, status: "CLOSED", batchTime: new Date(), reclaimedVolumeM3: 5 } });
    tripIds.push(trip.id);
    const ticketWithComponents = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { components: { include: { material: true } } } });

    await assert.rejects(() =>
      prisma.$transaction((tx) =>
        applyReclaimCredit(tx, { batchTicketId: ticketId, tripId: trip.id, components: ticketWithComponents.components, reclaimedFraction: 1, actorId: adminUserId }),
      ),
    );

    assert.equal(await siloLevel(siloId), 49); // whole transaction rolled back — the OTHER credit, which would have succeeded alone, never landed either
    assert.equal((await prisma.silo.findUniqueOrThrow({ where: { id: secondSilo.id } })).currentLevelTons, 9);
    assert.equal((await prisma.inventoryMovement.findMany({ where: { sourceType: "Trip", sourceId: trip.id } })).length, 0);
  } finally {
    await prisma.batchComponentActual.deleteMany({ where: { materialId: secondMaterial.id } });
    await prisma.silo.delete({ where: { id: secondSilo.id } }).catch(() => {});
    await prisma.material.delete({ where: { id: secondMaterial.id } }).catch(() => {});
  }
});

// P2-01: deleteBatchTicket silently refused (post-FR-P2-01) any ticket
// with a ShortageOverrideRequest on file, with no way to actually close
// it out — cancelBatchTicket is the real path for that now.
test("cancelBatchTicket cancels a non-terminal ticket and expires any active override request (P2-01)", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const request = await requestShortageOverride(ticketId, { reason: "will be cancelled", requestedById: adminUserId });
  assert.equal(request.status, "OK");
  if (request.status !== "OK") return;

  const cancellation = await cancelBatchTicket(ticketId, { actorId: adminUserId, reason: "test cancellation" });
  assert.equal(cancellation.status, "SUCCESS");

  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.status, "CANCELLED");
  assert.equal(ticket.cancelledById, adminUserId);
  assert.equal(ticket.cancellationReason, "test cancellation");

  const finalRequest = await prisma.shortageOverrideRequest.findUniqueOrThrow({ where: { id: request.requestId } });
  assert.equal(finalRequest.status, "EXPIRED");
});

test("cancelBatchTicket refuses an already-complete ticket (P2-01)", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const completion = await completeBatchTicket(ticketId, {});
  assert.equal(completion.status, "SUCCESS");

  const result = await cancelBatchTicket(ticketId, { actorId: adminUserId, reason: "should be refused" });
  assert.equal(result.status, "INVALID_STATE");
});

// ---- 5. A failure on one component rolls back all components ---------

test("a failure while processing one component rolls back all components", async () => {
  await resetSilo(10); // plenty for one component, not enough for two
  const secondMaterial = await prisma.material.create({ data: { name: "TEST-SUITE-CEMENT-2", type: "CEMENT" } });
  const secondSilo = await prisma.silo.create({
    data: { plantId, name: "TEST-SUITE-SILO-2", materialType: "CEMENT", materialId: secondMaterial.id, capacityTons: 500, currentLevelTons: 1 },
  });

  try {
    const ticketId = await makeTicket([
      { materialId, targetMassKg: 3000 }, // 3t, fits easily in the 10t silo
      { materialId: secondMaterial.id, targetMassKg: 5000 }, // 5t, only 1t available — should fail
    ]);

    const result = await completeBatchTicket(ticketId, {});
    assert.equal(result.status, "INSUFFICIENT_STOCK");

    // The first component's silo must be untouched too — the whole
    // transaction rolled back, not just the failing component.
    assert.equal(await siloLevel(siloId), 10);
    assert.equal((await prisma.silo.findUniqueOrThrow({ where: { id: secondSilo.id } })).currentLevelTons, 1);

    const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(ticket.status, "RELEASED");

    const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
    assert.equal(movements.length, 0);
  } finally {
    await prisma.silo.delete({ where: { id: secondSilo.id } }).catch(() => {});
    await prisma.material.delete({ where: { id: secondMaterial.id } }).catch(() => {});
  }
});

// ---- 6. COMPLETE/CANCELLED reject actual/component changes, under real
// ---- concurrency, against the real production code (CR-03, P1-01) -----
// claimAndRecordActuals/claimAndRecordActualField/claimAndAddTicketComponent/
// claimAndDeleteTicketComponent (src/lib/batchComponentEdits.ts) are the
// exact functions production/actions.ts's Server Actions call — not a
// paraphrase of their logic. Racing each against completeBatchTicket via
// Promise.all must always resolve to exactly one of two valid outcomes:
// the edit committed first (so completion picks it up and the edit
// itself reports OK), or completion committed first (so the edit is
// refused with TERMINAL and the component is provably unchanged) — never
// a third outcome where the ledger is built from a stale snapshot while
// a newer edit also got saved.

test("a COMPLETE ticket cannot be re-completed", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const first = await completeBatchTicket(ticketId, {});
  assert.equal(first.status, "SUCCESS");
  const second = await completeBatchTicket(ticketId, {});
  assert.equal(second.status, "ALREADY_COMPLETED");
});

test("completion vs. recordActualField: exactly one of two valid outcomes, never a stale-ledger/saved-edit mix", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]); // 1kg -> 0.001t, small on purpose
  const [component] = await prisma.batchComponentActual.findMany({ where: { batchTicketId: ticketId } });

  const [completeResult, editResult] = await Promise.all([
    completeBatchTicket(ticketId, {}),
    claimAndRecordActualField(ticketId, component.id, "actual", 2000), // 2kg — deliberately different from the 1kg target
  ]);

  assert.equal(completeResult.status, "SUCCESS"); // completion always eventually succeeds — BATCHING never blocks its own claim
  const finalComponent = await prisma.batchComponentActual.findUniqueOrThrow({ where: { id: component.id } });
  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 1);

  if (editResult.status === "OK") {
    // Edit committed first — completion must have picked up the edited value.
    assert.equal(finalComponent.actualMassKg, 2000);
    assert.equal(Math.abs(movements[0].quantity), 2);
  } else {
    // Completion committed first — the edit must have been refused and
    // the component must be exactly as it was (target only, no actual set).
    assert.equal(editResult.status, "TERMINAL");
    assert.equal(finalComponent.actualMassKg, null);
    assert.equal(Math.abs(movements[0].quantity), 1);
  }
});

test("completion vs. recordActuals (bulk): exactly one of two valid outcomes", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const [component] = await prisma.batchComponentActual.findMany({ where: { batchTicketId: ticketId } });

  const [completeResult, editResult] = await Promise.all([
    completeBatchTicket(ticketId, {}),
    claimAndRecordActuals(ticketId, [{ id: component.id, actualMassKg: 3000, moisturePct: null }]),
  ]);

  assert.equal(completeResult.status, "SUCCESS");
  const finalComponent = await prisma.batchComponentActual.findUniqueOrThrow({ where: { id: component.id } });
  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 1);

  if (editResult.status === "OK") {
    assert.equal(finalComponent.actualMassKg, 3000);
    assert.equal(Math.abs(movements[0].quantity), 3);
  } else {
    assert.equal(editResult.status, "TERMINAL");
    assert.equal(finalComponent.actualMassKg, null);
    assert.equal(Math.abs(movements[0].quantity), 1);
  }
});

test("completion vs. addTicketComponent: exactly one of two valid outcomes", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  // SILICA_FUME, not CEMENT: findMatchingSilo (storageMatching.ts) falls
  // back to any generic, unassigned silo of the same materialType when a
  // material has no explicit silo of its own — an intentional shared-bin
  // feature. The fixtures' own fallbackSiloId is exactly such a generic
  // CEMENT silo, so a CEMENT-typed orphan here would silently match it
  // instead of proving the STORAGE_NOT_CONFIGURED path this test wants.
  // No fixture silo of any kind exists for SILICA_FUME, so this really has
  // no matching storage at all.
  const secondMaterial = await prisma.material.create({ data: { name: "TEST-SUITE-SILICA-FUME-RACE", type: "SILICA_FUME", specificGravity: null } });
  try {
    // secondMaterial has no matching silo at all — if it DOES get added
    // and completion picks it up, completion must correctly fail with
    // STORAGE_NOT_CONFIGURED (CR-02) rather than silently ignoring it.
    const [completeResult, editResult] = await Promise.all([
      completeBatchTicket(ticketId, {}),
      claimAndAddTicketComponent(ticketId, secondMaterial.id, 500),
    ]);

    if (editResult.status === "OK") {
      // The new component was added before completion's claim — completion
      // must see it and correctly fail closed (CR-02), not silently skip it.
      assert.equal(completeResult.status, "STORAGE_NOT_CONFIGURED");
      const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
      assert.equal(ticket.status, "RELEASED");
      assert.equal(await siloLevel(siloId), 50); // whole transaction rolled back, original component's silo untouched too
    } else {
      // Completion claimed first — the add must have been refused and
      // never actually created a second component row.
      assert.equal(editResult.status, "TERMINAL");
      assert.equal(completeResult.status, "SUCCESS");
      const components = await prisma.batchComponentActual.findMany({ where: { batchTicketId: ticketId } });
      assert.equal(components.length, 1);
    }
  } finally {
    await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: ticketId, materialId: secondMaterial.id } });
    await prisma.material.delete({ where: { id: secondMaterial.id } }).catch(() => {});
  }
});

test("completion vs. deleteTicketComponent: exactly one of two valid outcomes", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const [component] = await prisma.batchComponentActual.findMany({ where: { batchTicketId: ticketId } });

  const [completeResult, editResult] = await Promise.all([completeBatchTicket(ticketId, {}), claimAndDeleteTicketComponent(ticketId, component.id)]);

  if (editResult.status === "OK") {
    // The component was deleted before completion's claim — completion
    // must have nothing left to deduct at all.
    assert.equal(completeResult.status, "SUCCESS");
    const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
    assert.equal(movements.length, 0);
    assert.equal(await siloLevel(siloId), 50); // nothing deducted
  } else {
    // Completion claimed first — the delete must have been refused and
    // the component must still exist, now attached to a COMPLETE ticket.
    assert.equal(editResult.status, "TERMINAL");
    assert.equal(completeResult.status, "SUCCESS");
    const stillThere = await prisma.batchComponentActual.findUnique({ where: { id: component.id } });
    assert.ok(stillThere);
  }
});

// ---- 7/8. Reversal restores exact quantities once; a second reversal --
// ---- is a no-op --------------------------------------------------------

test("reversal restores the exact posted quantities once, and a second reversal changes nothing", async () => {
  await resetSilo(40);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 6000 }]);

  const completion = await completeBatchTicket(ticketId, {});
  assert.equal(completion.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 34);

  const reversal = await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "test reversal" });
  assert.equal(reversal.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 40);

  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.status, "COMPLETE"); // never deleted
  assert.notEqual(ticket.reversedAt, null);

  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 2); // completion + reversal

  const secondReversal = await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "second attempt" });
  assert.equal(secondReversal.status, "ALREADY_REVERSED");
  assert.equal(await siloLevel(siloId), 40);

  const movementsAfterSecond = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movementsAfterSecond.length, 2);
});

// ---- 8b. A pre-ledger COMPLETE ticket refuses reversal instead of -----
// ---- silently "succeeding" with nothing to restore (P1-06) ------------
// Every ticket completed before this ledger existed has zero
// InventoryMovement rows — exactly the case this simulates by creating a
// COMPLETE ticket directly, bypassing completeBatchTicket entirely,
// rather than going through the normal flow.

test("reversing a COMPLETE ticket with no posted movements is refused, not silently accepted", async () => {
  const ticket = await prisma.batchTicket.create({
    data: {
      reservationId,
      mixId,
      plantId,
      ticketNumber: `TEST-SUITE-BT-PRELEDGER-${Date.now()}`,
      volumeM3: 5,
      status: "COMPLETE",
      batchCompletedAt: new Date(),
      components: { create: [{ materialId, targetMassKg: 3000 }] },
    },
  });
  ticketIds.push(ticket.id);

  const result = await reverseBatchTicket(ticket.id, { actorId: adminUserId, reason: "test pre-ledger reversal" });
  assert.equal(result.status, "NO_POSTED_MOVEMENTS");

  const fresh = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  assert.equal(fresh.status, "COMPLETE"); // unchanged
  assert.equal(fresh.reversedAt, null); // the claim was rolled back, not left stamped with nothing actually reversed
});

// ---- 9. Consumption uses the explicitly assigned storage --------------

test("material consumption uses the explicitly assigned storage, not a same-type fallback", async () => {
  await resetSilo(30);
  const fallbackBefore = await siloLevel(fallbackSiloId);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 4000 }]);

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 26); // the explicitly assigned silo took the deduction
  assert.equal(await siloLevel(fallbackSiloId), fallbackBefore); // the fallback silo is untouched
});

// ---- 11. A material with no matching storage is a hard failure --------
// (CR-02 — completeBatchTicket used to silently skip a component with no
// matching silo/hopper/tank and still return SUCCESS.)

test("a material with no configured storage fails the whole completion", async () => {
  await resetSilo(50);
  const admixture = await prisma.material.create({ data: { name: "TEST-SUITE-ADMIXTURE-NO-TANK", type: "ADMIXTURE", specificGravity: 1.1 } });
  try {
    // No ChemicalTank exists anywhere for this material — completeBatchTicket's
    // ADMIXTURE branch does `chemicalTank.findFirst({ plantId, materialId })`
    // with no fallback, so this can never resolve.
    const ticketId = await makeTicket([
      { materialId, targetMassKg: 1000 }, // resolves fine on its own
      { materialId: admixture.id, targetMassKg: 50 }, // no tank — should fail
    ]);

    const result = await completeBatchTicket(ticketId, {});
    assert.equal(result.status, "STORAGE_NOT_CONFIGURED");
    if (result.status === "STORAGE_NOT_CONFIGURED") assert.match(result.material, /TEST-SUITE-ADMIXTURE-NO-TANK/);

    const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(ticket.status, "RELEASED");
    assert.equal(await siloLevel(siloId), 50); // the OTHER component's silo is untouched too — whole transaction rolled back

    const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
    assert.equal(movements.length, 0);
  } finally {
    await prisma.material.delete({ where: { id: admixture.id } }).catch(() => {});
  }
});

// ---- 11b. An ADMIXTURE with no specificGravity on file fails the same
// ---- way (distinct from "no tank exists" — this is "can't even compute
// ---- how many liters", a data problem, not a storage-assignment one) --
// A previous commit message claimed this exact case was covered by the
// test above; it wasn't (that material was created WITH specificGravity
// 1.1) — this is the real test for it.

test("an ADMIXTURE with no specificGravity on file fails the whole completion", async () => {
  await resetSilo(50);
  const admixtureNoGravity = await prisma.material.create({ data: { name: "TEST-SUITE-ADMIXTURE-NO-GRAVITY", type: "ADMIXTURE", specificGravity: null } });
  try {
    const ticketId = await makeTicket([
      { materialId, targetMassKg: 1000 },
      { materialId: admixtureNoGravity.id, targetMassKg: 50 },
    ]);

    const result = await completeBatchTicket(ticketId, {});
    assert.equal(result.status, "STORAGE_NOT_CONFIGURED");
    if (result.status === "STORAGE_NOT_CONFIGURED") assert.match(result.material, /TEST-SUITE-ADMIXTURE-NO-GRAVITY/);

    const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(ticket.status, "RELEASED");
    assert.equal(await siloLevel(siloId), 50); // rolled back entirely, same as the no-tank case

    const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
    assert.equal(movements.length, 0);
  } finally {
    await prisma.material.delete({ where: { id: admixtureNoGravity.id } }).catch(() => {});
  }
});

// ---- 11b. A material marked inventoryTracked:false is skipped silently ----
test("a component whose material has inventoryTracked:false is skipped, not STORAGE_NOT_CONFIGURED", async () => {
  await resetSilo(50);
  const untrackedWater = await prisma.material.create({ data: { name: "TEST-SUITE-UNTRACKED-WATER", type: "WATER", inventoryTracked: false } });
  try {
    const ticketId = await makeTicket([
      { materialId, targetMassKg: 1000 },
      { materialId: untrackedWater.id, targetMassKg: 200 },
    ]);

    const result = await completeBatchTicket(ticketId, {});
    assert.equal(result.status, "SUCCESS");

    assert.equal(await siloLevel(siloId), 49); // the tracked component still posted normally

    const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
    assert.equal(movements.length, 1); // only the tracked component posted a movement
    assert.equal(movements[0].materialId, materialId);
  } finally {
    await prisma.material.delete({ where: { id: untrackedWater.id } }).catch(() => {});
  }
});

// ---- 12. Dispatch and reversal are mutually exclusive (CR-01) ---------
// startTrip itself (production/actions.ts) needs a session and can't be
// called directly from here — this mirrors its actual guard exactly (a
// fresh reversedAt/status re-check inside the same kind of Serializable
// transaction startTrip uses) rather than testing a paraphrase of it.

// Calls the REAL claimTripSlot (src/lib/tripDispatch.ts) — the exact
// function startTrip itself calls, per P1-02 in the review — inside the
// same Serializable transaction shape startTrip uses, then creates the
// Trip exactly as startTrip's own tx.trip.create call does.
async function tryDispatch(ticketId: string): Promise<"OK" | "REJECTED"> {
  try {
    await prisma.$transaction(
      async (tx) => {
        const claim = await claimTripSlot(tx, { ticketId, truckId });
        if (claim.status !== "OK") throw new Error(claim.status);
        const created = await tx.trip.create({ data: { batchTicketId: ticketId, truckId, driverId, status: "LOADING", batchTime: new Date() } });
        tripIds.push(created.id);
      },
      { isolationLevel: "Serializable" },
    );
    return "OK";
  } catch {
    return "REJECTED";
  }
}

test("a reversed ticket cannot be dispatched", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  assert.equal((await completeBatchTicket(ticketId, {})).status, "SUCCESS");
  assert.equal((await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "test" })).status, "SUCCESS");

  assert.equal(await tryDispatch(ticketId), "REJECTED");
  const tripCount = await prisma.trip.count({ where: { batchTicketId: ticketId } });
  assert.equal(tripCount, 0);
});

test("a dispatched ticket cannot be reversed", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  assert.equal((await completeBatchTicket(ticketId, {})).status, "SUCCESS");
  assert.equal(await tryDispatch(ticketId), "OK");

  const result = await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "test" });
  assert.equal(result.status, "INVALID_STATE");
  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.reversedAt, null);
});

test("concurrent reversal and dispatch on the same ticket are mutually exclusive", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  assert.equal((await completeBatchTicket(ticketId, {})).status, "SUCCESS");

  const [reversalResult, dispatchResult] = await Promise.all([
    reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "race test" }),
    tryDispatch(ticketId),
  ]);

  const reversed = reversalResult.status === "SUCCESS";
  const dispatched = dispatchResult === "OK";
  // The two must never both succeed for the same ticket — that's the
  // actual property CR-01 requires. Exactly one of them winning is the
  // expected, deterministic outcome (nothing else was racing either
  // transaction), asserted explicitly rather than just "not both".
  assert.ok(!(reversed && dispatched), "reversal and dispatch both succeeded for the same ticket");
  assert.notEqual(reversed, dispatched, "expected exactly one of reversal/dispatch to succeed, not both or neither");
});

// ---- 13. A reversal that can't fully fit is a hard failure (CR-04) ----

test("reversal fails atomically when the storage can't hold the full credit back", async () => {
  await resetSilo(20);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 6000 }]); // 6t
  assert.equal((await completeBatchTicket(ticketId, {})).status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 14); // 20 - 6

  // Simulate real receipts filling the silo back up almost to capacity
  // (500) in the meantime — reversing this ticket's 6t credit would need
  // to land at 504, which can't fit.
  await prisma.silo.update({ where: { id: siloId }, data: { currentLevelTons: 498 } });

  const result = await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "capacity test" });
  assert.equal(result.status, "CAPACITY_EXCEEDED");

  // Rolled back entirely — not clamped and stamped as if it succeeded.
  assert.equal(await siloLevel(siloId), 498);
  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.reversedAt, null);
  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 1); // only the original completion — no reversal row was left behind

  await prisma.silo.update({ where: { id: siloId }, data: { currentLevelTons: 14 } }); // restore for a clean re-check below
  const cleanReversal = await reverseBatchTicket(ticketId, { actorId: adminUserId, reason: "capacity test retry" });
  assert.equal(cleanReversal.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 20);
});

// ---- 14. Reclaim-shaped credits are idempotent -------------------------
// startTrip's reclaim credit-back isn't a separately callable domain
// function (it's inline in production/actions.ts), so this exercises the
// same postSiloMovement primitive it actually calls, with the same
// movementType/sourceType a real reclaim credit uses.

test("a RECLAIM_CREDIT-shaped movement posts once even if attempted twice", async () => {
  await resetSilo(20);
  const fakeTripSourceId = `test-trip-${Date.now()}`;

  const first = await prisma.$transaction((tx) =>
    postSiloMovement(tx, {
      storageId: siloId,
      materialId,
      quantity: 4,
      movementType: "RECLAIM_CREDIT",
      sourceType: "Trip",
      sourceId: fakeTripSourceId,
      plantId,
      siteId,
      actorId: adminUserId,
    }),
  );
  assert.equal(first.status, "OK");
  assert.equal(await siloLevel(siloId), 24);

  const second = await prisma.$transaction((tx) =>
    postSiloMovement(tx, {
      storageId: siloId,
      materialId,
      quantity: 4,
      movementType: "RECLAIM_CREDIT",
      sourceType: "Trip",
      sourceId: fakeTripSourceId,
      plantId,
      siteId,
      actorId: adminUserId,
    }),
  );
  assert.equal(second.status, "ALREADY_POSTED");
  assert.equal(await siloLevel(siloId), 24); // no double credit

  await deleteMovements({ sourceType: "Trip", sourceId: fakeTripSourceId });
  await resetSilo(20);
});

// ---- 15. Immutability is enforced by the database, not just app code --
// (HI-02 — supersedes a pure source-code scan as the authoritative proof;
// test 16 below keeps the source scan too, as a cheap early warning.)

test("the database itself rejects UPDATE and DELETE on a posted movement", async () => {
  await resetSilo(20);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  assert.equal((await completeBatchTicket(ticketId, {})).status, "SUCCESS");
  const [movement] = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.ok(movement);

  await assert.rejects(() => prisma.$executeRawUnsafe(`UPDATE "InventoryMovement" SET quantity = -999 WHERE id = $1`, movement.id), /immutable/);
  await assert.rejects(() => prisma.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE id = $1`, movement.id), /immutable/);

  const stillThere = await prisma.inventoryMovement.findUnique({ where: { id: movement.id } });
  assert.equal(stillThere?.quantity, movement.quantity);
});

// ---- 16. No application code updates or deletes an InventoryMovement --

test("no application service calls .update() or .delete() on inventoryMovement", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  const srcDir = path.join(import.meta.dirname, "..", "src");
  const offenders: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) {
        const content = readFileSync(full, "utf8");
        if (/inventoryMovement\.(update|updateMany|delete|deleteMany|upsert)\s*\(/.test(content)) {
          offenders.push(full);
        }
      }
    }
  }
  walk(srcDir);
  assert.deepEqual(offenders, [], `Found application code mutating InventoryMovement after posting: ${offenders.join(", ")}`);
});
