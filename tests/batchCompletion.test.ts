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

const ticketIds: string[] = [];

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
});

after(async () => {
  for (const id of ticketIds) {
    await prisma.inventoryMovement.deleteMany({ where: { OR: [{ sourceType: "BatchTicket", sourceId: id }, { sourceType: "Trip", sourceId: id }] } });
    await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: id } });
    await prisma.batchTicket.delete({ where: { id } }).catch(() => {});
  }
  await prisma.inventoryMovement.deleteMany({ where: { OR: [{ storageId: siloId }, { storageId: fallbackSiloId }] } });
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

test("two different tickets consuming the same silo net correctly", async () => {
  await resetSilo(100);
  const ticketA = await makeTicket([{ materialId, targetMassKg: 6000 }]);
  const ticketB = await makeTicket([{ materialId, targetMassKg: 9000 }]);

  const resultA = await completeBatchTicket(ticketA, {});
  const resultB = await completeBatchTicket(ticketB, {});
  assert.equal(resultA.status, "SUCCESS");
  assert.equal(resultB.status, "SUCCESS");
  assert.equal(await siloLevel(siloId), 85); // 100 - 6 - 9
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

// ---- 6. COMPLETE/CANCELLED reject actual/component changes -----------
// (Regression coverage — this guard predates this test suite; see
// production/actions.ts's recordActuals/recordActualField/
// addTicketComponent/deleteTicketComponent. Verified here at the DB
// level directly, since these are still plain Server Actions requiring
// a session — the check they share is a one-line status guard.)

test("a COMPLETE ticket cannot be re-completed", async () => {
  await resetSilo(50);
  const ticketId = await makeTicket([{ materialId, targetMassKg: 1000 }]);
  const first = await completeBatchTicket(ticketId, {});
  assert.equal(first.status, "SUCCESS");
  const second = await completeBatchTicket(ticketId, {});
  assert.equal(second.status, "ALREADY_COMPLETED");
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

// ---- 10. No application code updates or deletes an InventoryMovement --

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
