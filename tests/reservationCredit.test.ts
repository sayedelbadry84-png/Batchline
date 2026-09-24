// Real PostgreSQL integration tests for the credit policy and reservation
// status rules (src/lib/creditPolicy.ts, src/lib/reservationEdits.ts,
// src/lib/manualBooking.ts, and the credit gate in
// src/lib/reservationRelease.ts). Same TEST_DATABASE_URL-must-differ gate
// as tests/batchCompletion.test.ts.
//
// Four paths used to make a reservation releasable, or release against
// one, without the credit decision createReservation made: the edit form's
// free status field (ON_HOLD -> CONFIRMED), quote conversion (see
// crossSiteAccess.test.ts, which has the session harness that action
// needs), the walk-in manual booking, and release itself once the customer
// went over the limit after approval. And updateReservation checked the
// released volume outside any lock, so a release landing in between let a
// reservation's mix change after a ticket had been made from it.
//
// Every fixture uses the "TEST-SUITE-RC-" prefix and every id is tracked;
// teardown deletes only those ids and asserts no residue under the prefix.
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
const { releaseTicketForReservation } = await import("../src/lib/reservationRelease");
const { updateReservationForId, approveReservationFinalForId, cancelReservationForId } = await import("../src/lib/reservationEdits");
const { createManualBooking } = await import("../src/lib/manualBooking");
const { evaluateCustomerCredit } = await import("../src/lib/creditPolicy");

const prisma = new PrismaClient();
const PREFIX = `TEST-SUITE-RC-${Date.now()}`;

let siteId: string;
let otherSiteId: string;
let plantId: string;
let cementMaterialId: string;
let siloId: string;
let mixId: string;
let otherMixId: string;
let adminUserId: string;

const customerIds: string[] = [];
const projectIds: string[] = [];
const reservationIds: string[] = [];
const invoiceIds: string[] = [];

before(async () => {
  siteId = (await prisma.site.create({ data: { code: `${PREFIX}-A`, name: `${PREFIX}-SITE-A`, city: "Test", country: "Test" } })).id;
  otherSiteId = (await prisma.site.create({ data: { code: `${PREFIX}-B`, name: `${PREFIX}-SITE-B`, city: "Test", country: "Test" } })).id;
  plantId = (await prisma.plant.create({ data: { siteId, name: `${PREFIX}-PLANT` } })).id;
  cementMaterialId = (await prisma.material.create({ data: { name: `${PREFIX}-CEMENT`, type: "CEMENT" } })).id;
  siloId = (
    await prisma.silo.create({
      data: { plantId, name: `${PREFIX}-SILO`, materialType: "CEMENT", materialId: cementMaterialId, capacityTons: 500, currentLevelTons: 200, minThresholdPct: 15 },
    })
  ).id;
  mixId = (
    await prisma.mixDesign.create({
      data: { code: `${PREFIX}-MIX`, grade: "C25", slumpTargetMm: 100, wcRatio: 0.5, status: "APPROVED", components: { create: [{ materialId: cementMaterialId, designMassKgPerM3: 300 }] } },
    })
  ).id;
  otherMixId = (
    await prisma.mixDesign.create({
      data: { code: `${PREFIX}-MIX-2`, grade: "C30", slumpTargetMm: 100, wcRatio: 0.45, status: "APPROVED", components: { create: [{ materialId: cementMaterialId, designMassKgPerM3: 350 }] } },
    })
  ).id;
  adminUserId = (await prisma.user.create({ data: { email: `${PREFIX.toLowerCase()}-admin@example.invalid`, name: `${PREFIX}-ADMIN`, passwordHash: "not-a-real-hash", role: "ADMIN" } })).id;
});

after(async () => {
  const tickets = await prisma.batchTicket.findMany({ where: { reservationId: { in: reservationIds } }, select: { id: true } });
  const ticketIds = tickets.map((t) => t.id);
  if (ticketIds.length > 0) {
    await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: { in: ticketIds } } });
    await prisma.batchTicket.deleteMany({ where: { id: { in: ticketIds } } });
  }
  await prisma.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
  await prisma.priceListEntry.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.mixDesign.deleteMany({ where: { id: { in: [mixId, otherMixId] } } });
  await prisma.silo.delete({ where: { id: siloId } });
  await prisma.material.delete({ where: { id: cementMaterialId } });
  await prisma.plant.delete({ where: { id: plantId } });
  await prisma.site.deleteMany({ where: { id: { in: [siteId, otherSiteId] } } });
  // AuditEvent is append-only at the database; the test-only bypass the
  // other suites use removes this suite's own rows, by actor.
  await prisma.$transaction([prisma.$executeRaw`SET LOCAL app.bypass_audit_event_immutability = 'on'`, prisma.auditEvent.deleteMany({ where: { actorId: adminUserId } })]);
  await prisma.user.delete({ where: { id: adminUserId } });

  const residue = await Promise.all([
    prisma.reservation.count({ where: { reservationNumber: { startsWith: PREFIX } } }),
    prisma.customer.count({ where: { legalName: { startsWith: PREFIX } } }),
    prisma.site.count({ where: { name: { startsWith: PREFIX } } }),
    prisma.invoice.count({ where: { invoiceNumber: { startsWith: PREFIX } } }),
    prisma.user.count({ where: { name: { startsWith: PREFIX } } }),
  ]);
  assert.deepEqual(residue, [0, 0, 0, 0, 0], `leftover ${PREFIX} fixtures: [reservation, customer, site, invoice, user] = ${JSON.stringify(residue)}`);
  await prisma.$disconnect();
});

function actor(allowedSiteId: string | null = siteId) {
  return { id: adminUserId, role: "ADMIN", allowedSiteId };
}

async function makeCustomer(creditLimit: number) {
  const customer = await prisma.customer.create({ data: { legalName: `${PREFIX}-CUST-${customerIds.length}`, creditLimit } });
  customerIds.push(customer.id);
  const project = await prisma.project.create({ data: { name: `${PREFIX}-PROJ-${projectIds.length}`, customerId: customer.id, siteAddress: "Test" } });
  projectIds.push(project.id);
  for (const m of [mixId, otherMixId]) {
    await prisma.priceListEntry.create({ data: { customerId: customer.id, mixId: m, pricePerM3: 100 } });
  }
  return { customerId: customer.id, projectId: project.id };
}

async function makeReservation(projectId: string, data: Partial<{ status: string; approved: boolean; requestedVolumeM3: number }> = {}) {
  const now = new Date();
  const approved = data.approved ?? true;
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `${PREFIX}-RES-${reservationIds.length}`,
      projectId,
      siteId,
      mixId,
      requestedVolumeM3: data.requestedVolumeM3 ?? 20,
      originalVolumeM3: data.requestedVolumeM3 ?? 20,
      pourWindowStart: now,
      status: data.status ?? "CONFIRMED",
      ...(approved ? { initialApprovedAt: now, initialApprovedById: adminUserId, finalApprovedAt: now, finalApprovedById: adminUserId } : {}),
    },
  });
  reservationIds.push(reservation.id);
  return reservation;
}

// An issued (SENT) invoice is a receivable the credit policy counts.
async function issueInvoice(customerId: string, total: number) {
  const invoice = await prisma.invoice.create({
    data: { invoiceNumber: `${PREFIX}-INV-${invoiceIds.length}`, customerId, dueDate: new Date(), subtotal: total, total, status: "SENT" },
  });
  invoiceIds.push(invoice.id);
  return invoice;
}

function editInput(reservation: { projectId: string; siteId: string; mixId: string; requestedVolumeM3: number; pourWindowStart: Date }, overrides: Partial<{ status: string; mixId: string; siteId: string; requestedVolumeM3: number }> = {}) {
  return {
    projectId: reservation.projectId,
    siteId: overrides.siteId ?? reservation.siteId,
    mixId: overrides.mixId ?? reservation.mixId,
    requestedVolumeM3: overrides.requestedVolumeM3 ?? reservation.requestedVolumeM3,
    pourWindowStart: reservation.pourWindowStart,
    status: overrides.status,
    pourDetails: {},
  };
}

async function ticketsFor(reservationId: string) {
  return prisma.batchTicket.count({ where: { reservationId } });
}

// ---- The credit decision itself ---------------------------------------

test("the credit policy counts issued receivables against the limit in minor units, and 'at the limit' holds", async () => {
  const { customerId } = await makeCustomer(100);
  assert.equal((await evaluateCustomerCredit(prisma, customerId))?.status, "WITHIN_LIMIT");
  await issueInvoice(customerId, 99.99);
  assert.equal((await evaluateCustomerCredit(prisma, customerId))?.status, "WITHIN_LIMIT", "one halala under the limit is within it");
  await issueInvoice(customerId, 0.01);
  const decision = await evaluateCustomerCredit(prisma, customerId);
  assert.deepEqual(decision, { status: "OVER_LIMIT", outstandingMinor: 10000, limitMinor: 10000 }, "exactly at the limit holds");
});

// ---- 1. The edit form can no longer set an arbitrary status -------------

test("a crafted ON_HOLD -> CONFIRMED edit is refused and the reservation stays on hold", async () => {
  const { projectId } = await makeCustomer(0);
  const held = await makeReservation(projectId, { status: "ON_HOLD", approved: false });
  const result = await updateReservationForId(held.id, editInput(held, { status: "CONFIRMED" }), actor());
  assert.equal(result.status, "STATUS_NOT_ALLOWED");
  const after = await prisma.reservation.findUniqueOrThrow({ where: { id: held.id } });
  assert.equal(after.status, "ON_HOLD");
  assert.equal(after.finalApprovedAt, null);
});

test("the edit form cannot move a reservation to DELIVERED, CANCELLED, IN_PRODUCTION or an unknown status", async () => {
  const { projectId } = await makeCustomer(999999);
  const reservation = await makeReservation(projectId);
  for (const status of ["DELIVERED", "CANCELLED", "IN_PRODUCTION", "REQUESTED", "TEST-SUITE-RC-MADE-UP"]) {
    const result = await updateReservationForId(reservation.id, editInput(reservation, { status }), actor());
    assert.equal(result.status, "STATUS_NOT_ALLOWED", `${status} must not be settable from the edit form`);
  }
  assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status, "CONFIRMED");
});

test("allowed edits still work: detail changes, and placing a hold, which withdraws final approval", async () => {
  const { projectId } = await makeCustomer(999999);
  const reservation = await makeReservation(projectId);

  // Same status, changed details: saved.
  assert.equal((await updateReservationForId(reservation.id, editInput(reservation, { status: "CONFIRMED" }), actor())).status, "OK");
  // A volume change invalidates both approvals, as before.
  assert.equal((await updateReservationForId(reservation.id, editInput(reservation, { requestedVolumeM3: 25 }), actor())).status, "OK");
  let row = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
  assert.equal(row.requestedVolumeM3, 25);
  assert.equal(row.initialApprovedAt, null);
  assert.equal(row.finalApprovedAt, null);

  // Placing a hold on an approved reservation withdraws the final approval only.
  const second = await makeReservation(projectId);
  assert.equal((await updateReservationForId(second.id, editInput(second, { status: "ON_HOLD" }), actor())).status, "OK");
  row = await prisma.reservation.findUniqueOrThrow({ where: { id: second.id } });
  assert.equal(row.status, "ON_HOLD");
  assert.notEqual(row.initialApprovedAt, null);
  assert.equal(row.finalApprovedAt, null, "a hold can only be lifted through final approval");

  // ...and final approval lifts it, within the limit.
  assert.equal((await approveReservationFinalForId(second.id, actor())).status, "OK");
  row = await prisma.reservation.findUniqueOrThrow({ where: { id: second.id } });
  assert.equal(row.status, "CONFIRMED");
  assert.notEqual(row.finalApprovedAt, null);
});

test("final approval refuses a customer at or over the limit and leaves the hold in place", async () => {
  const { customerId, projectId } = await makeCustomer(500);
  await issueInvoice(customerId, 500);
  const held = await makeReservation(projectId, { status: "ON_HOLD", approved: false });
  await prisma.reservation.update({ where: { id: held.id }, data: { initialApprovedAt: new Date(), initialApprovedById: adminUserId } });

  assert.equal((await approveReservationFinalForId(held.id, actor())).status, "CREDIT_HOLD");
  const row = await prisma.reservation.findUniqueOrThrow({ where: { id: held.id } });
  assert.equal(row.status, "ON_HOLD");
  assert.equal(row.finalApprovedAt, null);
});

// ---- 2. Walk-in manual booking ------------------------------------------

test("a manual booking for a customer over the limit is kept ON_HOLD with no ticket, and says so", async () => {
  const { projectId } = await makeCustomer(0);
  const result = await createManualBooking({ projectId, siteId, plantId, mixId, volumeM3: 4 }, actor());
  assert.equal(result.status, "HELD_FOR_CREDIT");
  if (result.status !== "HELD_FOR_CREDIT") throw new Error("unreachable");
  reservationIds.push(result.reservationId);
  const row = await prisma.reservation.findUniqueOrThrow({ where: { id: result.reservationId } });
  assert.equal(row.status, "ON_HOLD");
  assert.equal(row.finalApprovedAt, null, "a held walk-in is not self-approved past its hold");
  assert.equal(await ticketsFor(result.reservationId), 0, "nothing is released for a held booking");
  assert.equal(await prisma.auditEvent.count({ where: { recordId: result.reservationId, reasonCode: "MANUAL_BOOKING_CREDIT_HOLD" } }), 1);
});

test("a manual booking within the limit is confirmed and released, as before", async () => {
  const { projectId } = await makeCustomer(999999);
  const result = await createManualBooking({ projectId, siteId, plantId, mixId, volumeM3: 4 }, actor());
  assert.equal(result.status, "RELEASED");
  if (result.status !== "RELEASED") throw new Error("unreachable");
  reservationIds.push(result.reservationId);
  assert.equal(await ticketsFor(result.reservationId), 1);
  assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: result.reservationId } })).status, "IN_PRODUCTION");
});

// ---- 3. Release re-decides credit ---------------------------------------

test("a customer who goes over the limit after approval cannot be released against, until a payment brings them back", async () => {
  const { customerId, projectId } = await makeCustomer(1000);
  const reservation = await makeReservation(projectId);

  // Approved and CONFIRMED while within the limit; then an invoice takes
  // the customer to it.
  const invoice = await issueInvoice(customerId, 1000);
  const refused = await releaseTicketForReservation(reservation.id, 5, plantId, actor());
  assert.equal(refused.status, "CREDIT_HOLD", "old approvals must not carry a release past a credit limit reached since");
  assert.equal(await ticketsFor(reservation.id), 0);
  assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status, "CONFIRMED", "the refusal changes nothing");

  // A payment brings the balance under the limit: release works again.
  await prisma.payment.create({ data: { invoiceId: invoice.id, amount: 1 } });
  const released = await releaseTicketForReservation(reservation.id, 5, plantId, actor());
  assert.equal(released.status, "OK");
});

// ---- 4. Edit vs. release: the lock and the re-check ---------------------

async function waitUntilBlockedOnReservationLock(timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE '%"Reservation"%FOR UPDATE%' AND pid <> pg_backend_pid()
    `;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the edit to block on the Reservation row lock");
}

test("an edit waiting on a release sees the released ticket after the lock, and refuses to change the mix", async () => {
  const { projectId } = await makeCustomer(999999);
  const reservation = await makeReservation(projectId);

  let holderHasLock: () => void;
  const lockTaken = new Promise<void>((resolve) => (holderHasLock = resolve));
  let letHolderCommit: () => void;
  const commitGate = new Promise<void>((resolve) => (letHolderCommit = resolve));

  // Stands in for releaseTicketForReservation: the same row lock, then a
  // ticket, paused before commit so the edit is genuinely waiting.
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Reservation" WHERE "id" = ${reservation.id} FOR UPDATE`;
      await tx.batchTicket.create({ data: { reservationId: reservation.id, mixId, plantId, ticketNumber: `${PREFIX}-BT-RACE`, volumeM3: 5, status: "RELEASED" } });
      holderHasLock();
      await commitGate;
    },
    { timeout: 20000 },
  );

  try {
    await lockTaken;
    let settled = false;
    const edit = updateReservationForId(reservation.id, editInput(reservation, { mixId: otherMixId }), actor()).then((r) => {
      settled = true;
      return r;
    });
    await waitUntilBlockedOnReservationLock();
    assert.equal(settled, false, "the edit must wait for the release to finish");
    letHolderCommit!();
    await holder;

    assert.equal((await edit).status, "FROZEN_AFTER_RELEASE", "re-checked after the lock: a ticket now exists, so the mix is frozen");
    assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).mixId, mixId);
  } finally {
    letHolderCommit!();
    await holder.catch(() => undefined);
  }

  // The volume floor is enforced from the same fresh read.
  assert.equal((await updateReservationForId(reservation.id, editInput(reservation, { requestedVolumeM3: 4 }), actor())).status, "BELOW_RELEASED");
});

// ---- 5. Cancel ------------------------------------------------------------

test("cancel works with nothing released, and is refused once something has been", async () => {
  const { projectId } = await makeCustomer(999999);
  const fresh = await makeReservation(projectId);
  assert.equal((await cancelReservationForId(fresh.id, actor())).status, "OK");
  assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: fresh.id } })).status, "CANCELLED");
  assert.equal((await updateReservationForId(fresh.id, editInput(fresh), actor())).status, "TERMINAL", "a cancelled reservation cannot be edited");

  const released = await makeReservation(projectId);
  assert.equal((await releaseTicketForReservation(released.id, 5, plantId, actor())).status, "OK");
  assert.equal((await cancelReservationForId(released.id, actor())).status, "HAS_RELEASED_VOLUME");
  assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: released.id } })).status, "IN_PRODUCTION");
});

// ---- 6. Another site ------------------------------------------------------

test("edit, cancel and final approval from another site's scope are indistinguishable from a missing reservation, and change nothing", async () => {
  const { projectId } = await makeCustomer(999999);
  const reservation = await makeReservation(projectId);
  const held = await makeReservation(projectId, { status: "ON_HOLD", approved: false });
  await prisma.reservation.update({ where: { id: held.id }, data: { initialApprovedAt: new Date(), initialApprovedById: adminUserId } });
  const foreign = actor(otherSiteId);

  assert.equal((await updateReservationForId(reservation.id, editInput(reservation, { requestedVolumeM3: 30 }), foreign)).status, "NOT_FOUND");
  assert.equal((await cancelReservationForId(reservation.id, foreign)).status, "NOT_FOUND");
  assert.equal((await approveReservationFinalForId(held.id, foreign)).status, "NOT_FOUND");
  assert.equal((await updateReservationForId(`${PREFIX}-DOES-NOT-EXIST`, editInput(reservation), foreign)).status, "NOT_FOUND", "the same answer as an id that does not exist");

  // Moving a reservation INTO a site outside the actor's scope is refused too.
  assert.equal((await updateReservationForId(reservation.id, editInput(reservation, { siteId: otherSiteId }), actor())).status, "NOT_FOUND");

  const row = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
  assert.equal(row.requestedVolumeM3, 20);
  assert.equal(row.status, "CONFIRMED");
  assert.equal(row.siteId, siteId);
  assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: held.id } })).status, "ON_HOLD");
});

// ---- Customer.creditLimit CHECK -------------------------------------------

test("the database refuses a negative, infinite or NaN credit limit", async () => {
  for (const creditLimit of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
    await assert.rejects(
      () => prisma.customer.create({ data: { legalName: `${PREFIX}-BAD-LIMIT`, creditLimit } }),
      `creditLimit ${creditLimit} must be rejected by Customer_creditLimit_check`,
    );
  }
  assert.equal(await prisma.customer.count({ where: { legalName: `${PREFIX}-BAD-LIMIT` } }), 0);
});
