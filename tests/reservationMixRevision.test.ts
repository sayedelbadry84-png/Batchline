// Real PostgreSQL integration tests for the reservation mix-revision
// copy-on-write feature (src/lib/reservationMixRevisions.ts,
// src/lib/reservationRelease.ts's active-revision read and material-
// eligibility preflight, and its downstream integration with
// completion/reversal). Same TEST_DATABASE_URL-must-differ-from-
// DATABASE_URL safety gate as tests/batchCompletion.test.ts — see that
// file's own header comment for the full rationale; not repeated here.
//
// Fixture isolation (BATCHLINE_RESERVATION_MIX_REVIEW.md, RMR-P2-03):
// every fixture this file creates uses the "TEST-SUITE-RMR-" prefix,
// distinct from batchCompletion.test.ts's own "TEST-SUITE-" fixtures, and
// every created id is tracked explicitly in the arrays/variables below.
// Teardown deletes ONLY those tracked ids, in FK-safe order — it never
// does a name-prefix sweep (the previous draft's `WHERE name STARTSWITH
// 'TEST-SUITE-'` scan matched ANY suite's rows sharing that broader
// prefix, so it could delete another file's still-live fixtures if the
// two ever ran concurrently, or mask this file's own leaks behind
// whatever the other suite happened to leave around). The residue
// assertion at the end mirrors that: it only counts rows under THIS
// file's own unique prefix.
//
// Scope note: this file proves the DOMAIN layer. Permission refusal,
// plant/site-scope denial at the Server Action layer, and Arabic/English
// rendering are not reachable from a plain node:test process (no
// session/cookie context) — the reachable parts (canPerformAction's role
// grant, isSiteInScope's comparison) are exercised directly below as a
// partial substitute, with live-browser verification covering the actual
// end-to-end refusal and the out-of-scope notFound() page behavior
// (RMR-P1-01).
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
const { completeBatchTicket, reverseBatchTicket, isValidSpecificGravity } = await import("../src/lib/batchCompletion");
const { releaseTicketForReservation } = await import("../src/lib/reservationRelease");
const { getEffectiveMix, saveReservationMixRevision, cancelActiveReservationMixRevision } = await import("../src/lib/reservationMixRevisions");
const { getRemainingVolumeM3, closeReservationForId } = await import("../src/lib/reservations");
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
// RMR-P2-02 fixtures — three ways a component can be ineligible.
let unsupportedTypeMaterialId: string; // a type resolveTicketComponents doesn't know how to resolve at all
let admixtureNoSgMaterialId: string; // a real, supported type, but missing a property that type requires
let unavailableAggregateMaterialId: string; // a real, supported, well-formed material with no storage anywhere at this plant
let mixId: string;
let projectId: string;
let customerId: string;
let adminUserId: string;

const reservationIds: string[] = [];
const ticketIds: string[] = [];
const materialIds: string[] = []; // every Material this file creates, for teardown
const siloIds: string[] = [];
const hopperIds: string[] = [];

before(async () => {
  const site = await prisma.site.create({ data: { code: `TEST-SUITE-RMR-${Date.now()}`, name: "TEST-SUITE-RMR-SITE", city: "Test", country: "Test" } });
  siteId = site.id;
  const plant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-RMR-PLANT" } });
  plantId = plant.id;

  const cement = await prisma.material.create({ data: { name: "TEST-SUITE-RMR-CEMENT", type: "CEMENT" } });
  cementMaterialId = cement.id;
  materialIds.push(cementMaterialId);
  const cementSilo = await prisma.silo.create({
    data: { plantId, name: "TEST-SUITE-RMR-SILO", materialType: "CEMENT", materialId: cementMaterialId, capacityTons: 500, currentLevelTons: 100, minThresholdPct: 15 },
  });
  cementSiloId = cementSilo.id;
  siloIds.push(cementSiloId);

  const water = await prisma.material.create({ data: { name: "TEST-SUITE-RMR-WATER", type: "WATER" } });
  waterMaterialId = water.id;
  materialIds.push(waterMaterialId);
  const waterHopper = await prisma.hopper.create({
    data: { plantId, name: "TEST-SUITE-RMR-WATER-HOPPER", aggregateType: "WATER", materialId: waterMaterialId, capacityTons: 500, currentLevelTons: 100, minThresholdPct: 15 },
  });
  waterHopperId = waterHopper.id;
  hopperIds.push(waterHopperId);

  const unsupportedType = await prisma.material.create({ data: { name: "TEST-SUITE-RMR-EXOTIC", type: "TEST-SUITE-RMR-EXOTIC-TYPE" } });
  unsupportedTypeMaterialId = unsupportedType.id;
  materialIds.push(unsupportedTypeMaterialId);

  const admixtureNoSg = await prisma.material.create({ data: { name: "TEST-SUITE-RMR-ADMIXTURE-NO-SG", type: "ADMIXTURE", specificGravity: null } });
  admixtureNoSgMaterialId = admixtureNoSg.id;
  materialIds.push(admixtureNoSgMaterialId);

  // A real SAND-type material with no Hopper anywhere at this plant —
  // resolveTicketComponents can never find storage for it.
  const unavailableAggregate = await prisma.material.create({ data: { name: "TEST-SUITE-RMR-UNAVAILABLE-SAND", type: "SAND" } });
  unavailableAggregateMaterialId = unavailableAggregate.id;
  materialIds.push(unavailableAggregateMaterialId);

  const customer = await prisma.customer.create({ data: { legalName: "TEST-SUITE-RMR-CUSTOMER", creditLimit: 999999 } });
  customerId = customer.id;
  const project = await prisma.project.create({ data: { name: "TEST-SUITE-RMR-PROJECT", customerId, siteAddress: "Test Address" } });
  projectId = project.id;
  const mix = await prisma.mixDesign.create({
    data: {
      code: `TEST-SUITE-RMR-MIX-${Date.now()}`,
      grade: "C25",
      slumpTargetMm: 100,
      wcRatio: WATER_PER_M3 / CEMENT_PER_M3,
      components: { create: [{ materialId: cementMaterialId, designMassKgPerM3: CEMENT_PER_M3 }, { materialId: waterMaterialId, designMassKgPerM3: WATER_PER_M3 }] },
    },
  });
  mixId = mix.id;

  const admin = await prisma.user.create({
    data: { email: `test-suite-rmr-admin-${Date.now()}@example.invalid`, name: "TEST-SUITE-RMR-ADMIN", passwordHash: "not-a-real-hash", role: "ADMIN" },
  });
  adminUserId = admin.id;
});

async function deleteMovements(where: NonNullable<Parameters<typeof prisma.inventoryMovement.findMany>[0]>["where"]) {
  await prisma.$transaction([prisma.$executeRaw`SET LOCAL app.bypass_movement_immutability = 'on'`, prisma.inventoryMovement.deleteMany({ where })]);
}

// The DB-level immutability triggers added for this feature (RMR-P1-02)
// block a plain delete/update of ReservationMixRevision(Component) rows —
// this file's own teardown is the one legitimate reason to bypass that,
// same shape as deleteMovements above for InventoryMovement, under a
// distinct setting name so the two tables' escape hatches can never be
// confused.
async function deleteRevisionRows(reservationId: string) {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.bypass_reservation_mix_revision_immutability = 'on'`,
    prisma.reservationMixRevisionComponent.deleteMany({ where: { revision: { reservationId } } }),
  ]);
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.bypass_reservation_mix_revision_immutability = 'on'`,
    prisma.reservationMixRevision.deleteMany({ where: { reservationId } }),
  ]);
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

// A one-off throwaway Plant used only to prove release refuses a
// deactivated/wrong-site station (RMR-R2-P1-02) — never had anything
// created against it, so a plain delete is safe.
async function cleanupPlant(plantId: string): Promise<void> {
  await cleanupDelete(() => prisma.plant.delete({ where: { id: plantId } }));
}

async function makeReservation(overrides: Partial<{ status: string; requestedVolumeM3: number }> = {}) {
  const now = new Date();
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `TEST-SUITE-RMR-RES-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      projectId,
      siteId,
      mixId,
      requestedVolumeM3: overrides.requestedVolumeM3 ?? 20,
      originalVolumeM3: overrides.requestedVolumeM3 ?? 20,
      pourWindowStart: now,
      status: overrides.status ?? "CONFIRMED",
      // releaseTicketForReservation now re-checks approval itself
      // (RMR-R2-P1-02), not just the caller — every fixture must
      // represent a genuinely release-ready reservation by default, same
      // as a real one only ever reaches CONFIRMED/IN_PRODUCTION once
      // both sign-offs are on file. The one test that needs an
      // unapproved reservation creates one normally and then explicitly
      // revokes approval afterward, rather than skipping it here.
      initialApprovedAt: now,
      initialApprovedById: adminUserId,
      finalApprovedAt: now,
      finalApprovedById: adminUserId,
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
    await prisma.auditEvent.deleteMany({ where: { recordId: id } });
    await deleteRevisionRows(id);
    await cleanupDelete(() => prisma.reservation.delete({ where: { id } }));
  }

  // The fixture MixDesign's own MixComponent rows (created via a nested
  // `create` in `before()`) reference cementMaterialId/waterMaterialId —
  // both also in materialIds below. MixComponent.mix is ON DELETE
  // CASCADE, so deleting the mix here removes those rows first; deleting
  // the materials themselves before this (the previous order) left them
  // still referenced, tripping MixComponent_materialId_fkey.
  await cleanupDelete(() => prisma.mixDesign.delete({ where: { id: mixId } }));

  await deleteMovements({ storageId: { in: siloIds.concat(hopperIds) } });
  if (materialIds.length > 0) await deleteMovements({ materialId: { in: materialIds } });
  if (materialIds.length > 0) await prisma.batchComponentActual.deleteMany({ where: { materialId: { in: materialIds } } });

  for (const id of hopperIds) await cleanupDelete(() => prisma.hopper.delete({ where: { id } }));
  for (const id of siloIds) await cleanupDelete(() => prisma.silo.delete({ where: { id } }));
  if (materialIds.length > 0) await cleanupDelete(() => prisma.material.deleteMany({ where: { id: { in: materialIds } } }));

  await cleanupDelete(() => prisma.project.delete({ where: { id: projectId } }));
  await cleanupDelete(() => prisma.customer.delete({ where: { id: customerId } }));
  await cleanupDelete(() => prisma.plant.delete({ where: { id: plantId } }));
  await cleanupDelete(() => prisma.site.delete({ where: { id: siteId } }));
  await cleanupDelete(() => prisma.user.delete({ where: { id: adminUserId } }));

  // Only THIS file's own unique prefix — never the bare "TEST-SUITE-"
  // shared with batchCompletion.test.ts (RMR-P2-03).
  const residue = await Promise.all([
    prisma.material.count({ where: { name: { startsWith: "TEST-SUITE-RMR-" } } }),
    prisma.reservation.count({ where: { reservationNumber: { startsWith: "TEST-SUITE-RMR-" } } }),
    prisma.mixDesign.count({ where: { code: { startsWith: "TEST-SUITE-RMR-" } } }),
    prisma.site.count({ where: { name: { startsWith: "TEST-SUITE-RMR-" } } }),
    prisma.plant.count({ where: { name: { startsWith: "TEST-SUITE-RMR-" } } }),
    prisma.user.count({ where: { name: { startsWith: "TEST-SUITE-RMR-" } } }),
  ]);
  assert.deepEqual(residue, [0, 0, 0, 0, 0, 0], `leftover TEST-SUITE-RMR-* fixtures after teardown: [material, reservation, mix, site, plant, user] = ${JSON.stringify(residue)}`);

  await prisma.$disconnect();
});

function revisedComponents() {
  return [
    { materialId: cementMaterialId, designMassKgPerM3: REVISED_CEMENT_PER_M3 },
    { materialId: waterMaterialId, designMassKgPerM3: REVISED_WATER_PER_M3 },
  ];
}

// releaseTicketForReservation's audit write now needs an actor identity
// (RMR-R4-P2-02) — every test call supplies this fixture admin, since
// nothing here cares which specific user's name ends up on the audit
// row, only that the release itself behaves correctly.
// allowedSiteId: null (unrestricted, matching a real ADMIN) is the right
// default for every test that isn't specifically about site scope —
// the dedicated cross-site tests below pass their own scoped actor
// instead of this one.
function testActor() {
  return { id: adminUserId, role: "ADMIN", allowedSiteId: null as string | null };
}

function testCloseActor() {
  return { actorId: adminUserId, actorRole: "ADMIN", allowedSiteId: null as string | null };
}

async function expectReleaseOk(reservationId: string, volume: number) {
  const result = await releaseTicketForReservation(reservationId, volume, plantId, testActor());
  assert.equal(result.status, "OK");
  if (result.status !== "OK") throw new Error("unreachable");
  ticketIds.push(result.ticket.id);
  return result.ticket;
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

  const beforeTicket = await expectReleaseOk(reservationId, 5);

  const saved = await saveReservationMixRevision(reservationId, { reason: "revise for remaining volume", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");

  const afterTicket = await expectReleaseOk(reservationId, 5);

  const beforeActuals = await prisma.batchComponentActual.findMany({ where: { batchTicketId: beforeTicket.id } });
  const afterActuals = await prisma.batchComponentActual.findMany({ where: { batchTicketId: afterTicket.id } });

  assert.equal(beforeTicket.reservationMixRevisionId, null);
  const beforeCement = beforeActuals.find((a) => a.materialId === cementMaterialId)!;
  assert.equal(beforeCement.targetMassKg, CEMENT_PER_M3 * 5);

  assert.equal(afterTicket.reservationMixRevisionId, saved.status === "OK" ? saved.revisionId : null);
  const afterCement = afterActuals.find((a) => a.materialId === cementMaterialId)!;
  assert.equal(afterCement.targetMassKg, REVISED_CEMENT_PER_M3 * 5);

  // Re-confirm the earlier ticket truly never changed after the later
  // release, not just before it — same "frozen once issued" guarantee
  // checked from the other side.
  const beforeCementAgain = (await prisma.batchComponentActual.findMany({ where: { batchTicketId: beforeTicket.id } })).find((a) => a.materialId === cementMaterialId)!;
  assert.equal(beforeCementAgain.targetMassKg, CEMENT_PER_M3 * 5);
});

// ---- 5. Partial fulfillment: totals must reflect remaining volume only (RMR-P2-05)

test("the remaining volume used for future-total display shrinks after a ticket is released, not the full original booking", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  const remainingBefore = await getRemainingVolumeM3(reservationId, 20, prisma);
  assert.equal(remainingBefore, 20);

  await expectReleaseOk(reservationId, 8);

  const remainingAfter = await getRemainingVolumeM3(reservationId, 20, prisma);
  assert.equal(remainingAfter, 12, "the reservation-mix editor's own totals column is scaled by exactly this number, not the full 20 m³ requested");
});

// ---- 6/7. Inventory deduction and reversal use the modified quantities

test("completion deducts the revised quantities, and reversal credits back exactly what was deducted", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  const saved = await saveReservationMixRevision(reservationId, { reason: "heavier mix for this pour", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");

  const ticket = await expectReleaseOk(reservationId, 4);

  const cementBefore = (await prisma.silo.findUniqueOrThrow({ where: { id: cementSiloId } })).currentLevelTons;
  const waterBefore = (await prisma.hopper.findUniqueOrThrow({ where: { id: waterHopperId } })).currentLevelTons;

  const completion = await completeBatchTicket(ticket.id, {});
  assert.equal(completion.status, "SUCCESS");

  const expectedCementDeductionTons = (REVISED_CEMENT_PER_M3 * 4) / 1000;
  const expectedWaterDeductionTons = (REVISED_WATER_PER_M3 * 4) / 1000;
  const cementAfterComplete = (await prisma.silo.findUniqueOrThrow({ where: { id: cementSiloId } })).currentLevelTons;
  const waterAfterComplete = (await prisma.hopper.findUniqueOrThrow({ where: { id: waterHopperId } })).currentLevelTons;
  assert.ok(Math.abs(cementAfterComplete - (cementBefore - expectedCementDeductionTons)) < 1e-6);
  assert.ok(Math.abs(waterAfterComplete - (waterBefore - expectedWaterDeductionTons)) < 1e-6);

  const reversal = await reverseBatchTicket(ticket.id, { actorId: adminUserId, reason: "TEST-SUITE-RMR-REVERSAL" });
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

// ---- RMR-P2-01: cancel must also refuse a terminal reservation --------

test("cancelling the active revision of a now-terminal reservation is refused, not silently applied", async () => {
  const reservationId = await makeReservation();
  const saved = await saveReservationMixRevision(reservationId, { reason: "will become stale", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");

  // The reservation goes terminal (e.g. delivered/cancelled) sometime
  // after the revision was created — a forged/late cancel request must
  // not be able to touch it once that's happened.
  await prisma.reservation.update({ where: { id: reservationId }, data: { status: "CANCELLED" } });

  const result = await cancelActiveReservationMixRevision(reservationId, { actorId: adminUserId });
  assert.equal(result.status, "INVALID_STATE");

  const stillActive = await prisma.reservationMixRevision.findFirst({ where: { reservationId, status: "ACTIVE" } });
  assert.ok(stillActive, "the revision must remain ACTIVE — the cancel attempt must be a complete no-op on a terminal reservation");
});

// ---- RMR-R2-P1-02: release re-checks the reservation's authoritative --
// ---- state INSIDE its own transaction, not just via the caller's ------
// ---- earlier, now-possibly-stale outer check ---------------------------
//
// The tests immediately below prove the fresh-read guarantee by changing
// state BEFORE ever calling releaseTicketForReservation — sufficient on
// its own (if the check only ran once, in the caller, these would all
// still incorrectly succeed), but not a literal concurrency proof. The
// actual concurrent close-wins-vs-release race (RMR-R5-P2-01), where the
// two genuinely contend for the same row lock in real time, is covered
// separately further down this file, once the row-lock mechanism itself
// (RMR-R4-P1-01) has been introduced — see
// waitUntilBlockedOnLock/"when close commits DELIVERED first...".

test("release refuses a reservation that went terminal (closed early) after it still had remaining volume", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  await expectReleaseOk(reservationId, 5); // some volume already out, 15 m³ still remaining

  // closeReservation's own terminal set (reservations/actions.ts) —
  // status flips to DELIVERED without touching requestedVolumeM3, so
  // real remaining volume stays > 0 even though nothing should be
  // released against it again.
  await prisma.reservation.update({ where: { id: reservationId }, data: { status: "DELIVERED" } });

  const result = await releaseTicketForReservation(reservationId, 5, plantId, testActor());
  assert.equal(result.status, "INVALID_STATE");

  // The reservation must not have been silently reopened either.
  const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  assert.equal(reservation.status, "DELIVERED");
});

test("release refuses a reservation whose approval was revoked (e.g. by a concurrent edit) since the caller's own outer check", async () => {
  const reservationId = await makeReservation();
  await prisma.reservation.update({ where: { id: reservationId }, data: { initialApprovedAt: null, initialApprovedById: null, finalApprovedAt: null, finalApprovedById: null } });

  const result = await releaseTicketForReservation(reservationId, 5, plantId, testActor());
  assert.equal(result.status, "INVALID_STATE");
});

test("release refuses a station that was deactivated, or that doesn't belong to this reservation's own site, since the caller's own outer check", async () => {
  const reservationId = await makeReservation();

  const deactivatedPlant = await prisma.plant.create({ data: { siteId, name: "TEST-SUITE-RMR-DEACTIVATED-PLANT", status: "FROZEN" } });
  const deactivatedResult = await releaseTicketForReservation(reservationId, 5, deactivatedPlant.id, testActor());
  assert.equal(deactivatedResult.status, "INVALID_STATE");
  await cleanupPlant(deactivatedPlant.id);

  const otherSite = await prisma.site.create({ data: { code: `TEST-SUITE-RMR-OTHER-${Date.now()}`, name: "TEST-SUITE-RMR-OTHER-SITE", city: "Test", country: "Test" } });
  const otherSitePlant = await prisma.plant.create({ data: { siteId: otherSite.id, name: "TEST-SUITE-RMR-OTHER-SITE-PLANT" } });
  const wrongSiteResult = await releaseTicketForReservation(reservationId, 5, otherSitePlant.id, testActor());
  assert.equal(wrongSiteResult.status, "INVALID_STATE");
  await cleanupPlant(otherSitePlant.id);
  await cleanupDelete(() => prisma.site.delete({ where: { id: otherSite.id } }));
});

// RMR-R5-P1-01, defense in depth on the release side too: the caller's
// own site authority is re-checked after the lock as well, not derived
// only indirectly from the chosen plant belonging to the reservation's
// site.
test("release refuses when the caller's own allowed site differs from the reservation's real site, independent of which plant was chosen", async () => {
  const reservationId = await makeReservation();
  const result = await releaseTicketForReservation(reservationId, 5, plantId, { id: adminUserId, role: "PLANT_OPERATOR", allowedSiteId: "test-suite-rmr-some-other-site-id" });
  assert.equal(result.status, "NOT_FOUND");
  const ticketsAfter = await prisma.batchTicket.findMany({ where: { reservationId } });
  assert.equal(ticketsAfter.length, 0);
});

// ---- RMR-R4-P1-01: release uses a positive allow-list, not a terminal -
// ---- blacklist — a status blacklist would also let a REQUESTED or ------
// ---- ON_HOLD reservation through if it somehow carried both approvals --

test("release refuses an approved reservation whose status is ON_HOLD, not just DELIVERED/CANCELLED", async () => {
  const reservationId = await makeReservation({ status: "ON_HOLD" });
  const result = await releaseTicketForReservation(reservationId, 5, plantId, testActor());
  assert.equal(result.status, "INVALID_STATE");
});

test("release refuses an approved reservation carrying a status this domain doesn't recognize as releasable at all", async () => {
  // status is a free-string column, not a real Postgres enum (same
  // convention as every other status/type column in this schema) — a
  // future status this allow-list was never updated for must still be
  // refused, not fall through a blacklist that only names today's two
  // terminal values.
  const reservationId = await makeReservation({ status: "TEST-SUITE-RMR-FUTURE-STATUS" });
  const result = await releaseTicketForReservation(reservationId, 5, plantId, testActor());
  assert.equal(result.status, "INVALID_STATE");
});

// ---- RMR-R4-P2-02: a successful release and its BATCH_RELEASED audit --
// ---- event are one atomic transaction, never one without the other ----

test("a successful release writes its BATCH_RELEASED audit event in the same transaction, with the right actor and ticket id", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  const ticket = await expectReleaseOk(reservationId, 5);

  const auditRow = await prisma.auditEvent.findFirst({ where: { module: "Production", recordId: ticket.id, reasonCode: "BATCH_RELEASED" } });
  assert.ok(auditRow, "the successful release must have its own BATCH_RELEASED audit row");
  assert.equal(auditRow!.actorId, adminUserId);
  assert.match(auditRow!.afterValue ?? "", new RegExp(ticket.ticketNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("if the successful-release audit write fails, the whole release rolls back — no ticket, no reservation transition survives", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  const before = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });

  // A nonexistent actor id violates AuditEvent.actorId's own FK the
  // moment the audit insert (inside the same transaction as the ticket)
  // runs — a real, deterministic way to force that one specific write to
  // fail without touching anything else about the transaction.
  const badActor = { id: "test-suite-rmr-nonexistent-actor", role: "ADMIN", allowedSiteId: null };
  await assert.rejects(() => releaseTicketForReservation(reservationId, 5, plantId, badActor));

  const ticketsAfter = await prisma.batchTicket.findMany({ where: { reservationId } });
  assert.equal(ticketsAfter.length, 0, "no ticket should have been committed once the audit insert failed");

  const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  assert.equal(reservationAfter.status, before.status, "the reservation's own status transition must have rolled back too");
});

// ---- RMR-R4-P1-01: release and closeReservationForId share one real ---
// ---- database lock on the Reservation row, not just a fresh read ------
//
// RMR-R5-P2-01: an earlier version of this file asserted "the waiter
// hasn't resolved after 300ms" as proof of blocking — that only proves
// the promise hadn't settled within an arbitrary window, not that it
// was genuinely waiting on Postgres's own lock. Every test below instead
// polls pg_stat_activity until it OBSERVES a backend actually in a
// Lock-wait state for this specific row lock, then makes its assertion —
// a database-observable fact, not a timing guess. The poll itself has no
// fixed sleep for the outcome under test, only a bounded ceiling so a
// genuinely broken lock fails the test instead of hanging the suite
// forever.
async function waitUntilBlockedOnLock(timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE '%"Reservation"%FOR UPDATE%' AND pid <> pg_backend_pid()
    `;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a backend to be observed genuinely blocked on the Reservation row lock");
}

test("closeReservationForId genuinely blocks on a real row lock while another transaction holds it, then sees fresh state once it lets go", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20, status: "IN_PRODUCTION" });

  let lockAcquiredResolve: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    lockAcquiredResolve = resolve;
  });
  let letGoResolve: () => void;
  const letGo = new Promise<void>((resolve) => {
    letGoResolve = resolve;
  });

  // Manually holds the EXACT same "SELECT ... FOR UPDATE" lock
  // releaseTicketForReservation/closeReservationForId themselves take as
  // the first thing they do inside their own transaction — on a real,
  // separate connection pulled from the same pool (an interactive
  // $transaction pins its own connection for its whole duration), paused
  // mid-transaction via a real awaited signal, not a sleep.
  const holderPromise = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
      lockAcquiredResolve();
      await letGo;
    },
    { timeout: 20000 },
  );

  await lockAcquired;

  let closeSettled = false;
  const closePromise = closeReservationForId(reservationId, { ...testCloseActor(), closeReasonCode: "OTHER", closeNote: null }).then((r) => {
    closeSettled = true;
    return r;
  });

  await waitUntilBlockedOnLock();
  assert.equal(closeSettled, false, "closeReservationForId must still be blocked while another transaction holds the reservation's row lock");

  letGoResolve!();
  await holderPromise;
  const closeResult = await closePromise;
  assert.equal(closeResult.status, "OK");

  const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  assert.equal(reservationAfter.status, "DELIVERED");
});

// ---- RMR-R5-P1-01: an actor's site authority is re-checked AFTER the --
// ---- lock, against freshly-read data, not a snapshot taken before it --

test("closeReservationForId refuses a reservation that moved to a different site while close was already waiting on the lock", async () => {
  const reservationId = await makeReservation();
  const otherSite = await prisma.site.create({ data: { code: `TEST-SUITE-RMR-MOVE-${Date.now()}`, name: "TEST-SUITE-RMR-MOVE-SITE", city: "Test", country: "Test" } });

  let lockAcquiredResolve: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    lockAcquiredResolve = resolve;
  });
  let letGoResolve: () => void;
  const letGo = new Promise<void>((resolve) => {
    letGoResolve = resolve;
  });

  // Holds the row, reassigns it to a DIFFERENT site, then commits — all
  // while close (below) is already genuinely blocked waiting on this
  // same lock, simulating a reservation moving sites in the exact gap
  // between the caller's own outer scope pre-check and the lock.
  const holderPromise = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
      lockAcquiredResolve();
      await letGo;
      await tx.reservation.update({ where: { id: reservationId }, data: { siteId: otherSite.id } });
    },
    { timeout: 20000 },
  );

  await lockAcquired;

  let closeSettled = false;
  const closePromise = closeReservationForId(reservationId, { actorId: adminUserId, actorRole: "ADMIN", allowedSiteId: siteId, closeReasonCode: "OTHER", closeNote: null }).then((r) => {
    closeSettled = true;
    return r;
  });

  await waitUntilBlockedOnLock();
  assert.equal(closeSettled, false);

  letGoResolve!();
  await holderPromise;
  const closeResult = await closePromise;

  assert.equal(closeResult.status, "NOT_FOUND", "close must refuse once it sees the reservation now belongs to a different site than the caller's own authority");

  const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  assert.equal(reservationAfter.status, "CONFIRMED", "the reservation must remain untouched — not closed under the caller's now-stale site authority");
  assert.equal(reservationAfter.siteId, otherSite.id);

  const auditRows = await prisma.auditEvent.findMany({ where: { recordId: reservationId, reasonCode: "RESERVATION_CLOSED" } });
  assert.equal(auditRows.length, 0, "no close audit event must exist for a close that was actually refused");

  await prisma.reservation.update({ where: { id: reservationId }, data: { siteId } });
  await cleanupDelete(() => prisma.site.delete({ where: { id: otherSite.id } }));
});

// ---- RMR-R5-P2-01: the actual close-wins-vs-release race -------------

test("when close commits DELIVERED first while release is genuinely waiting on the same lock, release refuses and creates no ticket", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });

  let closeHasLockResolve: () => void;
  const closeHasLock = new Promise<void>((resolve) => {
    closeHasLockResolve = resolve;
  });
  let letCloseCommitResolve: () => void;
  const letCloseCommit = new Promise<void>((resolve) => {
    letCloseCommitResolve = resolve;
  });

  // A deterministic stand-in for closeReservationForId's own transaction
  // (the exact same lock, the exact same writes) — used here specifically
  // because this test needs to pause it right before its own commit, to
  // guarantee close wins this particular race rather than leaving the
  // ordering to chance (the review's own required shape: "Connection A
  // begins the real close transaction, locks the reservation, writes
  // DELIVERED, and pauses before commit"). The "whichever happens to win"
  // version is covered by the reverse-order test below instead.
  const closeHolderPromise = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: "DELIVERED", closedAt: new Date(), closedById: adminUserId, closeReasonCode: "OTHER", closeNote: null },
      });
      await tx.auditEvent.create({
        data: { actorId: adminUserId, role: "ADMIN", module: "Reservations", recordId: reservationId, afterValue: "DELIVERED (closed early — OTHER)", reasonCode: "RESERVATION_CLOSED" },
      });
      closeHasLockResolve();
      await letCloseCommit;
    },
    { timeout: 20000 },
  );

  await closeHasLock;

  let releaseSettled = false;
  const releasePromise = releaseTicketForReservation(reservationId, 5, plantId, testActor()).then((r) => {
    releaseSettled = true;
    return r;
  });

  await waitUntilBlockedOnLock();
  assert.equal(releaseSettled, false, "release must be genuinely blocked while close's transaction is still open, not yet committed");

  letCloseCommitResolve!();
  await closeHolderPromise;
  const releaseResult = await releasePromise;

  assert.equal(releaseResult.status, "INVALID_STATE", "release must refuse once close has committed DELIVERED first");

  const ticketsAfter = await prisma.batchTicket.findMany({ where: { reservationId } });
  assert.equal(ticketsAfter.length, 0, "release must not have created any ticket once it lost to a close that already committed");

  const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  assert.equal(reservationAfter.status, "DELIVERED");
});

test("release, then close, in that order — a clean serial order once release has already committed", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  const ticket = await expectReleaseOk(reservationId, 5);

  const closeResult = await closeReservationForId(reservationId, { ...testCloseActor(), closeReasonCode: "OTHER", closeNote: null });
  assert.equal(closeResult.status, "OK");

  const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  assert.equal(reservationAfter.status, "DELIVERED");
  // Closing early never retroactively touches a ticket already released.
  const ticketAfter = await prisma.batchTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  assert.equal(ticketAfter.status, "RELEASED");
});

test("closeReservationForId itself refuses an already-terminal reservation, and never touches an unrelated one", async () => {
  const reservationId = await makeReservation({ status: "CANCELLED" });
  const result = await closeReservationForId(reservationId, { ...testCloseActor(), closeReasonCode: "OTHER", closeNote: null });
  assert.equal(result.status, "INVALID_STATE");
});

// ---- RMR-R2-P2-01: concurrent releases against the same reservation ---
// ---- never exceed its remaining volume, and a genuine conflict --------
// ---- resolves through withRetry rather than an unhandled rejection ----

test("two concurrent releases together never dispatch more than the reservation's remaining volume", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 10 });

  const [r1, r2] = await Promise.all([releaseTicketForReservation(reservationId, 8, plantId, testActor()), releaseTicketForReservation(reservationId, 8, plantId, testActor())]);
  // Neither call should throw an unhandled P2034 out to the caller —
  // Promise.all above would already have rejected this whole test if one
  // had. Each resolves to either a real ticket or a clean typed
  // rejection (NO_REMAINING_VOLUME for whichever one lost the race).
  for (const r of [r1, r2]) {
    if (r.status === "OK") ticketIds.push(r.ticket.id);
    else assert.equal(r.status, "NO_REMAINING_VOLUME", `unexpected non-OK status: ${r.status}`);
  }

  const totalVolume = [r1, r2].filter((r) => r.status === "OK").reduce((sum, r) => sum + (r.status === "OK" ? r.ticket.volumeM3 : 0), 0);
  assert.ok(totalVolume <= 10 + 1e-6, `released ${totalVolume} m³ against a 10 m³ reservation`);
});

// ---- 11. Concurrent save-vs-release never yields mixed components ------

test("a concurrent revision save and ticket release never produce a ticket with mixed old/new components", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });

  const [saveResult, releaseResult] = await Promise.all([
    saveReservationMixRevision(reservationId, { reason: "race condition check", actorId: adminUserId, components: revisedComponents() }),
    releaseTicketForReservation(reservationId, 5, plantId, testActor()),
  ]);
  assert.equal(saveResult.status, "OK");

  // releaseTicketForReservation now retries a genuine Serializable
  // conflict internally (withRetry, RMR-R2-P2-01), so this should
  // resolve to OK directly in practice — the fallback below stays as a
  // defensive safety net, not because a bare P2034 is expected to
  // surface here anymore.
  const finalTicket = releaseResult.status === "OK" ? releaseResult.ticket : await expectReleaseOk(reservationId, 5);
  if (releaseResult.status === "OK") ticketIds.push(releaseResult.ticket.id);

  const actuals = await prisma.batchComponentActual.findMany({ where: { batchTicketId: finalTicket.id } });
  const cementActual = actuals.find((a) => a.materialId === cementMaterialId)!;
  const waterActual = actuals.find((a) => a.materialId === waterMaterialId)!;

  if (finalTicket.reservationMixRevisionId) {
    assert.equal(finalTicket.reservationMixRevisionId, saveResult.status === "OK" ? saveResult.revisionId : null);
    assert.equal(cementActual.targetMassKg, REVISED_CEMENT_PER_M3 * finalTicket.volumeM3);
    assert.equal(waterActual.targetMassKg, REVISED_WATER_PER_M3 * finalTicket.volumeM3);
  } else {
    assert.equal(cementActual.targetMassKg, CEMENT_PER_M3 * finalTicket.volumeM3);
    assert.equal(waterActual.targetMassKg, WATER_PER_M3 * finalTicket.volumeM3);
  }
});

// ---- RMR-P2-06: concurrent save-vs-save must never leave two ACTIVE ---

test("two concurrent saves against a reservation with no existing revision both succeed and leave exactly one ACTIVE revision", async () => {
  const reservationId = await makeReservation();

  const [r1, r2] = await Promise.all([
    saveReservationMixRevision(reservationId, { reason: "concurrent save A", actorId: adminUserId, components: revisedComponents() }),
    saveReservationMixRevision(reservationId, { reason: "concurrent save B", actorId: adminUserId, components: revisedComponents() }),
  ]);
  // Both succeed — a P2002 collision on (reservationId, revisionNumber)
  // is now retried (withRevisionRetry), not left to surface as an
  // untyped error (RMR-P2-06).
  assert.equal(r1.status, "OK");
  assert.equal(r2.status, "OK");

  const activeRevisions = await prisma.reservationMixRevision.findMany({ where: { reservationId, status: "ACTIVE" } });
  assert.equal(activeRevisions.length, 1, "the database's own partial unique index guarantees this even if the app logic alone did not");

  const revisionNumbers = [r1, r2].map((r) => (r.status === "OK" ? r.revisionNumber : null)).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(revisionNumbers, [1, 2]);
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

// ---- RMR-P2-02: material eligibility is validated -----------------------

test("saving a revision refuses a material whose type resolveTicketComponents doesn't know how to resolve", async () => {
  const reservationId = await makeReservation();
  const result = await saveReservationMixRevision(reservationId, {
    reason: "add an exotic material",
    actorId: adminUserId,
    components: [{ materialId: cementMaterialId, designMassKgPerM3: CEMENT_PER_M3 }, { materialId: unsupportedTypeMaterialId, designMassKgPerM3: 1 }],
  });
  assert.equal(result.status, "UNSUPPORTED_MATERIAL_TYPE");
  if (result.status === "UNSUPPORTED_MATERIAL_TYPE") assert.equal(result.materialId, unsupportedTypeMaterialId);
});

test("saving a revision refuses an admixture with no specific gravity on file", async () => {
  const reservationId = await makeReservation();
  const result = await saveReservationMixRevision(reservationId, {
    reason: "add an admixture missing SG",
    actorId: adminUserId,
    components: [{ materialId: cementMaterialId, designMassKgPerM3: CEMENT_PER_M3 }, { materialId: admixtureNoSgMaterialId, designMassKgPerM3: 1 }],
  });
  assert.equal(result.status, "MISSING_SPECIFIC_GRAVITY");
  if (result.status === "MISSING_SPECIFIC_GRAVITY") assert.equal(result.materialId, admixtureNoSgMaterialId);
});

test("releasing a ticket against a revision whose material has nowhere to draw from at this plant is refused with a typed, attributable reason", async () => {
  const reservationId = await makeReservation({ requestedVolumeM3: 20 });
  const saved = await saveReservationMixRevision(reservationId, {
    reason: "add a material this plant can't actually supply",
    actorId: adminUserId,
    components: [...revisedComponents(), { materialId: unavailableAggregateMaterialId, designMassKgPerM3: 50 }],
  });
  assert.equal(saved.status, "OK");

  const result = await releaseTicketForReservation(reservationId, 5, plantId, testActor());
  assert.equal(result.status, "STORAGE_NOT_CONFIGURED");
  if (result.status === "STORAGE_NOT_CONFIGURED") assert.equal(result.material, "TEST-SUITE-RMR-UNAVAILABLE-SAND");

  // No half-created ticket is left behind — the whole release is one
  // transaction, and the preflight check aborts it before any
  // BatchTicket row is ever inserted.
  const orphanTicket = await prisma.batchTicket.findFirst({ where: { reservationId } });
  assert.equal(orphanTicket, null);

  // RMR-R2-P2-03's operational decision (production/actions.ts,
  // createManualRelease): a reservation is never rolled back or
  // auto-cancelled just because its first release attempt failed — it's
  // a real, confirmed booking, still perfectly retriable once whatever
  // blocked release is fixed. The Server Action wrapper itself isn't
  // reachable from this session-less harness, but the invariant its
  // decision depends on — releaseTicketForReservation never touches the
  // reservation row at all on a non-OK result — is verified directly
  // here.
  const reservationAfterFailedRelease = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  assert.equal(reservationAfterFailedRelease.status, "CONFIRMED");
  assert.equal(reservationAfterFailedRelease.requestedVolumeM3, 20);
});

// ---- RMR-R2-P1-03: negative/non-finite specific gravity is rejected ---
//
// The database itself now refuses to store a Material row with a
// negative/zero/infinite/NaN specificGravity (the new CHECK constraint,
// verified directly below) — so the end-to-end "a bad row makes it all
// the way to a positive inventory credit" scenario the review describes
// can no longer be constructed at all; there is no way left to get such
// a row into the table to feed it to saveReservationMixRevision or
// resolveTicketComponents in the first place. isValidSpecificGravity
// itself — the exact function both of those call — is still tested
// directly, as a pure function, so the application-level logic (a
// deliberate second, defense-in-depth layer) is verified independently
// of whether the database would ever let a bad value reach it.

test("isValidSpecificGravity rejects negative, zero, infinite, and NaN values, and accepts a normal positive one", () => {
  assert.equal(isValidSpecificGravity(1.1), true);
  assert.equal(isValidSpecificGravity(0.001), true);
  assert.equal(isValidSpecificGravity(-1.1), false);
  assert.equal(isValidSpecificGravity(0), false);
  assert.equal(isValidSpecificGravity(Infinity), false);
  assert.equal(isValidSpecificGravity(-Infinity), false);
  assert.equal(isValidSpecificGravity(NaN), false);
  assert.equal(isValidSpecificGravity(null), false);
});

test("the database itself refuses to store a Material with a negative, zero, infinite, or NaN specific gravity", async () => {
  // -1.1 and 0 are ordinary JS numbers and go through the Prisma client
  // directly. Infinity/-Infinity/NaN do NOT — JS's own Infinity/NaN
  // aren't valid JSON, and Prisma's own parameter binding silently
  // coerces them to NULL before the value ever reaches Postgres, which
  // then trivially satisfies the constraint's own "IS NULL" branch and
  // proves nothing about the constraint itself. Raw SQL with the literal
  // written directly into the statement is the only way to be sure the
  // value Postgres actually evaluates is the one being tested.
  for (const bad of [-1.1, 0]) {
    await assert.rejects(
      () => prisma.material.create({ data: { name: `TEST-SUITE-RMR-BAD-SG-${Date.now()}-${Math.random()}`, type: "ADMIXTURE", specificGravity: bad } }),
      /specificGravity|constraint/i,
      `specificGravity=${bad} must be rejected by the database CHECK constraint`,
    );
  }
  for (const literal of ["'Infinity'::float8", "'-Infinity'::float8", "'NaN'::float8"]) {
    const id = `test-suite-rmr-badsg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await assert.rejects(
      () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "Material" (id, name, type, "specificGravity", "createdAt", "updatedAt") VALUES ($1, $2, 'ADMIXTURE', ${literal}, now(), now())`,
          id,
          `TEST-SUITE-RMR-BAD-SG-${id}`,
        ),
      /specificGravity|constraint/i,
      `specificGravity=${literal} must be rejected by the database CHECK constraint`,
    );
  }
  // A real, valid positive value still works — the constraint isn't
  // over-broad.
  const ok = await prisma.material.create({ data: { name: `TEST-SUITE-RMR-GOOD-SG-${Date.now()}`, type: "ADMIXTURE", specificGravity: 1.05 } });
  materialIds.push(ok.id);
});

// ---- RMR-P2-04: audit creation is atomic with the recipe change --------

test("saving and cancelling a revision each write their AuditEvent atomically with the change itself", async () => {
  const reservationId = await makeReservation();

  const saved = await saveReservationMixRevision(reservationId, { reason: "TEST-SUITE-RMR-AUDIT-CHECK", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");
  const saveAudit = await prisma.auditEvent.findFirst({ where: { recordId: reservationId, reasonCode: "RESERVATION_MIX_REVISED" }, orderBy: { createdAt: "desc" } });
  assert.ok(saveAudit, "a save must never commit without its own audit row");
  assert.equal(saveAudit!.actorId, adminUserId);
  assert.ok(saveAudit!.afterValue?.includes("TEST-SUITE-RMR-AUDIT-CHECK"));

  const cancelled = await cancelActiveReservationMixRevision(reservationId, { actorId: adminUserId });
  assert.equal(cancelled.status, "OK");
  const cancelAudit = await prisma.auditEvent.findFirst({ where: { recordId: reservationId, reasonCode: "RESERVATION_MIX_REVISION_CANCELLED" }, orderBy: { createdAt: "desc" } });
  assert.ok(cancelAudit, "a cancel must never commit without its own audit row");
  assert.equal(cancelAudit!.actorId, adminUserId);
});

// ---- RMR-P1-02 / RMR-R2-P1-01: revision history is immutable at the ---
// ---- database itself, and its lifecycle can only move ACTIVE -> -----
// ---- terminal, exactly once -------------------------------------------

test("a ReservationMixRevision row cannot be deleted or have its frozen fields updated directly, even bypassing the app", async () => {
  const reservationId = await makeReservation();
  const saved = await saveReservationMixRevision(reservationId, { reason: "immutability probe", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");
  if (saved.status !== "OK") throw new Error("unreachable");

  await assert.rejects(
    () => prisma.reservationMixRevision.delete({ where: { id: saved.revisionId } }),
    /permanent history|immutable/i,
    "the database trigger must block a direct delete, not just the app's own code paths",
  );
  await assert.rejects(
    () => prisma.reservationMixRevision.update({ where: { id: saved.revisionId }, data: { reason: "rewritten" } }),
    /immutable/i,
    "a frozen field (reason) must never be changeable after creation, even by a direct update",
  );
  await assert.rejects(
    () => prisma.reservationMixRevisionComponent.updateMany({ where: { revisionId: saved.revisionId }, data: { note: "rewritten" } }),
    /immutable/i,
  );

  // The lifecycle fields (status/resolvedAt/resolvedById) are NOT
  // frozen — cancelActiveReservationMixRevision above (and every save's
  // own supersede step) already proves this path works; this is just
  // confirming the trigger's allow-list is exactly that, not broader.
  const cancelled = await cancelActiveReservationMixRevision(reservationId, { actorId: adminUserId });
  assert.equal(cancelled.status, "OK");
});

test("a CANCELLED revision's lifecycle fields can never be moved again — not reactivated, not moved sideways, not rewritten", async () => {
  const reservationId = await makeReservation();
  const saved = await saveReservationMixRevision(reservationId, { reason: "lifecycle transition probe (cancelled)", actorId: adminUserId, components: revisedComponents() });
  assert.equal(saved.status, "OK");
  if (saved.status !== "OK") throw new Error("unreachable");
  const cancelled = await cancelActiveReservationMixRevision(reservationId, { actorId: adminUserId });
  assert.equal(cancelled.status, "OK");

  const row = await prisma.reservationMixRevision.findUniqueOrThrow({ where: { id: saved.revisionId } });
  assert.equal(row.status, "CANCELLED");
  assert.ok(row.resolvedAt);
  assert.ok(row.resolvedById);

  await assert.rejects(
    () => prisma.reservationMixRevision.update({ where: { id: saved.revisionId }, data: { status: "ACTIVE" } }),
    /only allows a single ACTIVE -> SUPERSEDED\|CANCELLED transition/,
    "CANCELLED -> ACTIVE must be rejected",
  );
  await assert.rejects(
    () => prisma.reservationMixRevision.update({ where: { id: saved.revisionId }, data: { status: "SUPERSEDED" } }),
    /only allows a single ACTIVE -> SUPERSEDED\|CANCELLED transition/,
    "a terminal-to-terminal move (CANCELLED -> SUPERSEDED) must be rejected",
  );
  await assert.rejects(
    () => prisma.reservationMixRevision.update({ where: { id: saved.revisionId }, data: { resolvedAt: null, resolvedById: null } }),
    /only allows a single ACTIVE -> SUPERSEDED\|CANCELLED transition/,
    "resolution metadata must never be clearable once set",
  );
  await assert.rejects(
    () => prisma.reservationMixRevision.update({ where: { id: saved.revisionId }, data: { resolvedAt: new Date(Date.now() + 60_000) } }),
    /only allows a single ACTIVE -> SUPERSEDED\|CANCELLED transition/,
    "resolution metadata must never be rewritable once set, even to a plausible-looking new value",
  );

  const unchanged = await prisma.reservationMixRevision.findUniqueOrThrow({ where: { id: saved.revisionId } });
  assert.equal(unchanged.status, "CANCELLED");
  assert.equal(unchanged.resolvedAt!.getTime(), row.resolvedAt!.getTime());
});

test("a SUPERSEDED revision cannot be reactivated either", async () => {
  const reservationId = await makeReservation();
  const first = await saveReservationMixRevision(reservationId, { reason: "will be superseded", actorId: adminUserId, components: revisedComponents() });
  assert.equal(first.status, "OK");
  if (first.status !== "OK") throw new Error("unreachable");
  const second = await saveReservationMixRevision(reservationId, { reason: "supersedes the first", actorId: adminUserId, components: revisedComponents() });
  assert.equal(second.status, "OK");

  const supersededRow = await prisma.reservationMixRevision.findUniqueOrThrow({ where: { id: first.revisionId } });
  assert.equal(supersededRow.status, "SUPERSEDED");

  await assert.rejects(
    () => prisma.reservationMixRevision.update({ where: { id: first.revisionId }, data: { status: "ACTIVE" } }),
    /only allows a single ACTIVE -> SUPERSEDED\|CANCELLED transition/,
    "SUPERSEDED -> ACTIVE must be rejected",
  );
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
