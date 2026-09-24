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
const { requestCreditLimitIncrease, decideCreditLimitRequest } = await import("../src/lib/creditLimitRequests");

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
let secondAdminId: string;
let accountantId: string;
let operatorId: string;

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
  secondAdminId = (await prisma.user.create({ data: { email: `${PREFIX.toLowerCase()}-admin2@example.invalid`, name: `${PREFIX}-ADMIN-2`, passwordHash: "not-a-real-hash", role: "ADMIN" } })).id;
  accountantId = (await prisma.user.create({ data: { email: `${PREFIX.toLowerCase()}-acct@example.invalid`, name: `${PREFIX}-ACCOUNTANT`, passwordHash: "not-a-real-hash", role: "ACCOUNTANT" } })).id;
  operatorId = (await prisma.user.create({ data: { email: `${PREFIX.toLowerCase()}-op@example.invalid`, name: `${PREFIX}-OPERATOR`, passwordHash: "not-a-real-hash", role: "PLANT_OPERATOR" } })).id;
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
  await prisma.customerCreditLimitRequest.deleteMany({ where: { customerId: { in: customerIds } } });
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
  const users = [adminUserId, secondAdminId, accountantId, operatorId];
  await prisma.$transaction([prisma.$executeRaw`SET LOCAL app.bypass_audit_event_immutability = 'on'`, prisma.auditEvent.deleteMany({ where: { actorId: { in: users } } })]);
  await prisma.user.deleteMany({ where: { id: { in: users } } });

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

// ---- Credit limit increases: request, decision, and the gate end to end --
// Customer.creditLimit used to be a field on the ordinary customer form,
// writable by every role with customers.updateCustomer. It is now raised
// only by a request approved by a different, company-wide actor holding
// the approve permission at the moment of the decision.

const companyWide = (id: string, role: string) => ({ id, role, allowedSiteId: null as string | null });

async function withActionRoles(actionKey: string, roles: string[], fn: () => Promise<void>) {
  // ActionPermission rows replace the compiled default for this action for
  // as long as they exist; removed afterwards so the default applies again.
  await prisma.actionPermission.deleteMany({ where: { moduleKey: "customers", actionKey } });
  await prisma.actionPermission.createMany({ data: roles.map((role) => ({ moduleKey: "customers", actionKey, role })) });
  try {
    await fn();
  } finally {
    await prisma.actionPermission.deleteMany({ where: { moduleKey: "customers", actionKey } });
  }
}

async function limitOf(customerId: string) {
  return (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).creditLimit;
}

const REASON = "Annual contract signed with a bank guarantee";

test("only permitted roles can request, approve or reject, and a site-scoped actor can never decide", async () => {
  const { customerId } = await makeCustomer(0);
  assert.equal((await requestCreditLimitIncrease(customerId, { proposedLimit: "5000", reason: REASON }, { id: operatorId, role: "PLANT_OPERATOR", allowedSiteId: siteId })).status, "FORBIDDEN");

  const requested = await requestCreditLimitIncrease(customerId, { proposedLimit: "5000", reason: REASON }, { id: accountantId, role: "ACCOUNTANT", allowedSiteId: siteId });
  assert.equal(requested.status, "OK", "a request authorizes nothing, so finance may make one from a plant");
  if (requested.status !== "OK") throw new Error("unreachable");

  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(operatorId, "PLANT_OPERATOR"))).status, "FORBIDDEN");
  assert.equal((await decideCreditLimitRequest(requested.requestId, "REJECT", "no", companyWide(operatorId, "PLANT_OPERATOR"))).status, "FORBIDDEN");
  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(accountantId, "ACCOUNTANT"))).status, "FORBIDDEN", "the requester's role does not decide by default");

  // Even when the permissions screen grants ACCOUNTANT the decision, a
  // plant-pinned account cannot decide a company-wide limit.
  await withActionRoles("approveCreditLimitIncrease", ["ACCOUNTANT", "ADMIN"], async () => {
    const otherAccountant = await prisma.user.create({ data: { email: `${PREFIX.toLowerCase()}-acct2@example.invalid`, name: `${PREFIX}-ACCOUNTANT-2`, passwordHash: "x", role: "ACCOUNTANT" } });
    try {
      assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", { id: otherAccountant.id, role: "ACCOUNTANT", allowedSiteId: siteId })).status, "FORBIDDEN");
    } finally {
      await prisma.user.delete({ where: { id: otherAccountant.id } });
    }
  });

  assert.equal(await limitOf(customerId), 0, "nothing above changed the limit");
  assert.equal((await prisma.customerCreditLimitRequest.findUniqueOrThrow({ where: { id: requested.requestId } })).status, "PENDING");
});

test("a requester cannot decide their own request, even holding every permission", async () => {
  const { customerId } = await makeCustomer(0);
  const requested = await requestCreditLimitIncrease(customerId, { proposedLimit: "7000", reason: REASON }, companyWide(adminUserId, "ADMIN"));
  if (requested.status !== "OK") throw new Error(`request refused: ${requested.status}`);
  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(adminUserId, "ADMIN"))).status, "SELF_DECISION");
  assert.equal((await decideCreditLimitRequest(requested.requestId, "REJECT", "changed my mind", companyWide(adminUserId, "ADMIN"))).status, "SELF_DECISION");
  assert.equal(await limitOf(customerId), 0);

  // The database refuses the same thing if the application ever didn't.
  await assert.rejects(() =>
    prisma.customerCreditLimitRequest.update({ where: { id: requested.requestId }, data: { status: "APPROVED", decidedById: adminUserId, decidedAt: new Date() } }),
  );
});

test("revoking the approve permission while a request is pending stops its approval", async () => {
  const { customerId } = await makeCustomer(0);
  const requested = await requestCreditLimitIncrease(customerId, { proposedLimit: "3000", reason: REASON }, companyWide(accountantId, "ACCOUNTANT"));
  if (requested.status !== "OK") throw new Error(`request refused: ${requested.status}`);
  await withActionRoles("approveCreditLimitIncrease", ["QUALITY_SUPERVISOR"], async () => {
    assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(adminUserId, "ADMIN"))).status, "FORBIDDEN");
  });
  assert.equal(await limitOf(customerId), 0);
  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(adminUserId, "ADMIN"))).status, "APPROVED", "with the permission restored it goes through");
  assert.equal(await limitOf(customerId), 3000);
});

test("invalid, equal and lower proposals are refused; a valid amount is stored exactly in minor units", async () => {
  const { customerId } = await makeCustomer(1000);
  const actor = companyWide(accountantId, "ACCOUNTANT");
  for (const proposedLimit of ["-1", "Infinity", "NaN", "1e5", "100.005", "99999999999999999999", "abc", "", "1,500"]) {
    const result = await requestCreditLimitIncrease(customerId, { proposedLimit, reason: REASON }, actor);
    assert.equal(result.status, "INVALID_AMOUNT", `"${proposedLimit}" must be refused`);
  }
  assert.equal((await requestCreditLimitIncrease(customerId, { proposedLimit: "1000", reason: REASON }, actor)).status, "NOT_AN_INCREASE");
  assert.equal((await requestCreditLimitIncrease(customerId, { proposedLimit: "999.99", reason: REASON }, actor)).status, "NOT_AN_INCREASE");
  assert.equal((await requestCreditLimitIncrease(customerId, { proposedLimit: "2000", reason: "short" }, actor)).status, "REASON_REQUIRED");
  assert.equal(await prisma.customerCreditLimitRequest.count({ where: { customerId } }), 0);

  const ok = await requestCreditLimitIncrease(customerId, { proposedLimit: "2500.50", reason: REASON }, actor);
  if (ok.status !== "OK") throw new Error(`request refused: ${ok.status}`);
  const row = await prisma.customerCreditLimitRequest.findUniqueOrThrow({ where: { id: ok.requestId } });
  assert.equal(row.previousLimitMinor, BigInt(100000));
  assert.equal(row.proposedLimitMinor, BigInt(250050));
  assert.equal(await limitOf(customerId), 1000, "a pending request changes nothing");
  assert.equal((await evaluateCustomerCredit(prisma, customerId))?.limitMinor, 100000, "and the credit policy never reads it");
});

test("approval applies once; replays, rejection, a second proposal and concurrent decisions are deterministic", async () => {
  const { customerId } = await makeCustomer(0);
  const actor = companyWide(accountantId, "ACCOUNTANT");
  const first = await requestCreditLimitIncrease(customerId, { proposedLimit: "4000", reason: REASON }, actor);
  if (first.status !== "OK") throw new Error(`request refused: ${first.status}`);
  assert.equal((await requestCreditLimitIncrease(customerId, { proposedLimit: "9000", reason: REASON }, actor)).status, "ALREADY_PENDING");

  // Two approvers at once: exactly one applies.
  const decisions = await Promise.all([
    decideCreditLimitRequest(first.requestId, "APPROVE", "", companyWide(adminUserId, "ADMIN")),
    decideCreditLimitRequest(first.requestId, "APPROVE", "", companyWide(secondAdminId, "ADMIN")),
  ]);
  assert.deepEqual(decisions.map((d) => d.status).sort(), ["APPROVED", "NOT_PENDING"]);
  assert.equal(await limitOf(customerId), 4000);
  assert.equal(await prisma.auditEvent.count({ where: { recordId: customerId, reasonCode: "CREDIT_LIMIT_INCREASE_APPROVED" } }), 1);
  assert.equal((await decideCreditLimitRequest(first.requestId, "APPROVE", "", companyWide(secondAdminId, "ADMIN"))).status, "NOT_PENDING", "a replay does nothing");

  // A rejection needs a note and changes no limit.
  const second = await requestCreditLimitIncrease(customerId, { proposedLimit: "8000", reason: REASON }, actor);
  if (second.status !== "OK") throw new Error(`request refused: ${second.status}`);
  assert.equal((await decideCreditLimitRequest(second.requestId, "REJECT", "  ", companyWide(adminUserId, "ADMIN"))).status, "NOTE_REQUIRED");
  assert.equal((await decideCreditLimitRequest(second.requestId, "REJECT", "Payment history too short", companyWide(adminUserId, "ADMIN"))).status, "REJECTED");
  assert.equal(await limitOf(customerId), 4000);

  // Two requests racing: one is recorded, the other is told one is pending.
  const racing = await Promise.all([
    requestCreditLimitIncrease(customerId, { proposedLimit: "5000", reason: REASON }, actor),
    requestCreditLimitIncrease(customerId, { proposedLimit: "6000", reason: REASON }, companyWide(adminUserId, "ADMIN")),
  ]);
  assert.deepEqual(racing.map((r) => r.status).sort(), ["ALREADY_PENDING", "OK"]);
  assert.equal(await prisma.customerCreditLimitRequest.count({ where: { customerId, status: "PENDING" } }), 1);
});

test("a request made against a limit that has since changed goes stale instead of being applied", async () => {
  const { customerId } = await makeCustomer(1000);
  const requested = await requestCreditLimitIncrease(customerId, { proposedLimit: "5000", reason: REASON }, companyWide(accountantId, "ACCOUNTANT"));
  if (requested.status !== "OK") throw new Error(`request refused: ${requested.status}`);
  // The limit changes underneath it (an out-of-band correction).
  await prisma.customer.update({ where: { id: customerId }, data: { creditLimit: 1500 } });

  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(adminUserId, "ADMIN"))).status, "STALE");
  assert.equal(await limitOf(customerId), 1500, "a stale request is never applied");
  assert.equal((await prisma.customerCreditLimitRequest.findUniqueOrThrow({ where: { id: requested.requestId } })).status, "STALE");
  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(adminUserId, "ADMIN"))).status, "NOT_PENDING");
  assert.equal((await requestCreditLimitIncrease(customerId, { proposedLimit: "5000", reason: REASON }, companyWide(accountantId, "ACCOUNTANT"))).status, "OK", "a fresh request against the current limit is accepted");
});

test("a failed audit insert at approval rolls back both the request and the limit; the retry records one full audit row", async () => {
  const { customerId } = await makeCustomer(0);
  const requested = await requestCreditLimitIncrease(customerId, { proposedLimit: "12000", reason: REASON }, companyWide(accountantId, "ACCOUNTANT"));
  if (requested.status !== "OK") throw new Error(`request refused: ${requested.status}`);

  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_rc_reject_limit_audit() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."reasonCode" = 'CREDIT_LIMIT_INCREASE_APPROVED' THEN
        RAISE EXCEPTION 'injected audit failure';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER test_rc_reject_limit_audit_trigger BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_rc_reject_limit_audit();`);
  try {
    await assert.rejects(() => decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(adminUserId, "ADMIN")));
    assert.equal(await limitOf(customerId), 0, "the limit must not change without its audit row");
    assert.equal((await prisma.customerCreditLimitRequest.findUniqueOrThrow({ where: { id: requested.requestId } })).status, "PENDING");
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_rc_reject_limit_audit_trigger ON "AuditEvent";`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_rc_reject_limit_audit();`);
  }

  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "Guarantee received", companyWide(adminUserId, "ADMIN"))).status, "APPROVED");
  const audits = await prisma.auditEvent.findMany({ where: { recordId: customerId, reasonCode: "CREDIT_LIMIT_INCREASE_APPROVED" } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, adminUserId);
  assert.equal(audits[0].beforeValue, "0.00");
  assert.match(audits[0].afterValue ?? "", /^12000\.00 /);
  assert.ok(audits[0].afterValue?.includes(requested.requestId) && audits[0].afterValue?.includes(accountantId), "the audit names the request and the requester");
});

test("end to end: limit 0 holds, a separately approved increase lets final approval and release through, and reaching the new limit holds again", async () => {
  const { customerId, projectId } = await makeCustomer(0);
  assert.equal((await evaluateCustomerCredit(prisma, customerId))?.status, "OVER_LIMIT", "limit 0 with a zero balance holds");

  const held = await makeReservation(projectId, { status: "ON_HOLD", approved: false });
  await prisma.reservation.update({ where: { id: held.id }, data: { initialApprovedAt: new Date(), initialApprovedById: adminUserId } });
  assert.equal((await approveReservationFinalForId(held.id, actor())).status, "CREDIT_HOLD");
  const confirmedEarlier = await makeReservation(projectId);
  assert.equal((await releaseTicketForReservation(confirmedEarlier.id, 5, plantId, actor())).status, "CREDIT_HOLD", "an older CONFIRMED booking is rechecked at release");

  const requested = await requestCreditLimitIncrease(customerId, { proposedLimit: "1000", reason: REASON }, companyWide(accountantId, "ACCOUNTANT"));
  if (requested.status !== "OK") throw new Error(`request refused: ${requested.status}`);
  assert.equal((await approveReservationFinalForId(held.id, actor())).status, "CREDIT_HOLD", "a pending request lifts nothing");

  assert.equal((await decideCreditLimitRequest(requested.requestId, "APPROVE", "", companyWide(secondAdminId, "ADMIN"))).status, "APPROVED");
  assert.equal((await approveReservationFinalForId(held.id, actor())).status, "OK");
  assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: held.id } })).status, "CONFIRMED");
  assert.equal((await releaseTicketForReservation(confirmedEarlier.id, 5, plantId, actor())).status, "OK");

  // Receivables reaching the raised limit hold again.
  await issueInvoice(customerId, 1000);
  assert.equal((await releaseTicketForReservation(held.id, 5, plantId, actor())).status, "CREDIT_HOLD");
});
