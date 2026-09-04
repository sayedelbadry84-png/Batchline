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
const { completeBatchTicket, reverseBatchTicket } = await import("../src/lib/batchCompletion");
const { postSiloMovement } = await import("../src/lib/inventoryLedger");
const { claimAndRecordActuals, claimAndRecordActualField, claimAndAddTicketComponent, claimAndDeleteTicketComponent } = await import("../src/lib/batchComponentEdits");
const { claimTripSlot } = await import("../src/lib/tripDispatch");

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

after(async () => {
  for (const id of tripIds) {
    await prisma.drumReturn.deleteMany({ where: { tripId: id } });
    await prisma.trip.delete({ where: { id } }).catch(() => {});
  }
  for (const id of ticketIds) {
    await deleteMovements({ OR: [{ sourceType: "BatchTicket", sourceId: id }, { sourceType: "Trip", sourceId: id }] });
    await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: id } });
    await prisma.batchTicket.delete({ where: { id } }).catch(() => {});
  }
  await deleteMovements({ OR: [{ storageId: siloId }, { storageId: fallbackSiloId }] });
  await prisma.truck.delete({ where: { id: truckId } }).catch(() => {});
  await prisma.employee.delete({ where: { id: driverId } }).catch(() => {});
  await prisma.reservation.delete({ where: { id: reservationId } }).catch(() => {});
  await prisma.mixDesign.delete({ where: { id: mixId } }).catch(() => {});
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
  await prisma.customer.delete({ where: { id: customerId } }).catch(() => {});
  await prisma.silo.delete({ where: { id: fallbackSiloId } }).catch(() => {});
  await prisma.silo.delete({ where: { id: siloId } }).catch(() => {});
  await prisma.material.delete({ where: { id: materialId } }).catch(() => {});
  await prisma.plant.delete({ where: { id: plantId } }).catch(() => {});
  await prisma.site.delete({ where: { id: siteId } }).catch(() => {});
  await prisma.user.delete({ where: { id: adminUserId } }).catch(() => {});
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

test("a total stockout with an authorized override succeeds and posts no zero-quantity row", async () => {
  await resetSilo(0); // completely empty
  const ticketId = await makeTicket([{ materialId, targetMassKg: 5000 }]); // needs 5t, 0t on hand

  const result = await completeBatchTicket(ticketId, { shortageOverrideNote: "authorized total shortage" });
  assert.equal(result.status, "SUCCESS");
  if (result.status === "SUCCESS") assert.ok(result.shortages.length > 0, "expected the shortage to be reported even though completion succeeded");

  const ticket = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.equal(ticket.status, "COMPLETE");
  assert.equal(await siloLevel(siloId), 0); // never went negative, never "gained" anything either

  // No ledger row at all for this component — a zero-effect movement
  // isn't a real event, and the CHECK constraint would reject it anyway.
  const movements = await prisma.inventoryMovement.findMany({ where: { sourceType: "BatchTicket", sourceId: ticketId } });
  assert.equal(movements.length, 0);
});

test("insufficient stock without an override is still rejected even from a completely empty store", async () => {
  await resetSilo(0);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 5000 }]);

  const result = await completeBatchTicket(ticketId, {});
  assert.equal(result.status, "INSUFFICIENT_STOCK");
  assert.equal((await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticketId } })).status, "RELEASED");
  assert.equal(await siloLevel(siloId), 0);
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
  const secondMaterial = await prisma.material.create({ data: { name: "TEST-SUITE-CEMENT-RACE", type: "CEMENT", specificGravity: null } });
  try {
    // secondMaterial has no matching silo at all — if it DOES get added
    // and completion picks it up, completion must correctly fail with
    // STORAGE_NOT_CONFIGURED (CR-02) rather than silently ignoring it.
    const [completeResult, editResult] = await Promise.all([
      completeBatchTicket(ticketId, {}),
      claimAndAddTicketComponent(ticketId, secondMaterial.id, 500),
    ]);

    // TEMPORARY DEBUG — investigating a CI-only failure of this test, to
    // be reverted once diagnosed.
    console.log("DEBUG completeResult", JSON.stringify(completeResult));
    console.log("DEBUG editResult", JSON.stringify(editResult));
    console.log("DEBUG secondMaterial row", JSON.stringify(await prisma.material.findUnique({ where: { id: secondMaterial.id } })));
    console.log("DEBUG components after race", JSON.stringify(await prisma.batchComponentActual.findMany({ where: { batchTicketId: ticketId } })));

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
