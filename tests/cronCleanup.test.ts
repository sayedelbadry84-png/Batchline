// Audit 2026-10-26 P2-D, against a real PostgreSQL database: the daily
// cron sweep must expire a quote and audit it in one transaction.
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

const { prisma } = await import("../src/lib/prisma");
const { NextRequest } = await import("next/server");

const prefix = `CRON-${randomUUID().slice(0, 8)}`;
let siteId = "", customerId = "", adminId = "";

// AuditEvent rows are immutable; fixture cleanup uses the trigger's own
// documented escape hatch, as the other DB-backed suites do.
async function deleteAuditEvents(where: { recordId: { in: string[] } }) {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.bypass_audit_event_immutability = 'on'`,
    prisma.auditEvent.deleteMany({ where }),
  ]);
}

before(async () => {
  siteId = (await prisma.site.create({ data: { code: prefix, name: prefix, city: "Test", country: "Test" } })).id;
  const plantId = (await prisma.plant.create({ data: { name: prefix, siteId } })).id;
  adminId = (await prisma.user.create({ data: { email: `${prefix}@example.invalid`, passwordHash: "test-only", name: prefix, role: "ADMIN", plantId } })).id;
  customerId = (await prisma.customer.create({ data: { legalName: prefix } })).id;
});

after(async () => {
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.user.deleteMany({ where: { id: adminId } });
  await prisma.plant.deleteMany({ where: { siteId } });
  await prisma.site.deleteMany({ where: { id: siteId } });
  await prisma.$disconnect();
});

// The cron expiry of a quote and its audit row are
// one transaction. A failed audit insert rolls the claim back (the quote
// stays SENT, is counted as failed, and the sweep goes on); a repeat run
// neither re-expires nor re-audits.
test("cron quote expiry commits with exactly one audit row, or not at all", async () => {
  const cron = await import("../src/app/api/cron/cleanup/route");
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = randomUUID(); // disposable, test only
  const call = () => cron.GET(new NextRequest("http://test.local/api/cron/cleanup", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  const opportunity = await prisma.opportunity.create({ data: { opportunityNumber: `${prefix}-OPP-CRON`, customerId, siteId, ownerId: adminId } });
  const makeQuote = (suffix: string) => prisma.quote.create({ data: {
    quoteNumber: `${prefix}-QT-${suffix}`, opportunityId: opportunity.id, customerId, siteId, currency: "SAR",
    subtotal: 100, total: 100, preparedById: adminId, status: "SENT", validUntil: new Date(Date.now() - 60_000),
  } });
  const runsBefore = await prisma.auditEvent.count({ where: { recordId: "cron:cleanup", reasonCode: "CRON_CLEANUP_RUN" } });
  const ok = await makeQuote("OK");
  const failing = await makeQuote("FAIL");
  // A trigger that refuses this one quote's expiry audit, standing in for
  // any failure of the audit insert (FK, constraint, connection).
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_refuse_quote_audit() RETURNS trigger AS $$
    BEGIN IF NEW."recordId" = '${failing.id}' THEN RAISE EXCEPTION 'test: audit insert refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER test_refuse_quote_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_refuse_quote_audit()`);
  try {
    const first = await (await call()).json();
    assert.ok(first.quotesExpired >= 1);
    assert.ok(first.quotesExpiryFailed >= 1);
    assert.ok("pendingBlobDeletions" in first, "the sweeps after the failed quote still ran");
    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: ok.id } })).status, "EXPIRED");
    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: failing.id } })).status, "SENT", "the claim rolled back with its audit");
    assert.equal(await prisma.auditEvent.count({ where: { recordId: ok.id, reasonCode: "QUOTE_AUTO_EXPIRED" } }), 1);
    assert.equal(await prisma.auditEvent.count({ where: { recordId: failing.id } }), 0);

    await prisma.$executeRawUnsafe(`DROP TRIGGER test_refuse_quote_audit ON "AuditEvent"`);
    await call();
    await call();
    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: failing.id } })).status, "EXPIRED", "the next run retried it");
    assert.equal(await prisma.auditEvent.count({ where: { recordId: failing.id, reasonCode: "QUOTE_AUTO_EXPIRED" } }), 1);
    assert.equal(await prisma.auditEvent.count({ where: { recordId: ok.id, reasonCode: "QUOTE_AUTO_EXPIRED" } }), 1, "a repeat run does not audit again");
    // PM review 2026-10-27 P2-5: every run leaves one durable SYSTEM row with
    // its counters, so a run is provable without runtime logs.
    const runs = await prisma.auditEvent.findMany({ where: { recordId: "cron:cleanup", reasonCode: "CRON_CLEANUP_RUN" }, orderBy: { createdAt: "asc" } });
    assert.equal(runs.length - runsBefore, 3);
    assert.equal(runs[runs.length - 1].role, "SYSTEM");
    const counters = JSON.parse(runs[runs.length - 3].afterValue!);
    assert.ok(counters.quotesExpiryFailed >= 1, "the first run's failure is on record");
    assert.ok("deadLettered" in counters.pendingBlobDeletions);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_refuse_quote_audit ON "AuditEvent"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_refuse_quote_audit()`);
    await deleteAuditEvents({ recordId: { in: [ok.id, failing.id, "cron:cleanup"] } });
    await prisma.quote.deleteMany({ where: { id: { in: [ok.id, failing.id] } } });
    await prisma.opportunity.delete({ where: { id: opportunity.id } });
    if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret;
  }
});
