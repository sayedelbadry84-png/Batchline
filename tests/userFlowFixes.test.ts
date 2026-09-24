// Regression tests for the user-flow defects an end-to-end pass reported on
// 2026-09-16. Each case drives the real Server Action or page against a
// real PostgreSQL database — the same way crossSiteAccess.test.ts does —
// because every one of these was a gap between what the database held and
// what the person using the screen could see or do.
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
const suppliers = await import("../src/app/(app)/suppliers/actions");
const payroll = await import("../src/app/(app)/employees/payroll/actions");
const mixDesigns = await import("../src/app/(app)/mix-designs/actions");
const TripPermalinkPage = (await import("../src/app/(app)/trips/[ticket]/page")).default;

const prefix = `TEST-SUITE-UF-${randomUUID().slice(0, 8)}`;
let siteA = "", siteB = "", plantA = "", plantB = "";
let adminId = "", accountantId = "", qualityId = "", operatorId = "";
let initialAccountIds: string[] = [];

async function asUser(userId: string) {
  const token = createSessionToken();
  await prisma.session.create({ data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) } });
  cookieValues.set("batchline_session", token);
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

// redirect() and notFound() throw control-flow errors carrying a digest.
// Capturing it is how a test tells "went to /purchasing?tab=suppliers"
// apart from "returned without doing anything".
async function digestOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw e;
  }
}

before(async () => {
  siteA = (await prisma.site.create({ data: { code: `${prefix}-A`, name: `${prefix} A`, city: "Test", country: "Test" } })).id;
  siteB = (await prisma.site.create({ data: { code: `${prefix}-B`, name: `${prefix} B`, city: "Test", country: "Test" } })).id;
  plantA = (await prisma.plant.create({ data: { name: `${prefix} A`, siteId: siteA } })).id;
  plantB = (await prisma.plant.create({ data: { name: `${prefix} B`, siteId: siteB } })).id;
  const base = { passwordHash: "test-only", name: prefix, plantId: plantA };
  adminId = (await prisma.user.create({ data: { ...base, email: `${prefix}-admin@example.invalid`, role: "ADMIN" } })).id;
  accountantId = (await prisma.user.create({ data: { ...base, email: `${prefix}-acct@example.invalid`, role: "ACCOUNTANT" } })).id;
  qualityId = (await prisma.user.create({ data: { ...base, email: `${prefix}-qs@example.invalid`, role: "QUALITY_SUPERVISOR" } })).id;
  operatorId = (await prisma.user.create({ data: { ...base, email: `${prefix}-op@example.invalid`, role: "PLANT_OPERATOR" } })).id;
  initialAccountIds = (await prisma.account.findMany({ select: { id: true } })).map((a) => a.id);
});

// ---------------------------------------------------------------- supplier

test("a supplier edit is stored and the page leaves edit mode so the catalog row shows it", async () => {
  const supplier = await prisma.supplier.create({ data: { name: `${prefix}-SUP`, materialCatalog: "old", leadTimeDays: 3 } });
  await asUser(accountantId);

  const digest = await digestOf(() =>
    suppliers.updateSupplier(form({ id: supplier.id, name: `${prefix}-SUP-RENAMED`, materialCatalog: "cement, slag", leadTimeDays: "7", address: "Industrial zone", contactMethod: "phone" })),
  );
  // The defect: the write happened but the page stayed on
  // &editSupplier=<id>, re-rendering the open form instead of the row.
  assert.ok(digest?.includes("/purchasing?tab=suppliers"), `a successful save must leave edit mode, got ${digest}`);

  const stored = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
  assert.equal(stored.name, `${prefix}-SUP-RENAMED`);
  assert.equal(stored.materialCatalog, "cement, slag");
  assert.equal(stored.leadTimeDays, 7);
  assert.equal(stored.contactMethod, "phone");
});

test("an invalid lead time is refused rather than silently clearing the stored one", async () => {
  const supplier = await prisma.supplier.create({ data: { name: `${prefix}-SUP2`, leadTimeDays: 5 } });
  await asUser(accountantId);
  const digest = await digestOf(() => suppliers.updateSupplier(form({ id: supplier.id, name: `${prefix}-SUP2`, leadTimeDays: "-2" })));
  assert.equal(digest, null, "a refused save stays on the form");
  assert.equal((await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).leadTimeDays, 5);
});

// ----------------------------------------------------------------- payroll

async function approvedRun() {
  const employeeA = await prisma.employee.create({ data: { plantId: plantA, name: `${prefix}-EMP-A`, role: "DRIVER" } });
  const employeeB = await prisma.employee.create({ data: { plantId: plantB, name: `${prefix}-EMP-B`, role: "DRIVER" } });
  const run = await prisma.payrollRun.create({
    data: {
      runNumber: `${prefix}-PYR-${randomUUID().slice(0, 6)}`,
      periodStart: new Date("2026-08-01"),
      periodEnd: new Date("2026-08-31"),
      status: "APPROVED",
      createdById: adminId,
      approvedById: adminId,
      approvedAt: new Date(),
      lines: {
        create: [
          { employeeId: employeeA.id, wageType: "MONTHLY", wageRate: 1000, periodDays: 31, unpaidDays: 0, grossPay: 1000, netPay: 900, employeeGosi: 100, employerGosi: 120 },
          { employeeId: employeeB.id, wageType: "MONTHLY", wageRate: 2000, periodDays: 31, unpaidDays: 0, grossPay: 2000, netPay: 1800, employeeGosi: 200, employerGosi: 240 },
        ],
      },
    },
  });
  return run;
}

test("marking a payroll run paid keeps the payment record: date, who, and the reference", async () => {
  const run = await approvedRun();
  await asUser(adminId);
  await payroll.markPayrollRunPaid(form({ id: run.id, paymentReference: "  WPS-BATCH-8841  " }));

  const stored = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, "PAID");
  assert.ok(stored.paidAt, "the payment date is stored");
  assert.equal(stored.paidById, adminId, "and who recorded it");
  assert.equal(stored.paymentReference, "WPS-BATCH-8841", "and the reference, trimmed but otherwise exactly as typed");

  const txns = await prisma.cashTransaction.findMany({ where: { description: `Payroll run ${run.runNumber}` }, orderBy: { siteId: "asc" } });
  assert.equal(txns.length, 2, "one cash transaction per site");
  assert.ok(txns.every((t) => t.reference === "WPS-BATCH-8841"), "each posting carries the reference it can be reconciled by");
  const totals = txns.map((t) => t.amount).sort((a, b) => a - b);
  assert.deepEqual(totals, [1120, 2240]);
});

test("two simultaneous 'mark paid' clicks post the payroll to the cash ledger once, not twice", async () => {
  const run = await approvedRun();
  await asUser(adminId);
  // The defect: both requests read APPROVED, both posted every site's
  // cash, and only then did either flip the status.
  await Promise.allSettled([
    payroll.markPayrollRunPaid(form({ id: run.id, paymentReference: "FIRST" })),
    payroll.markPayrollRunPaid(form({ id: run.id, paymentReference: "SECOND" })),
  ]);

  const txns = await prisma.cashTransaction.findMany({ where: { description: `Payroll run ${run.runNumber}` } });
  assert.equal(txns.length, 2, "exactly one posting per site, however many submits raced");
  const stored = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, "PAID");
  assert.ok(["FIRST", "SECOND"].includes(stored.paymentReference ?? ""));
  assert.ok(txns.every((t) => t.reference === stored.paymentReference), "the postings belong to the submit whose reference the run kept");
});

// -------------------------------------------------------------- mix design

async function mixWithAdmixture(specificGravity: number | null) {
  const mix = await prisma.mixDesign.create({ data: { code: `${prefix}-MIX-${randomUUID().slice(0, 6)}`, grade: "C30", slumpTargetMm: 100, wcRatio: 0.45 } });
  const material = await prisma.material.create({ data: { name: `${prefix}-ADMIX-${randomUUID().slice(0, 6)}`, type: "ADMIXTURE", specificGravity } });
  return { mix, material };
}

test("a liter dose on a material with no specific gravity is refused, not stored as kilograms", async () => {
  const { mix, material } = await mixWithAdmixture(null);
  await asUser(adminId);
  const digest = await digestOf(() => mixDesigns.addComponent(form({ mixId: mix.id, materialId: material.id, designMassKgPerM3: "5", dosageUnit: "LITER", tolerancePct: "2" })));
  assert.ok(digest?.includes("componentError=SG_REQUIRED"), `expected a visible SG_REQUIRED refusal, got ${digest}`);
  assert.equal(await prisma.mixComponent.count({ where: { mixId: mix.id } }), 0, "nothing may be stored — 5 L recorded as 5 kg was the defect");
});

test("specific gravity entered on the mix design form fills the material and converts the liter dose", async () => {
  const { mix, material } = await mixWithAdmixture(null);
  await asUser(adminId);
  const digest = await digestOf(() =>
    mixDesigns.addComponent(form({ mixId: mix.id, materialId: material.id, designMassKgPerM3: "5", dosageUnit: "LITER", tolerancePct: "2", specificGravity: "1.2" })),
  );
  assert.equal(digest, `NEXT_REDIRECT;replace;/mix-designs/${mix.id};307;`);
  assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).specificGravity, 1.2);
  const component = await prisma.mixComponent.findFirstOrThrow({ where: { mixId: mix.id, materialId: material.id } });
  assert.ok(Math.abs(component.designMassKgPerM3 - 6) < 1e-9, `5 L at SG 1.2 is 6 kg, got ${component.designMassKgPerM3}`);
});

test("the mix design form never overwrites a material's existing specific gravity", async () => {
  const { mix, material } = await mixWithAdmixture(1.1);
  await asUser(adminId);
  await digestOf(() => mixDesigns.addComponent(form({ mixId: mix.id, materialId: material.id, designMassKgPerM3: "10", dosageUnit: "LITER", tolerancePct: "2", specificGravity: "2.5" })));
  assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).specificGravity, 1.1, "changing it would rescale every other mix that uses this material");
  const component = await prisma.mixComponent.findFirstOrThrow({ where: { mixId: mix.id, materialId: material.id } });
  assert.ok(Math.abs(component.designMassKgPerM3 - 11) < 1e-9, "the dose converts with the material's own SG");
});

// Runs `hook` once, immediately before the action's next $transaction
// starts — the window between its pre-read and its write, where a
// concurrent request's commit lands.
async function withHookBeforeNextTransaction<T>(hook: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const original = prisma.$transaction.bind(prisma);
  let fired = false;
  prisma.$transaction = (async (...args: Parameters<typeof prisma.$transaction>) => {
    if (!fired) {
      fired = true;
      await hook();
    }
    return (original as (...a: typeof args) => unknown)(...args);
  }) as typeof prisma.$transaction;
  try {
    return await run();
  } finally {
    prisma.$transaction = original;
  }
}

test("two people filling an empty specific gravity at once: the dose converts with the SG the material ends up with", async () => {
  const { mix, material } = await mixWithAdmixture(null);
  await asUser(adminId);
  // The other user's 1.2 commits after this request read the material as
  // empty but before it writes. This request entered 2.0 for 10 L.
  await withHookBeforeNextTransaction(
    () => prisma.material.update({ where: { id: material.id }, data: { specificGravity: 1.2 } }),
    () => digestOf(() => mixDesigns.addComponent(form({ mixId: mix.id, materialId: material.id, designMassKgPerM3: "10", dosageUnit: "LITER", tolerancePct: "2", specificGravity: "2.0" }))),
  );

  assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).specificGravity, 1.2, "the first fill stands");
  const component = await prisma.mixComponent.findFirstOrThrow({ where: { mixId: mix.id, materialId: material.id } });
  // The defect: 10 L × 2.0 = 20 kg stored against a material that says 1.2.
  assert.ok(Math.abs(component.designMassKgPerM3 - 12) < 1e-9, `10 L at the material's SG 1.2 is 12 kg, got ${component.designMassKgPerM3}`);
  assert.equal(
    await prisma.auditEvent.count({ where: { recordId: material.id, reasonCode: "MATERIAL_SG_SET_FROM_MIX_DESIGN" } }),
    0,
    "this request did not set the SG, so it must not audit that it did",
  );
});

test("a role that cannot edit materials cannot set a specific gravity from the mix design form", async () => {
  const { mix, material } = await mixWithAdmixture(null);
  await asUser(qualityId);
  const digest = await digestOf(() =>
    mixDesigns.addComponent(form({ mixId: mix.id, materialId: material.id, designMassKgPerM3: "5", dosageUnit: "LITER", tolerancePct: "2", specificGravity: "1.2" })),
  );
  assert.ok(digest?.includes("componentError=SG_NOT_PERMITTED"), `got ${digest}`);
  assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: material.id } })).specificGravity, null);
  assert.equal(await prisma.mixComponent.count({ where: { mixId: mix.id } }), 0);
});

// ------------------------------------------------------------ trip permalink

async function ticketAt(siteId: string, plantId: string) {
  const customer = await prisma.customer.create({ data: { legalName: `${prefix}-CUST-${randomUUID().slice(0, 6)}` } });
  const project = await prisma.project.create({ data: { name: `${prefix}-PROJ`, customerId: customer.id, siteAddress: "Test" } });
  const mix = await prisma.mixDesign.create({ data: { code: `${prefix}-TMIX-${randomUUID().slice(0, 6)}`, grade: "C25", slumpTargetMm: 100, wcRatio: 0.5 } });
  const reservation = await prisma.reservation.create({
    data: { reservationNumber: `${prefix}-RES-${randomUUID().slice(0, 6)}`, projectId: project.id, siteId, mixId: mix.id, requestedVolumeM3: 8, originalVolumeM3: 8, pourWindowStart: new Date(), status: "CONFIRMED" },
  });
  return prisma.batchTicket.create({
    data: { ticketNumber: `${prefix}-BT-${randomUUID().slice(0, 6)}`, reservationId: reservation.id, mixId: mix.id, plantId, volumeM3: 8 },
  });
}

test("a trip permalink by ticket number opens the batch ticket's page", async () => {
  const ticket = await ticketAt(siteA, plantA);
  await asUser(operatorId);
  const digest = await digestOf(() => TripPermalinkPage({ params: Promise.resolve({ ticket: encodeURIComponent(ticket.ticketNumber) }) }));
  assert.ok(digest?.startsWith("NEXT_REDIRECT") && digest.includes(`/production/${ticket.id}`), `got ${digest}`);
});

test("a trip permalink for another site's ticket is a plain not-found", async () => {
  const foreign = await ticketAt(siteB, plantB);
  await asUser(operatorId);
  const digest = await digestOf(() => TripPermalinkPage({ params: Promise.resolve({ ticket: foreign.ticketNumber }) }));
  assert.ok(digest?.includes("404"), `an out-of-scope ticket must be indistinguishable from a missing one, got ${digest}`);
  const missing = await digestOf(() => TripPermalinkPage({ params: Promise.resolve({ ticket: `${prefix}-NO-SUCH-TICKET` }) }));
  assert.equal(digest, missing, "and identical to a ticket that does not exist");
});

after(async () => {
  const sites = [siteA, siteB].filter(Boolean);
  const users = [adminId, accountantId, qualityId, operatorId].filter(Boolean);

  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.bypass_audit_event_immutability = 'on'`,
    prisma.auditEvent.deleteMany({ where: { actorId: { in: users } } }),
  ]);
  await prisma.session.deleteMany({ where: { userId: { in: users } } });

  const touchedAccounts = (await prisma.journalLine.findMany({ where: { siteId: { in: sites } }, select: { accountId: true } })).map((l) => l.accountId);
  await prisma.journalEntry.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.account.deleteMany({ where: { id: { in: touchedAccounts.filter((id) => !initialAccountIds.includes(id)) }, journalLines: { none: {} } } });
  await prisma.cashTransaction.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.payrollLine.deleteMany({ where: { payrollRun: { runNumber: { startsWith: prefix } } } });
  await prisma.payrollRun.deleteMany({ where: { runNumber: { startsWith: prefix } } });
  await prisma.employee.deleteMany({ where: { name: { startsWith: prefix } } });

  await prisma.batchTicket.deleteMany({ where: { ticketNumber: { startsWith: prefix } } });
  await prisma.reservation.deleteMany({ where: { reservationNumber: { startsWith: prefix } } });
  await prisma.project.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.customer.deleteMany({ where: { legalName: { startsWith: prefix } } });
  await prisma.mixComponent.deleteMany({ where: { mix: { code: { startsWith: prefix } } } });
  await prisma.mixDesign.deleteMany({ where: { code: { startsWith: prefix } } });
  await prisma.material.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: prefix } } });

  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.plant.deleteMany({ where: { id: { in: [plantA, plantB].filter(Boolean) } } });
  await prisma.site.deleteMany({ where: { id: { in: sites } } });

  // CI runs the suite twice on one database; the second run must find
  // none of this.
  assert.equal(await prisma.site.count({ where: { code: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.payrollRun.count({ where: { runNumber: { startsWith: prefix } } }), 0);
  assert.equal(await prisma.cashTransaction.count({ where: { description: { contains: prefix } } }), 0);
  await prisma.$disconnect();
});
