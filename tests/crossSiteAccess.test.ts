// BL-CR-P1-01, external-review validation (2026-09-10): cross-site READ
// authorization, proved against the real page components and a real
// PostgreSQL database.
//
// Every page here authorizes the MODULE through requirePageAccess and
// then loads a record by the route parameter. The route parameter is not
// an authorization boundary: without the site predicate in the query
// itself, any user with module permission could read another site's
// delivery note, quotation or purchase order by knowing (or guessing) an
// id. These tests call the page functions the way the router does — the
// real default export, the real Prisma access, the real session cookie —
// and assert that an out-of-scope id is indistinguishable from a
// nonexistent one (notFound), while the SAME fixture is still fully
// readable by a user of its own site and by ADMIN.
//
// Testing the page function rather than a paraphrase of its query is
// deliberate: a test that re-implements the predicate proves only that
// the test agrees with itself (the lesson of the fifteenth
// production-lifecycle review's PL-R15-P2-01).
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

// Same request-adapter stubs review.integration.test.ts uses: only Next's
// cookie/cache plumbing is replaced, never the application code under
// test. getDictionary reads the locale cookie through this same map.
const cookieValues = new Map<string, string>();
require("next/headers");
require.cache[require.resolve("next/headers")]!.exports = {
  cookies: async () => ({
    get: (name: string) => (cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined),
    set: (name: string, value: string) => cookieValues.set(name, value),
    delete: (name: string) => cookieValues.delete(name),
  }),
  headers: async () => new Headers(),
};
require("next/cache");
require.cache[require.resolve("next/cache")]!.exports = { revalidatePath: () => {} };

const { prisma } = await import("../src/lib/prisma");
const { createSessionToken, hashSessionToken } = await import("../src/lib/sessionToken");
const DeliveryNotePage = (await import("../src/app/(app)/production/[id]/delivery-note/page")).default;
const DeliveryNoteSupplementPage = (await import("../src/app/(app)/production/[id]/delivery-note/supplement/page")).default;
const PurchaseOrderDetailPage = (await import("../src/app/(app)/purchasing/orders/[id]/page")).default;
const QuoteDetailPage = (await import("../src/app/(app)/sales/quotes/[id]/page")).default;
const CustomerStatementPage = (await import("../src/app/(app)/finance/customers/[id]/statement/page")).default;
const sales = await import("../src/app/(app)/sales/actions");
const finance = await import("../src/app/(app)/finance/actions");
const plants = await import("../src/app/(app)/plants/actions");
const reservations = await import("../src/app/(app)/reservations/actions");
const production = await import("../src/app/(app)/production/actions");

const prefix = `TEST-SUITE-XS-${randomUUID().slice(0, 8)}`;

// Site A is the reader's own site; site B is the one whose records must
// stay invisible. Every fixture below exists in BOTH, so each assertion
// has a positive control: the same page, the same role, the same shape of
// record — only the site differs.
let siteA: string, siteB: string, plantA: string, plantB: string;
let operatorId: string, salesId: string, accountantId: string, adminId: string;
let salesManagerId: string, salesSupervisorId: string;
let supervisorId = "";
let initialAccountIds: string[] = [];
const supplierBillIds: string[] = [];
const fieldVisitIds: string[] = [];
let customerId: string, mixId: string, supplierId: string;
const ticketIds: string[] = [];
const tripIds: string[] = [];
const reservationIds: string[] = [];
const projectIds: string[] = [];
const quoteIds: string[] = [];
const opportunityIds: string[] = [];
const purchaseOrderIds: string[] = [];
const invoiceIds: string[] = [];
const truckIds: string[] = [];
const driverIds: string[] = [];

// BL-CR-P1-05: the cookie now carries a CSPRNG token, and the row stores
// only its SHA-256 — so a fixture session has to be created the same way
// the application creates one, not by putting a row id in the cookie.
async function asUser(userId: string) {
  const token = createSessionToken();
  await prisma.session.create({ data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) } });
  cookieValues.set("batchline_session", token);
}

// A page's own output is a React element tree, already resolved (these
// pages await all their data before returning and contain no nested
// async server components). Collecting every string it would print —
// children AND the defaultValue/value props these printable documents
// render their stored values into — is what lets a test assert that a
// specific record's data is genuinely absent, not merely that no
// exception was thrown.
function renderedText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (typeof node !== "object") return "";
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return "";
  const parts: string[] = [];
  for (const key of ["defaultValue", "value", "title", "alt"]) {
    const v = props[key];
    if (typeof v === "string" || typeof v === "number") parts.push(String(v));
  }
  parts.push(renderedText(props.children));
  return parts.join(" ");
}

// notFound() throws a Next.js control-flow error rather than returning —
// asserting on the rejection is how "this page 404s" is expressed here.
// Deliberately NOT matching on the exact digest string: that is Next
// internals, and a page that threw for some OTHER reason would still be
// refusing to render the record, which is the security property. The
// positive controls below are what prove the page isn't simply broken.
async function assertNotFound(run: () => Promise<unknown>, message: string) {
  await assert.rejects(run, message);
}

before(async () => {
  const a = await prisma.site.create({ data: { code: `${prefix}-A`, name: `${prefix} A`, city: "Test", country: "Test" } });
  const b = await prisma.site.create({ data: { code: `${prefix}-B`, name: `${prefix} B`, city: "Test", country: "Test" } });
  siteA = a.id;
  siteB = b.id;
  plantA = (await prisma.plant.create({ data: { name: `${prefix} A`, siteId: siteA } })).id;
  plantB = (await prisma.plant.create({ data: { name: `${prefix} B`, siteId: siteB } })).id;

  // Every non-admin reader lives at site A. ADMIN's effectiveSiteId is
  // null (unrestricted), which is the other half of the contract: the
  // scope predicate must not lock an administrator out.
  const base = { passwordHash: "test-only", name: prefix, plantId: plantA };
  operatorId = (await prisma.user.create({ data: { ...base, email: `${prefix}-op@example.invalid`, role: "PLANT_OPERATOR" } })).id;
  salesId = (await prisma.user.create({ data: { ...base, email: `${prefix}-sales@example.invalid`, role: "SALES_REP" } })).id;
  accountantId = (await prisma.user.create({ data: { ...base, email: `${prefix}-acct@example.invalid`, role: "ACCOUNTANT" } })).id;
  adminId = (await prisma.user.create({ data: { ...base, email: `${prefix}-admin@example.invalid`, role: "ADMIN" } })).id;

  salesManagerId = (await prisma.user.create({ data: { ...base, email: `${prefix}-sm@example.invalid`, role: "SALES_MANAGER" } })).id;
  salesSupervisorId = (await prisma.user.create({ data: { ...base, email: `${prefix}-ss@example.invalid`, role: "SALES_SUPERVISOR" } })).id;
  initialAccountIds = (await prisma.account.findMany({ select: { id: true } })).map((a) => a.id);
  customerId = (await prisma.customer.create({ data: { legalName: `${prefix}-CUSTOMER` } })).id;
  mixId = (await prisma.mixDesign.create({ data: { code: `${prefix}-MIX`, grade: "C25", slumpTargetMm: 100, wcRatio: 0.5 } })).id;
  supplierId = (await prisma.supplier.create({ data: { name: `${prefix}-SUPPLIER` } })).id;
});

// One dispatched batch ticket, with its whole delivery-note context, at
// the requested site.
async function makeTicket(siteId: string, plantId: string, opts: { qualityRejected?: boolean } = {}) {
  const project = await prisma.project.create({ data: { name: `${prefix}-PROJ`, customerId, siteAddress: "Test Address" } });
  projectIds.push(project.id);
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `${prefix}-RES-${randomUUID().slice(0, 8)}`,
      projectId: project.id,
      siteId,
      mixId,
      requestedVolumeM3: 10,
      originalVolumeM3: 10,
      pourWindowStart: new Date(),
      status: "CONFIRMED",
    },
  });
  reservationIds.push(reservation.id);
  const ticketNumber = `${prefix}-BT-${randomUUID().slice(0, 8)}`;
  const ticket = await prisma.batchTicket.create({
    data: { reservationId: reservation.id, mixId, plantId, ticketNumber, volumeM3: 5, status: "RELEASED" },
  });
  ticketIds.push(ticket.id);
  const truck = await prisma.truck.create({ data: { plantId, code: `${prefix}-TRK-${randomUUID().slice(0, 6)}`, drumCapacityM3: 12 } });
  truckIds.push(truck.id);
  const driver = await prisma.employee.create({ data: { plantId, name: `${prefix}-DRV`, role: "DRIVER", status: "ACTIVE" } });
  driverIds.push(driver.id);
  const trip = await prisma.trip.create({
    data: { batchTicketId: ticket.id, truckId: truck.id, driverId: driver.id, status: "CLOSED", batchTime: new Date() },
  });
  tripIds.push(trip.id);
  if (opts.qualityRejected) {
    await prisma.drumReturn.create({
      data: { tripId: trip.id, returnedVolumeM3: 1, minutesSinceBatch: 30, disposition: "FULL_WASTE", reasonCode: "QUALITY_REJECTED" },
    });
  }
  return { ticketId: ticket.id, ticketNumber };
}

async function makePurchaseOrder(siteId: string) {
  const poNumber = `${prefix}-PO-${randomUUID().slice(0, 8)}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber, supplierId, siteId, currency: "SAR", subtotal: 100, total: 100, createdById: adminId },
  });
  purchaseOrderIds.push(po.id);
  return { id: po.id, poNumber };
}

async function makeQuote(siteId: string) {
  const opportunity = await prisma.opportunity.create({
    data: { opportunityNumber: `${prefix}-OPP-${randomUUID().slice(0, 8)}`, customerId, siteId, ownerId: salesId },
  });
  opportunityIds.push(opportunity.id);
  const quoteNumber = `${prefix}-QT-${randomUUID().slice(0, 8)}`;
  const quote = await prisma.quote.create({
    data: {
      quoteNumber,
      opportunityId: opportunity.id,
      customerId,
      siteId,
      currency: "SAR",
      subtotal: 100,
      total: 100,
      preparedById: salesId,
    },
  });
  quoteIds.push(quote.id);
  return { id: quote.id, quoteNumber };
}

async function makeInvoice(plantId: string) {
  const invoiceNumber = `${prefix}-INV-${randomUUID().slice(0, 8)}`;
  const row = await prisma.invoice.create({
    data: {
      invoiceNumber,
      customerId,
      plantId,
      currency: "SAR",
      subtotal: 100,
      taxAmount: 15,
      taxRatePct: 15,
      total: 115,
      dueDate: new Date(),
      status: "SENT",
    },
  });
  invoiceIds.push(row.id);
  return { id: row.id, invoiceNumber };
}

test("a delivery note from another site is not readable, and the reader's own still is", async () => {
  const mine = await makeTicket(siteA, plantA);
  const theirs = await makeTicket(siteB, plantB);

  await asUser(operatorId);
  await assertNotFound(
    () => DeliveryNotePage({ params: Promise.resolve({ id: theirs.ticketId }) }),
    "a production user must not be able to print another site's delivery note by id",
  );

  const own = await DeliveryNotePage({ params: Promise.resolve({ id: mine.ticketId }) });
  const text = renderedText(own);
  assert.ok(text.includes(mine.ticketNumber), "the reader's own delivery note must still render in full");
  assert.ok(!text.includes(theirs.ticketNumber), "and must carry nothing from the other site");

  // ADMIN is unrestricted: the scope predicate must not lock them out.
  await asUser(adminId);
  const asAdmin = await DeliveryNotePage({ params: Promise.resolve({ id: theirs.ticketId }) });
  assert.ok(renderedText(asAdmin).includes(theirs.ticketNumber), "ADMIN must still reach every site's documents");
});

test("a quality-rejection supplement from another site is not readable", async () => {
  const mine = await makeTicket(siteA, plantA, { qualityRejected: true });
  const theirs = await makeTicket(siteB, plantB, { qualityRejected: true });

  await asUser(operatorId);
  await assertNotFound(
    () => DeliveryNoteSupplementPage({ params: Promise.resolve({ id: theirs.ticketId }) }),
    "a production user must not be able to read another site's rejection supplement",
  );

  const own = await DeliveryNoteSupplementPage({ params: Promise.resolve({ id: mine.ticketId }) });
  assert.ok(renderedText(own).includes(mine.ticketNumber), "the reader's own supplement must still render");
});

test("a purchase order from another site is not readable, and the reader's own still is", async () => {
  const mine = await makePurchaseOrder(siteA);
  const theirs = await makePurchaseOrder(siteB);

  await asUser(operatorId);
  await assertNotFound(
    () => PurchaseOrderDetailPage({ params: Promise.resolve({ id: theirs.id }) }),
    "a purchasing user must not be able to read another site's supplier prices by order id",
  );

  const own = await PurchaseOrderDetailPage({ params: Promise.resolve({ id: mine.id }) });
  const text = renderedText(own);
  assert.ok(text.includes(mine.poNumber), "the reader's own purchase order must still render in full");
  assert.ok(!text.includes(theirs.poNumber));
});

test("a quotation from another site is not readable, and the reader's own still is", async () => {
  const mine = await makeQuote(siteA);
  const theirs = await makeQuote(siteB);

  await asUser(salesId);
  await assertNotFound(
    () => QuoteDetailPage({ params: Promise.resolve({ id: theirs.id }) }),
    "a sales user must not be able to read another site's commercial offer by id",
  );

  const own = await QuoteDetailPage({ params: Promise.resolve({ id: mine.id }) });
  const text = renderedText(own);
  assert.ok(text.includes(mine.quoteNumber), "the reader's own quotation must still render in full");
  assert.ok(!text.includes(theirs.quoteNumber));
});

test("a customer statement shows only the reader's own site's receivables", async () => {
  const mine = await makeInvoice(plantA);
  const theirs = await makeInvoice(plantB);

  await asUser(accountantId);
  const scoped = renderedText(await CustomerStatementPage({ params: Promise.resolve({ id: customerId }), searchParams: Promise.resolve({}) }));
  assert.ok(scoped.includes(mine.invoiceNumber), "the reader's own site's invoice must appear on the statement");
  assert.ok(
    !scoped.includes(theirs.invoiceNumber),
    "another site's invoice number, total and payments must never appear on a shared customer's statement",
  );

  // The customer is shared company-wide, so an unrestricted reader sees
  // the complete ledger — which is also what proves the scoped statement
  // above was filtered rather than simply empty of the other row.
  await asUser(adminId);
  const unscoped = renderedText(await CustomerStatementPage({ params: Promise.resolve({ id: customerId }), searchParams: Promise.resolve({}) }));
  assert.ok(unscoped.includes(mine.invoiceNumber) && unscoped.includes(theirs.invoiceNumber), "ADMIN sees the whole customer ledger");
});

// ===================================================================
// BL-CR-P1-02 — cross-site WRITES.
//
// The read tests above prove another site's records cannot be viewed.
// These prove they cannot be CHANGED either, which is the more damaging
// half: every action below takes an id straight from the form, and every
// one of them used to check only the caller's ROLE. Each test forges the
// request a crafted form would send — site A's authenticated user, site
// B's id — and then asserts on the DATABASE, not on a return value:
// these actions are deliberately silent on refusal (a spoken refusal
// would itself confirm the record exists), so "nothing happened" is the
// only observable, and the paired positive control is what proves the
// action still works at all.
// ===================================================================

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function makeOpportunity(siteId: string, data: Record<string, unknown> = {}) {
  const row = await prisma.opportunity.create({
    data: {
      opportunityNumber: `${prefix}-OPP-${randomUUID().slice(0, 8)}`,
      siteId,
      ownerId: salesId,
      prospectName: `${prefix}-PROSPECT`,
      status: "NEW",
      ...data,
    },
  });
  opportunityIds.push(row.id);
  return row;
}

async function makeSupplierBill(siteId: string, total = 100) {
  const row = await prisma.supplierBill.create({
    data: {
      billNumber: `${prefix}-SB-${randomUUID().slice(0, 8)}`,
      supplierId,
      siteId,
      currency: "SAR",
      subtotal: total,
      total,
      dueDate: new Date(),
      status: "UNPAID",
    },
  });
  supplierBillIds.push(row.id);
  return row;
}

test("a prospect belonging to another site cannot be promoted to a customer", async () => {
  const theirs = await makeOpportunity(siteB);
  const mine = await makeOpportunity(siteA);
  const customersBefore = await prisma.customer.count();

  await asUser(salesId);
  await sales.promoteProspectToCustomer(form({ id: theirs.id }));
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: theirs.id } })).customerId, null, "the other site's opportunity must be untouched");
  assert.equal(await prisma.customer.count(), customersBefore, "and no Customer row may be created from it");

  await sales.promoteProspectToCustomer(form({ id: mine.id }));
  const promoted = await prisma.opportunity.findUniqueOrThrow({ where: { id: mine.id } });
  assert.ok(promoted.customerId, "the caller's own prospect is still promoted normally");
  await prisma.opportunity.update({ where: { id: mine.id }, data: { customerId: null } });
  await prisma.customer.delete({ where: { id: promoted.customerId! } });
});

test("another site's quote cannot be sent, answered or approved", async () => {
  const theirs = await makeQuote(siteB);
  await prisma.quote.update({ where: { id: theirs.id }, data: { finalApprovedAt: new Date(), finalApprovedById: adminId } });

  await asUser(salesId);
  await sales.markQuoteSent(form({ id: theirs.id }));
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: theirs.id } })).status, "DRAFT", "a fully approved quote at another site must not be sent");
  assert.equal(await prisma.priceListEntry.count({ where: { customerId } }), 0, "and no standing price may be written from it");

  await prisma.quote.update({ where: { id: theirs.id }, data: { status: "SENT" } });
  await sales.recordQuoteResponse(form({ id: theirs.id, response: "ACCEPTED" }));
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: theirs.id } })).status, "SENT", "another site's offer must not be accepted on its behalf");

  await prisma.quote.update({ where: { id: theirs.id }, data: { status: "DRAFT", finalApprovedAt: null, finalApprovedById: null } });
  await asUser(salesManagerId);
  await sales.approveInitialStage(form({ recordType: "quote", id: theirs.id }));
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: theirs.id } })).initialApprovedAt, null, "another site's quote must not be approved");
});

test("the same quote is still sendable and approvable inside its own site", async () => {
  const mine = await makeQuote(siteA);

  await asUser(salesManagerId);
  await sales.approveInitialStage(form({ recordType: "quote", id: mine.id }));
  assert.ok((await prisma.quote.findUniqueOrThrow({ where: { id: mine.id } })).initialApprovedAt, "initial approval must still work in scope");

  await prisma.quote.update({ where: { id: mine.id }, data: { finalApprovedAt: new Date(), finalApprovedById: adminId } });
  await asUser(salesId);
  await sales.markQuoteSent(form({ id: mine.id }));
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: mine.id } })).status, "SENT", "sending must still work in scope");

  await sales.recordQuoteResponse(form({ id: mine.id, response: "DECLINED" }));
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: mine.id } })).status, "DECLINED", "recording a response must still work in scope");
  await prisma.priceListEntry.deleteMany({ where: { customerId } });
});

test("another site's opportunity cannot be approved, and a visit cannot be logged against it", async () => {
  const theirs = await makeOpportunity(siteB, { status: "NEW" });

  await asUser(salesSupervisorId);
  await sales.approveInitialStage(form({ recordType: "opportunity", id: theirs.id }));
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: theirs.id } })).initialApprovedAt, null);

  await asUser(salesId);
  const visitsBefore = await prisma.fieldVisit.count();
  await sales.logFieldVisit(form({ opportunityId: theirs.id, notes: `${prefix}-NOTES` }));
  assert.equal(await prisma.fieldVisit.count(), visitsBefore, "a visit must not be filed against another site's opportunity");
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: theirs.id } })).status, "NEW", "and its stage must not be advanced");

  // Positive control: the same call against this caller's own site.
  const mine = await makeOpportunity(siteA, { status: "NEW" });
  await sales.logFieldVisit(form({ opportunityId: mine.id, notes: `${prefix}-NOTES` }));
  const logged = await prisma.fieldVisit.findFirst({ where: { opportunityId: mine.id } });
  assert.ok(logged, "logging a visit on the caller's own opportunity must still work");
  fieldVisitIds.push(logged.id);
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: mine.id } })).status, "SITE_VISIT");

  // A visit inherits its site from the opportunity it belongs to, so the
  // approval chain follows the same boundary.
  const theirVisit = await prisma.fieldVisit.create({
    data: { visitNumber: `${prefix}-FV-${randomUUID().slice(0, 8)}`, opportunityId: theirs.id, visitedById: salesId, notes: `${prefix}-THEIRS` },
  });
  fieldVisitIds.push(theirVisit.id);
  await asUser(salesManagerId);
  await sales.approveFinalStage(form({ recordType: "visit", id: theirVisit.id }));
  assert.equal((await prisma.fieldVisit.findUniqueOrThrow({ where: { id: theirVisit.id } })).finalApprovedAt, null, "a visit on another site's opportunity must not be approved");

  await sales.approveFinalStage(form({ recordType: "visit", id: logged.id }));
  assert.ok((await prisma.fieldVisit.findUniqueOrThrow({ where: { id: logged.id } })).finalApprovedAt, "the caller's own site's visit is still approvable");
});

test("another site's reservation reminder cannot be marked sent", async () => {
  const theirs = await prisma.reservation.create({
    data: {
      reservationNumber: `${prefix}-RES-${randomUUID().slice(0, 8)}`,
      projectId: (await prisma.project.create({ data: { name: `${prefix}-PROJ`, customerId, siteAddress: "Test" } })).id,
      siteId: siteB,
      mixId,
      requestedVolumeM3: 10,
      originalVolumeM3: 10,
      pourWindowStart: new Date(),
      status: "CONFIRMED",
    },
  });
  reservationIds.push(theirs.id);
  projectIds.push(theirs.projectId);

  await asUser(accountantId);
  await reservations.markReservationReminderSent(form({ id: theirs.id }));
  assert.equal(
    (await prisma.reservation.findUniqueOrThrow({ where: { id: theirs.id } })).reminderSentAt,
    null,
    "suppressing another site's customer reminder must not be possible",
  );
});

test("another site cannot be renamed or rebranded", async () => {
  await asUser(operatorId);
  await plants.updateSite(form({ id: siteB, code: `${prefix}-HACKED`, name: "Hacked", city: "Nowhere", accentColor: "#ff0000" }));
  const untouched = await prisma.site.findUniqueOrThrow({ where: { id: siteB } });
  assert.equal(untouched.name, `${prefix} B`, "a plant operator must not be able to rewrite another factory's identity");
  assert.equal(untouched.accentColor, null);

  await plants.updateSite(form({ id: siteA, code: `${prefix}-A`, name: `${prefix} A2`, city: "Test", accentColor: "#123456" }));
  assert.equal((await prisma.site.findUniqueOrThrow({ where: { id: siteA } })).name, `${prefix} A2`, "their own site is still editable");
});

test("another site's supplier bill cannot be paid, cancelled or reconciled", async () => {
  const theirs = await makeSupplierBill(siteB);

  await asUser(accountantId);
  await finance.recordSupplierPayment(form({ supplierBillId: theirs.id, amount: "50" }));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: theirs.id } }), 0, "no payment may be posted against another site's bill");
  assert.equal(await prisma.journalEntry.count({ where: { siteId: siteB } }), 0, "and no journal entry may be created for it");

  await finance.cancelSupplierBill(form({ id: theirs.id }));
  assert.equal((await prisma.supplierBill.findUniqueOrThrow({ where: { id: theirs.id } })).status, "UNPAID", "another site's bill must not be cancellable");

  // A real payment at site B, made directly, must stay un-reconciled when
  // site A's accountant tries to mark it off.
  const theirPayment = await prisma.supplierPayment.create({ data: { supplierBillId: theirs.id, amount: 10 } });
  await finance.reconcileMovement(form({ kind: "supplierPayment", id: theirPayment.id }));
  assert.equal((await prisma.supplierPayment.findUniqueOrThrow({ where: { id: theirPayment.id } })).reconciled, false, "another site's money must not be reconcilable");
  await prisma.supplierPayment.delete({ where: { id: theirPayment.id } });
});

// BL-CR-P1-07 — the overpayment and race defects, on the caller's OWN
// bill, so nothing here is masked by the scope check above.
test("a supplier payment cannot exceed what is still outstanding", async () => {
  const bill = await makeSupplierBill(siteA, 100);

  await asUser(accountantId);
  await finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "150" }));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: bill.id } }), 0, "a payment larger than the balance must be refused outright");
  assert.equal((await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status, "UNPAID", "and the bill must not be marked PAID by it");

  // Exact settlement must still be accepted — the guard is a ceiling, not
  // a float-comparison trap.
  await finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "100" }));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: bill.id } }), 1);
  assert.equal((await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status, "PAID");

  // And nothing may be paid on top of a settled bill.
  await finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "1" }));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: bill.id } }), 1, "a settled bill must not accept more money");
});

test("two concurrent payments against one bill cannot together overpay it", async () => {
  const bill = await makeSupplierBill(siteA, 100);

  await asUser(accountantId);
  // Each is individually valid against the pre-payment balance. Only the
  // row lock inside the transaction makes the second one see the first.
  await Promise.all([
    finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "60" })),
    finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "60" })),
  ]);

  const paid = (await prisma.supplierPayment.aggregate({ where: { supplierBillId: bill.id }, _sum: { amount: true } }))._sum.amount ?? 0;
  assert.equal(paid, 60, "exactly one of two racing payments may land — the other exceeds the remaining balance");
  assert.equal((await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status, "PARTIALLY_PAID");
});

// ===================================================================
// PR4-R1-P1-01 / PR4-R1-P1-02, second external-review validation round.
//
// The first pass fixed the mutations the report named, and CI went green
// — which is exactly why the reviewer's point lands: a green suite proves
// only what it calls. These cover the Sales actions the first suite never
// touched, including the one that turned out to be a direct cross-site
// bridge rather than a race.
// ===================================================================

// createQuote takes repeated line fields, so it cannot use the `form`
// helper above (FormData.set would keep only the last of each).
function quoteForm(fields: Record<string, string>, lines: { mixId: string; volume: string; price: string }[]) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  for (const l of lines) {
    data.append("mixId", l.mixId);
    data.append("estimatedVolumeM3", l.volume);
    data.append("unitPrice", l.price);
  }
  return data;
}

test("createQuote cannot bridge two sites through a foreign opportunity id", async () => {
  const theirs = await makeOpportunity(siteB, { customerId, prospectName: null, status: "NEW" });
  const quotesBefore = await prisma.quote.count();

  await asUser(salesId);
  // The crafted request: the caller's OWN permitted siteId, another
  // site's opportunityId. Nothing in the schema ties the two together.
  await sales.createQuote(
    quoteForm({ opportunityId: theirs.id, siteId: siteA }, [{ mixId, volume: "10", price: "100" }]),
  );

  assert.equal(await prisma.quote.count(), quotesBefore, "no quote may be created against another site's opportunity");
  const untouched = await prisma.opportunity.findUniqueOrThrow({ where: { id: theirs.id } });
  assert.equal(untouched.status, "NEW", "and the foreign opportunity's stage must not be advanced by it");

  // Positive control: the identical call inside the caller's own site.
  const mine = await makeOpportunity(siteA, { customerId, prospectName: null, status: "NEW" });
  await sales.createQuote(
    quoteForm({ opportunityId: mine.id, siteId: siteA }, [{ mixId, volume: "10", price: "100" }]),
  );
  const created = await prisma.quote.findFirst({ where: { opportunityId: mine.id } });
  assert.ok(created, "quoting the caller's own opportunity must still work");
  quoteIds.push(created.id);
  assert.equal(created.siteId, siteA);
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: mine.id } })).status, "QUOTED");
});

test("a quote already bridged to a foreign opportunity cannot be accepted", async () => {
  // Constructed directly, because createQuote can no longer produce it —
  // this is the legacy row such a request would have left behind.
  const theirs = await makeOpportunity(siteB, { customerId, prospectName: null, status: "QUOTED" });
  const bridged = await prisma.quote.create({
    data: {
      quoteNumber: `${prefix}-QT-${randomUUID().slice(0, 8)}`,
      opportunityId: theirs.id,
      customerId,
      siteId: siteA,
      status: "SENT",
      currency: "SAR",
      subtotal: 100,
      total: 100,
      preparedById: salesId,
    },
  });
  quoteIds.push(bridged.id);

  await asUser(salesId);
  await sales.recordQuoteResponse(form({ id: bridged.id, response: "ACCEPTED" }));

  assert.equal(
    (await prisma.quote.findUniqueOrThrow({ where: { id: bridged.id } })).status,
    "SENT",
    "accepting must roll back entirely when the linked opportunity is out of scope — not half-apply",
  );
  assert.equal(
    (await prisma.opportunity.findUniqueOrThrow({ where: { id: theirs.id } })).status,
    "QUOTED",
    "and the foreign opportunity must never be marked WON",
  );
});

test("updateOpportunity and advanceOpportunityStage refuse another site's record", async () => {
  const theirs = await makeOpportunity(siteB, { customerId, status: "NEW", finalApprovedAt: new Date(), finalApprovedById: adminId });

  await asUser(salesId);
  await sales.updateOpportunity(form({ id: theirs.id, notes: `${prefix}-HACKED` }));
  assert.notEqual((await prisma.opportunity.findUniqueOrThrow({ where: { id: theirs.id } })).notes, `${prefix}-HACKED`);

  await sales.advanceOpportunityStage(form({ id: theirs.id, status: "WON" }));
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: theirs.id } })).status, "NEW", "another site's deal must not be closed on its behalf");

  // Positive controls, and the approval precondition that now lives in
  // the write's own predicate rather than beside it.
  const mine = await makeOpportunity(siteA, { customerId, status: "NEW" });
  await sales.updateOpportunity(form({ id: mine.id, notes: `${prefix}-OK` }));
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: mine.id } })).notes, `${prefix}-OK`);

  await sales.advanceOpportunityStage(form({ id: mine.id, status: "WON" }));
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: mine.id } })).status, "NEW", "WON still requires final approval on file");

  await prisma.opportunity.update({ where: { id: mine.id }, data: { finalApprovedAt: new Date(), finalApprovedById: adminId } });
  await sales.advanceOpportunityStage(form({ id: mine.id, status: "WON" }));
  assert.equal((await prisma.opportunity.findUniqueOrThrow({ where: { id: mine.id } })).status, "WON", "and goes through once it is");
});

test("updateQuote refuses another site's draft", async () => {
  const theirs = await makeQuote(siteB);
  await asUser(salesId);
  await sales.updateQuote(form({ id: theirs.id, notes: `${prefix}-HACKED` }));
  assert.notEqual((await prisma.quote.findUniqueOrThrow({ where: { id: theirs.id } })).notes, `${prefix}-HACKED`);

  const mine = await makeQuote(siteA);
  await sales.updateQuote(form({ id: mine.id, notes: `${prefix}-OK` }));
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: mine.id } })).notes, `${prefix}-OK`);
});

test("a quote line from another site cannot be converted into a reservation", async () => {
  const theirs = await makeQuote(siteB);
  const project = await prisma.project.create({ data: { name: `${prefix}-PROJ`, customerId, siteAddress: "Test" } });
  projectIds.push(project.id);
  await prisma.quote.update({ where: { id: theirs.id }, data: { status: "ACCEPTED", projectId: project.id } });
  const line = await prisma.quoteLine.create({
    data: { quoteId: theirs.id, mixId, estimatedVolumeM3: 10, unitPrice: 100, lineTotal: 1000 },
  });

  await asUser(salesId);
  const before = await prisma.reservation.count();
  await sales.convertQuoteLineToReservation(form({ quoteLineId: line.id }));
  assert.equal(await prisma.reservation.count(), before, "another site's accepted quote must not book production here");
});

// PR4-R1-P1-03 — the audit write is inside the money transaction, proved
// by making that write fail and showing nothing else survived.
test("a failed audit insert rolls back the payment, the bill status and the journal", async () => {
  const bill = await makeSupplierBill(siteA, 100);
  await asUser(accountantId);
  // Snapshotted, not asserted at zero: earlier tests in this file post
  // real payments at site A and their journal entries are legitimately
  // still on file. What this test is about is whether THIS transaction
  // left anything behind — a per-run delta, not a global count. (Asserting
  // a global zero here is what made the first CI run of this test red.)
  const journalEntriesBefore = await prisma.journalEntry.count({ where: { siteId: siteA } });

  // Failure injection at the database, not in application code: a
  // temporary trigger that rejects exactly this suite's audit row. If the
  // audit write were still post-commit, the payment and its journal entry
  // would already be committed by the time it fired.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_xs_reject_audit() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."reasonCode" = 'SUPPLIER_PAYMENT_RECORDED' AND NEW."afterValue" LIKE '%${prefix}%' THEN
        RAISE EXCEPTION 'injected audit failure';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_xs_reject_audit_trigger BEFORE INSERT ON "AuditEvent"
    FOR EACH ROW EXECUTE FUNCTION test_xs_reject_audit();
  `);
  try {
    await assert.rejects(
      () => finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "50" })),
      "the caller is told the action failed",
    );
    assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: bill.id } }), 0, "no payment may survive an audit failure");
    assert.equal((await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status, "UNPAID", "and the derived status must not have moved");
    assert.equal(await prisma.journalEntry.count({ where: { siteId: siteA } }), journalEntriesBefore, "and no journal entry may be left behind");
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_xs_reject_audit_trigger ON "AuditEvent";`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_xs_reject_audit();`);
  }

  // With the trigger gone the same payment goes through, which is what
  // proves the rollback above came from the injected failure and not from
  // some unrelated refusal.
  await finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "50" }));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: bill.id } }), 1);
  assert.equal(
    // This bill's own number, not the suite prefix: earlier tests in this
    // file post real payments against other bills that share the prefix.
    await prisma.auditEvent.count({ where: { reasonCode: "SUPPLIER_PAYMENT_RECORDED", afterValue: { contains: bill.billNumber } } }),
    1,
    "and the audit row committed with it",
  );
});

test("a payment above the outstanding balance is refused to the halala, with no epsilon", async () => {
  const bill = await makeSupplierBill(siteA, 100);
  await asUser(accountantId);

  // One halala over. The previous ±0.005 tolerance accepted exactly this.
  await finance.recordSupplierPayment(form({ supplierBillId: bill.id, amount: "100.01" }));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: bill.id } }), 0, "nothing above the balance may be posted, however small");

  // A value that is not exactly representable in binary floating point
  // must still settle a bill of the same value.
  const awkward = await makeSupplierBill(siteA, 0.1 + 0.2);
  await finance.recordSupplierPayment(form({ supplierBillId: awkward.id, amount: "0.3" }));
  assert.equal(await prisma.supplierPayment.count({ where: { supplierBillId: awkward.id } }), 1, "exact settlement must never be refused by a representation error");
  assert.equal((await prisma.supplierBill.findUniqueOrThrow({ where: { id: awkward.id } })).status, "PAID");
});

// PR4-R1 — taking over another sign-in's stranded offline readings
// re-attributes them, in the audit log, to whoever replays them. The
// decision is therefore gated and recorded on the server, not left to the
// browser that is doing the re-attributing.
test("adopting another sign-in's stranded readings needs supervisor permission and is audited", async () => {
  const fd = new FormData();
  fd.set("pending", "3");

  await asUser(operatorId);
  assert.deepEqual(
    await production.authorizeOfflineQueueAdoption(fd),
    { status: "FORBIDDEN" },
    "an ordinary operator must not be able to file another person's readings under their own name",
  );
  assert.equal(await prisma.auditEvent.count({ where: { reasonCode: "OFFLINE_QUEUE_ADOPTED", actorId: operatorId } }), 0, "and a refusal leaves no record of a grant");

  // PLANT_ADMIN holds the same sign-off level as a shortage override.
  const supervisor = await prisma.user.create({
    data: { passwordHash: "test-only", name: prefix, plantId: plantA, email: `${prefix}-sup@example.invalid`, role: "PLANT_ADMIN" },
  });
  supervisorId = supervisor.id;
  await asUser(supervisorId);
  assert.deepEqual(await production.authorizeOfflineQueueAdoption(fd), { status: "OK" });

  const granted = await prisma.auditEvent.findFirst({ where: { reasonCode: "OFFLINE_QUEUE_ADOPTED", actorId: supervisorId } });
  assert.ok(granted, "every granted adoption must name who decided it");
  assert.ok(granted.afterValue?.includes("3"), "and how many readings they took over");
});

after(async () => {
  const users = [operatorId, salesId, accountantId, adminId, salesManagerId, salesSupervisorId, supervisorId].filter(Boolean);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  // Ledger rows first: journal lines reference accounts, and the accounts
  // created by this suite's own postings must go with them.
  const sites = [siteA, siteB].filter(Boolean);
  const touchedAccounts = (await prisma.journalLine.findMany({ where: { siteId: { in: sites } }, select: { accountId: true } })).map((l) => l.accountId);
  await prisma.journalEntry.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.account.deleteMany({ where: { id: { in: touchedAccounts.filter((id) => !initialAccountIds.includes(id)) }, journalLines: { none: {} } } });
  await prisma.supplierPayment.deleteMany({ where: { supplierBillId: { in: supplierBillIds } } });
  await prisma.supplierBill.deleteMany({ where: { id: { in: supplierBillIds } } });
  await prisma.priceListEntry.deleteMany({ where: { customerId } });
  await prisma.fieldVisit.deleteMany({ where: { id: { in: fieldVisitIds } } });
  // AuditEvent rows are immutable in the database (see the trigger added by
  // 20260906010000_harden_production_lifecycle_invariants); fixture cleanup
  // uses that trigger's own documented bypass, scoped to this transaction.
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.bypass_audit_event_immutability = 'on'`,
    prisma.auditEvent.deleteMany({ where: { actorId: { in: users } } }),
  ]);
  await prisma.drumReturn.deleteMany({ where: { tripId: { in: tripIds } } });
  await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
  await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: { in: ticketIds } } });
  await prisma.batchTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await prisma.truck.deleteMany({ where: { id: { in: truckIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.reservation.deleteMany({ where: { quoteLine: { quoteId: { in: quoteIds } } } });
  await prisma.quoteLine.deleteMany({ where: { quoteId: { in: quoteIds } } });
  await prisma.quote.deleteMany({ where: { quoteNumber: { startsWith: prefix } } });
  await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
  await prisma.opportunity.deleteMany({ where: { opportunityNumber: { startsWith: prefix } } });
  await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: purchaseOrderIds } } });
  await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.user.deleteMany({ where: { name: prefix } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.mixDesign.deleteMany({ where: { id: mixId } });
  await prisma.supplier.deleteMany({ where: { id: supplierId } });
  await prisma.plant.deleteMany({ where: { id: { in: [plantA, plantB].filter(Boolean) } } });
  await prisma.site.deleteMany({ where: { id: { in: [siteA, siteB].filter(Boolean) } } });

  // Same zero-residue contract every other DB-backed suite in this repo
  // holds itself to: a second full run against the same database must
  // start from exactly the state the first one found.
  assert.equal(await prisma.batchTicket.count({ where: { ticketNumber: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.site.count({ where: { code: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.supplierBill.count({ where: { billNumber: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.opportunity.count({ where: { opportunityNumber: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.fieldVisit.count({ where: { visitNumber: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.quote.count({ where: { quoteNumber: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.reservation.count({ where: { reservationNumber: { startsWith: prefix } } }), 0);
});
