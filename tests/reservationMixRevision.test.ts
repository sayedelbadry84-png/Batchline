// Real PostgreSQL integration tests for the reservation mix-revision
// copy-on-write feature (src/lib/reservationMixRevisions.ts,
// src/lib/reservationRelease.ts's active-revision read, and its
// downstream integration with completion/reversal). Same
// TEST_DATABASE_URL-must-differ-from-DATABASE_URL safety gate, fixture
// naming ("TEST-SUITE-..."), and generic-sweep teardown as
// tests/batchCompletion.test.ts — see that file's own header comment for
// the full rationale; not repeated here.
//
// Scope note: this file proves the DOMAIN layer (the 10 scenarios below).
// Four of the spec's 15 scenarios live above the domain layer and are not
// reachable from a plain node:test process the way this suite runs:
//   - permission refusal (#8) and plant/site-scope refusal (#9) are
//     enforced in the Server Action wrapper
//     (production/reservationMixActions.ts), which calls getCurrentUser()
//     — a real Next.js request-scoped cookie read this harness has no
//     session for. What CAN be proven without a session is the
//     underlying pure logic those wrappers call — canPerformAction's role
//     grant and isSiteInScope's comparison — so both are exercised
//     directly below as a partial substitute, with live-browser
//     verification covering the actual end-to-end refusal.
//   - the audit trail (#13) is written by the same Server Action wrapper,
//     for the same reason not callable here — verified live instead.
//   - UI button gating (#14) and Arabic/English rendering (#15) are
//     browser-rendered concerns; the two dictionaries are proven
//     structurally identical in shape by `tsc`/`next build` already
//     passing (English is typed directly off the Arabic dictionary's
//     shape elsewhere in this codebase), and verified live in the
//     browser for actual rendering.
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
const { completeBatchTicket, reverseBatchTicket } = await import("../src/lib/batchCompletion");
const { releaseTicketForReservation } = await import("../src/lib/reservationRelease");
const { getEffectiveMix, saveReservationMixRevision, cancelActiveReservationMixRevision } = await import("../src/lib/reservationMixRevisions");
const { canPerformAction } = await import("../src/lib/permissions");
const { isSiteInScope } = await import("../src/lib/siteScope");

const prisma = new PrismaClient();

const CEMENT_PER_M3 = 300;
const WATER_PER_M3 = 150;
const REVISED_CEMENT_PER_M3 = 320;
const REVISED_WATER_PER_M3 = 140;

let siteId: string;
let plantId: string;
let cementMaterialId: string;
let waterMaterialId: string;
let cementSiloId: string;
let waterHopperId: string;
let mixId: string;
let projectId: string;
let customerId: string;
let adminUserId: string;

const reservationIds: string[] = [];
const ticketIds: string[] = [];

before(async () => {
  const site = await prisma.site.create({ data: { code: `TEST-SUITE-RMR-${Date.now()}`, name: "TEST-SUITE-SITE", city: "Test", country: "Test" } });
  siteId = site.id;
  const plant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-PLANT" } });
  plantId = plant.id;

  const cement = await prisma.material.create({ data: { name: "TEST-SUITE-CEMENT", type: "CEMENT" } });
  cementMaterialId = cement.id;
  const cementSilo = await prisma.silo.create({
    data: { plantId, name: "TEST-SUITE-SILO", materialType: "CEMENT", materialId: cementMaterialId, capacityTons: 500, currentLevelTons: 100, minThresholdPct: 15 },
  });
  cementSiloId = cementSilo.id;

  const water = await prisma.material.create({ data: { name: "TEST-SUITE-WATER", type: "WATER" } });
  waterMaterialId = water.id;
  const waterHopper = await prisma.hopper.create({
    data: { plantId, name: "TEST-SUITE-WATER-HOPPER", aggregateType: "WATER", materialId: waterMaterialId, capacityTons: 500, currentLevelTons: 100, minThresholdPct: 15 },
  });
  waterHopperId = waterHopper.id;

  const customer = await prisma.customer.create({ data: { legalName: "TEST-SUITE-CUSTOMER", creditLimit: 999999 } });
  customerId = customer.id;
  const project = await prisma.project.create({ data: { name: "TEST-SUITE-PROJECT", customerId, siteAddress: "Test Address" } });
  projectId = project.id;
  const mix = await prisma.mixDesign.create({
    data: {
      code: `TEST-SUITE-MIX-${Date.now()}`,
      grade: "C25",
      slumpTargetMm: 100,
      wcRatio: WATER_PER_M3 / CEMENT_PER_M3,
      components: { create: [{ materialId: cementMaterialId, designMassKgPerM3: CEMENT_PER_M3 }, { materialId: waterMaterialId, designMassKgPerM3: WATER_PER_M3 }] },
    },
  });
  mixId = mix.id;

  const admin = await prisma.user.create({
    data: { email: `test-suite-rmr-admin-${Date.now()}@example.invalid`, name: "TEST-SUITE-ADMIN", passwordHash: "not-a-real-hash", role: "ADMIN" },
  });
  adminUserId = admin.id;
});

async function deleteMovements(where: NonNullable<Parameters<typeof prisma.inventoryMovement.findMany>[0]>["where"]) {
  await prisma.$transaction([prisma.$executeRaw`SET LOCAL app.bypass_movement_immutability = 'on'`, prisma.inventoryMovement.deleteMany({ where })]);
}

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

async function makeReservation(overrides: Partial<{ status: string; requestedVolumeM3: number }> = {}) {
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `TEST-SUITE-RES-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      projectId,
      siteId,
      mixId,
      requestedVolumeM3: overrides.requestedVolumeM3 ?? 20,
      originalVolumeM3: overrides.requestedVolumeM3 ?? 20,
      pourWindowStart: new Date(),
      status: overrides.status ?? "CONFIRMED",
    },
  });
  reservationIds.push(reservation.id);
  return reservation.id;
}

after(async () => {
  for (const id of ticketIds) {
    await deleteMovements({ sourceType: "BatchTicket", sourceId: id });
    await prisma.shortageOverrideRequest.deleteMany({ where: { batchTicketId: id } });
    await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: id } });
    await cleanupDelete(() => prisma.batchTicket.delete({ where: { id } }));
  }
  for (const id of reservationIds) {
    await prisma.reservationMixRevisionComponent.deleteMany({ where: { revision: { reservationId: id } } });
    await prisma.reservationMixRevision.deleteMany({ where: { reservationId: id } });
    await cleanupDelete(() => prisma.reservation.delete({ where: { id } }));
  }
  await deleteMovements({ OR: [{ storageId: cementSiloId }, { storageId: waterHopperId }] });

  const leftoverMaterialIds = (await prisma.material.findMany({ where: { name: { startsWith: "TEST-SUITE-" } }, select: { id: true } })).map((m) => m.id);
  if (leftoverMaterialIds.length > 0) await deleteMovements({ materialId: { in: leftoverMaterialIds } });
  if (leftoverMaterialIds.length > 0) await prisma.batchComponentActual.deleteMany({ where: { materialId: { in: leftoverMaterialIds } } });
  await cleanupDelete(() => prisma.hopper.delete({ where: { id: waterHopperId } }));
  await cleanupDelete(() => prisma.silo.delete({ where: { id: cementSiloId } }));
  if (leftoverMaterialIds.length > 0) await cleanupDelete(() => prisma.material.deleteMany({ where: { id: { in: leftoverMaterialIds } } }));

  await cleanupDelete(() => prisma.mixDesign.delete({ where: { id: mixId } }));
  await cleanupDelete(() => prisma.project.delete({ where: { id: projectId } }));
  await cleanupDelete(() => prisma.customer.delete({ where: { id: customerId } }));
  await cleanupDelete(() => prisma.plant.delete({ where: { id: plantId } }));
  await cleanupDelete(() => prisma.site.delete({ where: { id: siteId } }));
  await cleanupDelete(() => prisma.user.delete({ where: { id: adminUserId } }));

  const residue = await Promise.all([
    prisma.material.count({ where: { name: { startsWith: "TEST-SUITE-" } } }),
    prisma.reservation.count({ where: { reservationNumber: { startsWith: "TEST-SUITE-" } } }),
    prisma.mixDesign.count({ where: { code: { startsWith: "TEST-SUITE-" } } }),
    prisma.site.count({ where: { name: { startsWith: "TEST-SUITE-" } } }),
    prisma.plant.count({ where: { name: { startsWith: "TEST-SUITE-" } } }),
    prisma.batchTicket.count({ where: { ticketNumber: { startsWith: "TEST-SUITE-" } } }),
  ]);
  assert.deepEqual(residue, [0, 0, 0, 0, 0, 0], `leftover TEST-SUITE-* fixtures after teardown: [material, reservation, mix, site, plant, ticket] = ${JSON.stringify(residue)}`);

  await prisma.$disconnect();
});

function revisedComponents() {
  return [
    { materialId: cementMaterialId, designMassKgPerM3: REVISED_CEMENT_PER_M3 },
    { materialId: waterMaterialId, designMassKgPerM3: REVISED_WATER_PER_M3 },
  ];
}

// ---- 1. Editing a reservation's mix never touches MixComponent --------

test("saving a reservation mix revision never changes MixDesign's own MixComponent rows", async () => {
  const reservationId = await makeReservation();
  const result = await saveReservationMixRevision(reservationId, { reason: "supplier substitution", actorId: adminUserId, components: revisedComponents() });
  assert.equal(result.status, "OK");

  const components = await prisma.mixComponent.findMany({ where: { mixId }, orderBy: { materialId: "asc" } });
  const cementRow = components.find((c) => c.materialId === cementMaterialId)!;
  const waterRow = components.find((c) => c.materialId === waterMaterialId)!;
  assert.equal(cementRow.designMassKgPerM3, CEMENT_PER_M3);
  assert.equal(waterRow.designMassKgPerM3, WATER_PER_M3);
});

// ---- 2. Another reservation on the same mix stays at original values --

test("a second reservation on the same mix design is unaffected by the first reservation's revision", async () => {
  const reservationA = await makeReservation();
  const reservationB = await makeReservation();
  const saved = await saveReservationMixRevision(reservationA, { reason: "site-specific correction", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");

  const effectiveA = await getEffectiveMix(prisma, reservationA, mixId);
  const effectiveB = await getEffectiveMix(prisma, reservationB, mixId);
  assert.equal(effectiveA.revisionNumber, 1);
  assert.equal(effectiveB.revisionNumber, null);
  const bCement = effectiveB.components.find((c) => c.materialId === cementMaterialId)!;
  assert.equal(bCement.designMassKgPerM3, CEMENT_PER_M3);
});

// ---- 3/4. New ticket uses the revision; an earlier ticket is frozen ---

test("a ticket released before the edit keeps its original components; a ticket released after uses the revision", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });

  const beforeTicket = await releaseTicketForReservation(reservationId, 5, plantId);
  assert.ok(beforeTicket);
  ticketIds.push(beforeTicket!.id);

  const saved = await saveReservationMixRevision(reservationId, { reason: "revise for remaining volume", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");

  const afterTicket = await releaseTicketForReservation(reservationId, 5, plantId);
  assert.ok(afterTicket);
  ticketIds.push(afterTicket!.id);

  const beforeActuals = await prisma.batchComponentActual.findMany({ where: { batchTicketId: beforeTicket!.id } });
  const afterActuals = await prisma.batchComponentActual.findMany({ where: { batchTicketId: afterTicket!.id } });

  assert.equal(beforeTicket!.reservationMixRevisionId, null);
  const beforeCement = beforeActuals.find((a) => a.materialId === cementMaterialId)!;
  assert.equal(beforeCement.targetMassKg, CEMENT_PER_M3 * 5);

  assert.equal(afterTicket!.reservationMixRevisionId, saved.status === "OK" ? saved.revisionId : null);
  const afterCement = afterActuals.find((a) => a.materialId === cementMaterialId)!;
  assert.equal(afterCement.targetMassKg, REVISED_CEMENT_PER_M3 * 5);

  // Re-confirm the earlier ticket truly never changed after the later
  // release, not just before it — same "frozen once issued" guarantee
  // checked from the other side.
  const beforeCementAgain = (await prisma.batchComponentActual.findMany({ where: { batchTicketId: beforeTicket!.id } })).find((a) => a.materialId === cementMaterialId)!;
  assert.equal(beforeCementAgain.targetMassKg, CEMENT_PER_M3 * 5);
});

// ---- 6/7. Inventory deduction and reversal use the modified quantities

test("completion deducts the revised quantities, and reversal credits back exactly what was deducted", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  const saved = await saveReservationMixRevision(reservationId, { reason: "heavier mix for this pour", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");

  const ticket = await releaseTicketForReservation(reservationId, 4, plantId);
  assert.ok(ticket);
  ticketIds.push(ticket!.id);

  const cementBefore = (await prisma.silo.findUniqueOrThrow({ where: { id: cementSiloId } })).currentLevelTons;
  const waterBefore = (await prisma.hopper.findUniqueOrThrow({ where: { id: waterHopperId } })).currentLevelTons;

  const completion = await completeBatchTicket(ticket!.id, {});
  assert.equal(completion.status, "SUCCESS");

  const expectedCementDeductionTons = (REVISED_CEMENT_PER_M3 * 4) / 1000;
  const expectedWaterDeductionTons = (REVISED_WATER_PER_M3 * 4) / 1000;
  const cementAfterComplete = (await prisma.silo.findUniqueOrThrow({ where: { id: cementSiloId } })).currentLevelTons;
  const waterAfterComplete = (await prisma.hopper.findUniqueOrThrow({ where: { id: waterHopperId } })).currentLevelTons;
  assert.ok(Math.abs(cementAfterComplete - (cementBefore - expectedCementDeductionTons)) < 1e-6);
  assert.ok(Math.abs(waterAfterComplete - (waterBefore - expectedWaterDeductionTons)) < 1e-6);

  const reversal = await reverseBatchTicket(ticket!.id, { actorId: adminUserId, reason: "TEST-SUITE-REVERSAL" });
  assert.equal(reversal.status, "SUCCESS");

  const cementAfterReversal = (await prisma.silo.findUniqueOrThrow({ where: { id: cementSiloId } })).currentLevelTons;
  const waterAfterReversal = (await prisma.hopper.findUniqueOrThrow({ where: { id: waterHopperId } })).currentLevelTons;
  assert.ok(Math.abs(cementAfterReversal - cementBefore) < 1e-6, "reversal must credit back exactly the revised quantity it deducted, restoring the pre-completion level");
  assert.ok(Math.abs(waterAfterReversal - waterBefore) < 1e-6);
});

// ---- 10. A cancelled reservation cannot be edited ----------------------

test("a cancelled reservation refuses a mix revision", async () => {
  const reservationId = await makeReservation({ status: "CANCELLED" });
  const result = await saveReservationMixRevision(reservationId, { reason: "should be refused", actorId: adminUserId, components: revisedComponents() });
  assert.equal(result.status, "INVALID_STATE");
});

// ---- 11. Concurrent save-vs-release never yields mixed components ------

test("a concurrent revision save and ticket release never produce a ticket with mixed old/new components", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });

  const [saveResult, ticket] = await Promise.all([
    saveReservationMixRevision(reservationId, { reason: "race condition check", actorId: adminUserId, components: revisedComponents() }),
    releaseTicketForReservation(reservationId, 5, plantId),
  ]);
  assert.equal(saveResult.status, "OK");

  // releaseTicketForReservation swallows a serialization conflict and
  // returns null (see its own comment) — a real caller would just retry,
  // so this test does too, to reach a ticket to actually inspect.
  const finalTicket = ticket ?? (await releaseTicketForReservation(reservationId, 5, plantId));
  assert.ok(finalTicket);
  ticketIds.push(finalTicket!.id);

  const actuals = await prisma.batchComponentActual.findMany({ where: { batchTicketId: finalTicket!.id } });
  const cementActual = actuals.find((a) => a.materialId === cementMaterialId)!;
  const waterActual = actuals.find((a) => a.materialId === waterMaterialId)!;

  if (finalTicket!.reservationMixRevisionId) {
    assert.equal(finalTicket!.reservationMixRevisionId, saveResult.status === "OK" ? saveResult.revisionId : null);
    assert.equal(cementActual.targetMassKg, REVISED_CEMENT_PER_M3 * finalTicket!.volumeM3);
    assert.equal(waterActual.targetMassKg, REVISED_WATER_PER_M3 * finalTicket!.volumeM3);
  } else {
    assert.equal(cementActual.targetMassKg, CEMENT_PER_M3 * finalTicket!.volumeM3);
    assert.equal(waterActual.targetMassKg, WATER_PER_M3 * finalTicket!.volumeM3);
  }
});

// ---- 12. Reset-to-original (cancel revision) works, never touching the main mix

test("cancelling the active revision reverts getEffectiveMix to the original mix, and the original MixComponent rows are still untouched", async () => {
  const reservationId = await makeReservation();
  const saved = await saveReservationMixRevision(reservationId, { reason: "temporary change", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");

  const cancelled = await cancelActiveReservationMixRevision(reservationId, { actorId: adminUserId });
  assert.equal(cancelled.status, "OK");

  const effective = await getEffectiveMix(prisma, reservationId, mixId);
  assert.equal(effective.revisionId, null);
  const cement = effective.components.find((c) => c.materialId === cementMaterialId)!;
  assert.equal(cement.designMassKgPerM3, CEMENT_PER_M3);

  const mixComponents = await prisma.mixComponent.findMany({ where: { mixId } });
  const mixCement = mixComponents.find((c) => c.materialId === cementMaterialId)!;
  assert.equal(mixCement.designMassKgPerM3, CEMENT_PER_M3);

  // A second cancel is a no-op, not an error — matches the same
  // claim-based idempotency shape as every other terminal-state guard in
  // this codebase (completeBatchTicket, reverseBatchTicket, etc.).
  const secondCancel = await cancelActiveReservationMixRevision(reservationId, { actorId: adminUserId });
  assert.equal(secondCancel.status, "NO_ACTIVE_REVISION");
});

// ---- 8/9 (partial — see file header). Pure permission/scope logic ------

test("the editReservationMix permission is granted only to the intended roles", async () => {
  assert.equal(await canPerformAction("PLANT_OPERATOR", "production", "editReservationMix"), true);
  assert.equal(await canPerformAction("ADMIN", "production", "editReservationMix"), true);
  assert.equal(await canPerformAction("ACCOUNTANT", "production", "editReservationMix"), false);
  assert.equal(await canPerformAction("DRIVER", "production", "editReservationMix"), false);
});

test("isSiteInScope refuses a reservation whose site differs from the operator's own site", async () => {
  assert.equal(isSiteInScope(siteId, siteId), true);
  assert.equal(isSiteInScope(siteId, "some-other-site-id"), false);
  // null siteId means unrestricted (ADMIN) — the one case where a
  // different site is still in scope.
  assert.equal(isSiteInScope(siteId, null), true);
});
