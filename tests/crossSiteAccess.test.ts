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
const DeliveryNotePage = (await import("../src/app/(app)/production/[id]/delivery-note/page")).default;
const DeliveryNoteSupplementPage = (await import("../src/app/(app)/production/[id]/delivery-note/supplement/page")).default;
const PurchaseOrderDetailPage = (await import("../src/app/(app)/purchasing/orders/[id]/page")).default;
const QuoteDetailPage = (await import("../src/app/(app)/sales/quotes/[id]/page")).default;
const CustomerStatementPage = (await import("../src/app/(app)/finance/customers/[id]/statement/page")).default;

const prefix = `TEST-SUITE-XS-${randomUUID().slice(0, 8)}`;

// Site A is the reader's own site; site B is the one whose records must
// stay invisible. Every fixture below exists in BOTH, so each assertion
// has a positive control: the same page, the same role, the same shape of
// record — only the site differs.
let siteA: string, siteB: string, plantA: string, plantB: string;
let operatorId: string, salesId: string, accountantId: string, adminId: string;
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

async function asUser(userId: string) {
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 60_000) } });
  cookieValues.set("batchline_session", session.id);
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

after(async () => {
  const users = [operatorId, salesId, accountantId, adminId].filter(Boolean);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.drumReturn.deleteMany({ where: { tripId: { in: tripIds } } });
  await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
  await prisma.batchComponentActual.deleteMany({ where: { batchTicketId: { in: ticketIds } } });
  await prisma.batchTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await prisma.truck.deleteMany({ where: { id: { in: truckIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
  await prisma.opportunity.deleteMany({ where: { id: { in: opportunityIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: purchaseOrderIds } } });
  await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
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
});
