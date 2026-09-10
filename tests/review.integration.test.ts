// Real PostgreSQL, including the Server Actions. Only Next's request UI
// adapters are replaced; permissions, sessions, transactions and writes
// use the actual application code and database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHmac, randomUUID } from "node:crypto";
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
    get: (name: string) => cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined,
    set: (name: string, value: string) => cookieValues.set(name, value),
    delete: (name: string) => cookieValues.delete(name),
  }),
  headers: async () => new Headers(),
};
require("next/cache");
require.cache[require.resolve("next/cache")]!.exports = { revalidatePath: () => {} };

const { prisma } = await import("../src/lib/prisma");
const { createSessionToken, hashSessionToken } = await import("../src/lib/sessionToken");
const { generateZatcaDocuments } = await import("../src/lib/zatca/generate");
const { generateZatcaCreditNoteDocuments } = await import("../src/lib/zatca/creditNote");
const { zatcaGenesisPreviousHash } = await import("../src/lib/zatca/invoiceXml");
const billing = await import("../src/app/(app)/billing/actions");
const hr = await import("../src/app/(app)/employees/actions");
const incentives = await import("../src/app/(app)/incentives/actions");
const { consumeTotpCode, recordAccountFailure } = await import("../src/lib/loginSecurity");
const { postInvoice } = await import("../src/lib/ledger");
const { NextRequest } = await import("next/server");
const scada = await import("../src/app/api/scada/silo-reading/route");
const gps = await import("../src/app/api/telematics/ping/route");
const { hashApiKey } = await import("../src/lib/apiKeys");
const { submitDocument } = await import("../src/lib/zatca/submission");
const { reverseJournalEntry } = await import("../src/lib/ledger");

const prefix = `REVIEW-${randomUUID()}`;
let siteId: string, otherSiteId: string, plantId: string, otherPlantId: string;
let customerId: string, adminId: string, operatorId: string, hrId: string;
let employeeId: string, otherEmployeeId: string, siloId: string;
const invoiceIds: string[] = [];
let initialAccountIds: string[] = [];
const apiKey = randomUUID(); // disposable test credential only

// AuditEvent rows are immutable in the database: the
// audit_event_no_update / audit_event_no_delete triggers added by
// prisma/migrations/20260906010000_harden_production_lifecycle_invariants
// reject every UPDATE and DELETE outright, so a plain
// `auditEvent.deleteMany` in teardown fails the whole hook with
// "AuditEvent rows are immutable". That trigger predates this suite on
// another branch and is a deliberate production invariant — a correction
// is a new event, never an edit of one already on file — so fixture
// cleanup goes through the trigger's own documented escape hatch instead
// of around the invariant. `SET LOCAL` scopes the bypass to this one
// transaction, and no application code path ever sets it. The three
// other DB-backed suites (batchCompletion, productionLifecycle,
// reservationMixRevision) clean up the same way.
async function deleteAuditEvents(where: { recordId?: { in: string[] }; actorId?: { in: string[] } }) {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.bypass_audit_event_immutability = 'on'`,
    prisma.auditEvent.deleteMany({ where }),
  ]);
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
// BL-CR-P1-05: the cookie now carries a CSPRNG token, and the row stores
// only its SHA-256 — so a fixture session has to be created the same way
// the application creates one, not by putting a row id in the cookie.
async function asUser(userId: string) {
  const token = createSessionToken();
  await prisma.session.create({ data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) } });
  cookieValues.set("batchline_session", token);
}
async function invoice(total = 115) {
  const row = await prisma.invoice.create({ data: {
    invoiceNumber: `${prefix}-${randomUUID()}`, customerId, plantId, currency: "SAR",
    subtotal: total / 1.15, taxAmount: total - total / 1.15, taxRatePct: 15, total,
    dueDate: new Date(), status: "SENT",
  } });
  invoiceIds.push(row.id);
  return row;
}
function currentCode(): string {
  // RFC test secret corresponds to this ASCII key; generate independently
  // of the application verifier so the replay test is not self-confirming.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", "12345678901234567890").update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0");
}
const totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

before(async () => {
  initialAccountIds = (await prisma.account.findMany({ select: { id: true } })).map(a => a.id);
  const a = await prisma.site.create({ data: { code: `${prefix}-A`, name: "Review A", city: "Test", country: "Test" } });
  const b = await prisma.site.create({ data: { code: `${prefix}-B`, name: "Review B", city: "Test", country: "Test" } });
  siteId = a.id; otherSiteId = b.id;
  plantId = (await prisma.plant.create({ data: { name: "Review A", siteId } })).id;
  otherPlantId = (await prisma.plant.create({ data: { name: "Review B", siteId: otherSiteId } })).id;
  customerId = (await prisma.customer.create({ data: { legalName: prefix } })).id;
  const userData = { passwordHash: "test-only", plantId, name: prefix };
  adminId = (await prisma.user.create({ data: { ...userData, email: `${prefix}-admin@example.invalid`, role: "ADMIN" } })).id;
  operatorId = (await prisma.user.create({ data: { ...userData, email: `${prefix}-operator@example.invalid`, role: "PLANT_OPERATOR" } })).id;
  hrId = (await prisma.user.create({ data: { ...userData, email: `${prefix}-hr@example.invalid`, role: "PLANT_ADMIN" } })).id;
  employeeId = (await prisma.employee.create({ data: { name: prefix, role: "DRIVER", plantId } })).id;
  otherEmployeeId = (await prisma.employee.create({ data: { name: prefix, role: "DRIVER", plantId: otherPlantId } })).id;
  siloId = (await prisma.silo.create({ data: { name: prefix, plantId, materialType: "CEMENT", capacityTons: 50, currentLevelTons: 10 } })).id;
  await prisma.zatcaSettings.create({ data: { siteId, sellerLegalName: "Review Seller", vatNumber: "300000000000003" } });
  await prisma.apiKey.create({ data: { siteId, label: prefix, keyHash: hashApiKey(apiKey), keyPrefix: "test", scope: "ALL", createdById: adminId } });
});

after(async () => {
  const users = [adminId, operatorId, hrId].filter(Boolean);
  const sites = [siteId, otherSiteId].filter(Boolean);
  const accounts = await prisma.journalLine.findMany({ where: { siteId: { in: sites } }, select: { accountId: true } });
  const credits = await prisma.creditNote.findMany({ where: { invoiceId: { in: invoiceIds } }, select: { id: true } });
  await deleteAuditEvents({ recordId: { in: [...invoiceIds, ...credits.map(c => c.id)] } });
  await prisma.zatcaSubmissionAttempt.deleteMany({ where: { documentId: { in: [...invoiceIds, ...credits.map(c => c.id)] } } });
  await deleteAuditEvents({ actorId: { in: users } });
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.pendingTwoFactor.deleteMany({ where: { userId: { in: users } } });
  await prisma.apiKey.deleteMany({ where: { label: prefix } });
  await prisma.journalEntry.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.account.deleteMany({ where: { id: { in: accounts.map(a => a.accountId).filter(id => !initialAccountIds.includes(id)) }, journalLines: { none: {} } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId].filter(Boolean) } } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: [employeeId, otherEmployeeId].filter(Boolean) } } });
  await prisma.pumpIncentivePolicy.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.driverIncentivePolicy.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.incentiveMethod.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.employee.deleteMany({ where: { id: { in: [employeeId, otherEmployeeId].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.silo.deleteMany({ where: { id: { in: [siloId].filter(Boolean) } } });
  await prisma.zatcaSettings.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.plant.deleteMany({ where: { siteId: { in: sites } } });
  await prisma.site.deleteMany({ where: { id: { in: sites } } });
  await prisma.customer.deleteMany({ where: { id: { in: [customerId].filter(Boolean) } } });
  await prisma.$disconnect();
});

test("concurrent invoice/credit-note generation has one unbroken chain and unique ICVs", async () => {
  const docs = await Promise.all([invoice(), invoice(), invoice()]);
  const credit = await prisma.creditNote.create({ data: { creditNoteNumber: prefix, invoiceId: docs[0].id, amount: 10, reason: "OTHER", issuedById: adminId } });
  const results = await Promise.all([...docs.map(d => generateZatcaDocuments(d.id)), generateZatcaCreditNoteDocuments(credit.id)]);
  assert.ok(results.every(r => r.ok));
  const saved = [
    ...await prisma.invoice.findMany({ where: { id: { in: docs.map(d => d.id) } } }),
    (await prisma.creditNote.findUniqueOrThrow({ where: { id: credit.id } })),
  ].sort((a, b) => a.zatcaGeneratedAt!.getTime() - b.zatcaGeneratedAt!.getTime());
  assert.equal(saved[0].zatcaPreviousHash, zatcaGenesisPreviousHash());
  for (let i = 0; i < saved.length; i++) {
    assert.match(saved[i].zatcaXml!, new RegExp(`<cbc:UUID>${i + 1}</cbc:UUID>`));
    if (i) assert.equal(saved[i].zatcaPreviousHash, saved[i - 1].zatcaInvoiceHash);
  }
});
test("double generation only succeeds once and preserves the saved document", async () => {
  const d = await invoice();
  const results = await Promise.all([generateZatcaDocuments(d.id), generateZatcaDocuments(d.id)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.ok(results.some(r => !r.ok && r.reason === "ALREADY_GENERATED"));
});
test("cancelled invoices cannot join the chain; generated invoices cannot be cancelled", async () => {
  await asUser(adminId);
  const d = await invoice();
  await billing.cancelInvoice(form({ id: d.id }));
  assert.deepEqual(await generateZatcaDocuments(d.id), { ok: false, reason: "CANCELLED" });
  const generated = await invoice();
  await generateZatcaDocuments(generated.id);
  await billing.cancelInvoice(form({ id: generated.id }));
  assert.notEqual((await prisma.invoice.findUniqueOrThrow({ where: { id: generated.id } })).status, "CANCELLED");
});
test("two concurrent partial payments both persist and settle the invoice", async () => {
  await asUser(adminId);
  const d = await invoice(100);
  await Promise.all([billing.recordPayment(form({ invoiceId: d.id, amount: "40" })), billing.recordPayment(form({ invoiceId: d.id, amount: "60" }))]);
  const saved = await prisma.invoice.findUniqueOrThrow({ where: { id: d.id }, include: { payments: true } });
  assert.equal(saved.status, "PAID");
  assert.equal(saved.payments.length, 2);
  assert.equal(saved.payments.reduce((sum, p) => sum + p.amount, 0), 100);
});
test("cancellation racing payment never leaves money on a cancelled invoice", async () => {
  await asUser(adminId);
  const d = await invoice(100);
  await Promise.all([billing.cancelInvoice(form({ id: d.id })), billing.recordPayment(form({ invoiceId: d.id, amount: "40" }))]);
  const saved = await prisma.invoice.findUniqueOrThrow({ where: { id: d.id }, include: { payments: true } });
  if (saved.status === "CANCELLED") assert.equal(saved.payments.length, 0);
  else assert.equal(saved.payments.reduce((sum, p) => sum + p.amount, 0), 40);
});
test("journal numbering works across independent concurrent source transactions", async () => {
  const docs = await Promise.all([invoice(), invoice(), invoice()]);
  await Promise.all(docs.map(d => prisma.$transaction(tx => postInvoice(tx, { siteId, currency: "SAR", invoiceId: d.id, subtotal: 100, taxAmount: 15, total: 115 }), { timeout: 15000 })));
  assert.equal(await prisma.journalEntry.count({ where: { sourceRecordId: { in: docs.map(d => d.id) } } }), 3);
});
test("concurrent invoice generation bills a closed trip only once", async () => {
  await asUser(adminId);
  const project = await prisma.project.create({ data: { customerId, name: prefix, siteAddress: "Test" } });
  const mix = await prisma.mixDesign.create({ data: { code: prefix, grade: "C25", slumpTargetMm: 100, wcRatio: .5 } });
  const reservation = await prisma.reservation.create({ data: { reservationNumber: prefix, projectId: project.id, siteId, mixId: mix.id, requestedVolumeM3: 5, originalVolumeM3: 5, pourWindowStart: new Date() } });
  const ticket = await prisma.batchTicket.create({ data: { reservationId: reservation.id, mixId: mix.id, plantId, ticketNumber: prefix, volumeM3: 5, status: "COMPLETE" } });
  const truck = await prisma.truck.create({ data: { plantId, code: prefix, drumCapacityM3: 8 } });
  const trip = await prisma.trip.create({ data: { batchTicketId: ticket.id, truckId: truck.id, driverId: employeeId, status: "CLOSED", volumeDeliveredM3: 5 } });
  await prisma.priceListEntry.create({ data: { customerId, mixId: mix.id, pricePerM3: 100 } });
  try {
    const run = async () => {
      try { await billing.generateInvoiceForProject(form({ projectId: project.id })); }
      catch (error) {
        if (!(error instanceof Error) || !("digest" in error) || !String(error.digest).startsWith("NEXT_REDIRECT")) throw error;
      }
    };
    await Promise.all([run(), run()]);
    const saved = await prisma.invoice.findMany({ where: { projectId: project.id }, include: { lines: true } });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].lines.length, 1);
    assert.equal(saved[0].subtotal, 500);
    assert.match(saved[0].invoiceNumber, /^INV-\d{4}-\d+$/);
  } finally {
    await prisma.invoice.deleteMany({ where: { projectId: project.id } });
    await prisma.trip.delete({ where: { id: trip.id } });
    await prisma.batchTicket.delete({ where: { id: ticket.id } });
    await prisma.reservation.delete({ where: { id: reservation.id } });
    await prisma.priceListEntry.deleteMany({ where: { customerId, mixId: mix.id } });
    await prisma.mixDesign.delete({ where: { id: mix.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.truck.delete({ where: { id: truck.id } });
  }
});
test("HR actions reject another site's employee and all leave transitions", async () => {
  await asUser(hrId);
  await hr.recordAttendance(form({ employeeId: otherEmployeeId, date: "2026-09-09" }));
  await hr.createLeaveRequest(form({ employeeId: otherEmployeeId, type: "ANNUAL", startDate: "2026-09-09", endDate: "2026-09-10" }));
  assert.equal(await prisma.attendanceRecord.count({ where: { employeeId: otherEmployeeId } }), 0);
  assert.equal(await prisma.leaveRequest.count({ where: { employeeId: otherEmployeeId } }), 0);
  const leave = await prisma.leaveRequest.create({ data: { requestNumber: prefix, employeeId: otherEmployeeId, type: "ANNUAL", startDate: new Date(), endDate: new Date(), daysCount: 1, requestedById: adminId } });
  await hr.approveLeaveRequest(form({ id: leave.id }));
  await hr.rejectLeaveRequest(form({ id: leave.id, rejectionNote: "No" }));
  await hr.cancelLeaveRequest(form({ id: leave.id }));
  assert.equal((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave.id } })).status, "PENDING");
});
test("same-site leave approval posts all days exactly once", async () => {
  await asUser(hrId);
  await hr.createLeaveRequest(form({ employeeId, type: "ANNUAL", startDate: "2026-09-09", endDate: "2026-09-10" }));
  const leave = await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId } });
  await Promise.all([hr.approveLeaveRequest(form({ id: leave.id })), hr.approveLeaveRequest(form({ id: leave.id }))]);
  assert.equal(await prisma.attendanceRecord.count({ where: { employeeId, status: "ON_LEAVE" } }), 2);
  assert.equal(await prisma.auditEvent.count({ where: { recordId: leave.id, reasonCode: "LEAVE_APPROVED" } }), 1);
});
test("incentive policy writers and bracket deletion reject another site", async () => {
  await asUser(operatorId);
  const data = form({ siteId: otherSiteId, role: "MIXER_DRIVER", ratePerM3Sar: "5" });
  await incentives.updateIncentivePolicy(data);
  await incentives.updatePumpIncentivePolicy(data);
  await incentives.setFlatVolumeRate(data);
  await incentives.addPumpRateBracket(data);
  assert.equal(await prisma.driverIncentivePolicy.count({ where: { siteId: otherSiteId } }), 0);
  assert.equal(await prisma.pumpIncentivePolicy.count({ where: { siteId: otherSiteId } }), 0);
  const policy = await prisma.pumpIncentivePolicy.create({ data: { siteId: otherSiteId, role: "MIXER_DRIVER", freeVolumeM3: 0 } });
  const bracket = await prisma.pumpReachRateBracket.create({ data: { policyId: policy.id, minReachM: 0, ratePerM3Sar: 5 } });
  await incentives.deletePumpRateBracket(form({ id: bracket.id }));
  assert.ok(await prisma.pumpReachRateBracket.findUnique({ where: { id: bracket.id } }));
  await asUser(adminId);
  await incentives.deletePumpRateBracket(form({ id: bracket.id }));
  assert.equal(await prisma.pumpReachRateBracket.count({ where: { id: bracket.id } }), 0);
});
test("simultaneous failed passwords cannot lose increments or bypass lockout", async () => {
  await Promise.all(Array.from({ length: 5 }, () => recordAccountFailure(operatorId)));
  const u = await prisma.user.findUniqueOrThrow({ where: { id: operatorId } });
  assert.equal(u.failedLoginAttempts, 5);
  assert.ok(u.lockedUntil && u.lockedUntil > new Date());
});
test("a TOTP step is single-use even across simultaneous login attempts", async () => {
  await prisma.user.update({ where: { id: adminId }, data: { totpEnabled: true, totpSecret, totpLastUsedStep: null } });
  const code = currentCode();
  const claims = await Promise.all([consumeTotpCode(adminId, totpSecret, code), consumeTotpCode(adminId, totpSecret, code)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await consumeTotpCode(adminId, totpSecret, code), false);
});
test("correct TOTP cannot bypass a disabled account or active lockout", async () => {
  await prisma.user.update({ where: { id: operatorId }, data: { totpEnabled: true, totpSecret, totpLastUsedStep: null } });
  assert.equal(await consumeTotpCode(operatorId, totpSecret, currentCode()), false);
  await prisma.user.update({ where: { id: operatorId }, data: { lockedUntil: null, status: "FROZEN" } });
  assert.equal(await consumeTotpCode(operatorId, totpSecret, currentCode()), false);
});
test("authenticated sensor endpoints reject nonfinite and impossible measurements", async () => {
  const request = (path: string, body: string) => new NextRequest(`http://localhost${path}`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body });
  for (const level of ["-1", "51", "1e309"]) assert.equal((await scada.POST(request("/api/scada/silo-reading", `{"siloId":"${siloId}","levelTons":${level}}`))).status, 400);
  assert.equal((await prisma.silo.findUniqueOrThrow({ where: { id: siloId } })).currentLevelTons, 10);
  for (const coords of ['"lat":91,"lng":0', '"lat":0,"lng":181', '"lat":1e309,"lng":0']) assert.equal((await gps.POST(request("/api/telematics/ping", `{"deviceId":"test",${coords}}`))).status, 400);
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function blockedBy(pid: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
    if (rows.length) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("No database-observed waiter for holder " + pid);
}

for (const kind of ["INVOICE", "CREDIT_NOTE"] as const) {
  // The two delegates share these fields, but their call signatures are not
  // mutually assignable, so branch per call instead of holding a union.
  function patch(id: string, data: { zatcaStatus?: string; zatcaUuid?: string; zatcaSubmittedAt?: Date }) {
    return kind === "INVOICE"
      ? prisma.invoice.updateMany({ where: { id }, data })
      : prisma.creditNote.updateMany({ where: { id }, data });
  }
  async function statusOf(id: string) {
    return kind === "INVOICE"
      ? (await prisma.invoice.findFirstOrThrow({ where: { id } })).zatcaStatus
      : (await prisma.creditNote.findFirstOrThrow({ where: { id } })).zatcaStatus;
  }
  async function document() {
    const parent = await invoice();
    const row = kind === "INVOICE" ? parent : await prisma.creditNote.create({ data: { invoiceId: parent.id, creditNoteNumber: randomUUID(), amount: 10, reason: "OTHER", issuedById: adminId } });
    const uuid = randomUUID();
    await patch(row.id, { zatcaStatus: "GENERATED", zatcaUuid: uuid });
    return { id: row.id, uuid };
  }
  const prepare = async () => ({ signedXml: "<Invoice/>", invoiceHash: "test-hash", qrCode: "test-qr", url: "https://example.invalid/clearance", authorization: "test-only" });

  test(`${kind}: atomic claim sends once; cleared cannot be changed by a competing call`, async () => {
    const d = await document(), entered = latch(), release = latch();
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; entered.resolve(); await release.promise; return Response.json({ clearanceStatus: "CLEARED" }); };
    const input = { kind, id: d.id, uuid: d.uuid, actor: { id: adminId, role: "ADMIN" }, prepare };
    const first = submitDocument(input, transport);
    try {
      await entered.promise;
      assert.equal((await submitDocument(input, async () => { calls++; throw new Error("late failure"); })).ok, false);
    } finally { release.resolve(); }
    assert.deepEqual(await first, { ok: true });
    assert.equal(calls, 1);
    await submitDocument(input, async () => { calls++; throw new Error("late failure"); });
    assert.equal(await statusOf(d.id), "CLEARED");
    assert.equal(calls, 1);
    assert.equal(await prisma.zatcaSubmissionAttempt.count({ where: { documentId: d.id } }), 1);
  });

  test(`${kind}: pre-transport failure permits a safe retry, timeout after acceptance does not`, async () => {
    const d = await document(); let calls = 0;
    const input = { kind, id: d.id, uuid: d.uuid, actor: null, prepare };
    const transport: typeof fetch = async () => { calls++; throw new Error("accepted remotely, response lost"); };
    assert.deepEqual(await submitDocument({ ...input, prepare: async () => { throw new Error("signing failed"); } }, transport), { ok: false, reason: "PREPARATION_FAILED" });
    assert.equal(calls, 0);
    await submitDocument(input, transport);
    assert.equal(await statusOf(d.id), "UNKNOWN");
    await submitDocument(input, transport);
    assert.equal(calls, 1);
    const attempts = await prisma.zatcaSubmissionAttempt.findMany({ where: { documentId: d.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(attempts.map(a => a.state), ["FAILED", "UNKNOWN"]);
    assert.equal(attempts[1].uuid, d.uuid);
    assert.equal(attempts[1].signedXml, "<Invoice/>");
  });

  test(`${kind}: stale submission and late response require reconciliation without resending`, async () => {
    const d = await document(), entered = latch(), release = latch(); let calls = 0;
    const input = { kind, id: d.id, uuid: d.uuid, actor: null, prepare };
    const first = submitDocument(input, async () => { calls++; entered.resolve(); await release.promise; return Response.json({ clearanceStatus: "CLEARED" }); });
    try {
      await entered.promise;
      await patch(d.id, { zatcaSubmittedAt: new Date(Date.now() - 600000) });
      await submitDocument(input, async () => { calls++; return Response.json({}); });
    } finally { release.resolve(); }
    assert.equal((await first).ok, false);
    assert.equal(calls, 1);
    assert.equal(await statusOf(d.id), "UNKNOWN");
  });
}

test("integration keys enforce site, capability, revocation and deliberate global access", async () => {
  const otherSilo = await prisma.silo.create({ data: { name: prefix, plantId: otherPlantId, materialType: "CEMENT", capacityTons: 50, currentLevelTons: 10 } });
  const trucks = await Promise.all([plantId, otherPlantId].map((p, i) => prisma.truck.create({ data: { plantId: p, code: `${prefix}-${i}`, gpsDeviceId: `${prefix}-${i}`, drumCapacityM3: 10 } })));
  const key = await prisma.apiKey.findUniqueOrThrow({ where: { keyHash: hashApiKey(apiKey) } });
  const request = (data: object) => new NextRequest("http://localhost/api/test", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(data) });
  try {
    assert.equal((await scada.POST(request({ siloId, levelTons: 12 }))).status, 200);
    assert.equal((await scada.POST(request({ siloId: otherSilo.id, levelTons: 12 }))).status, 404);
    assert.equal((await gps.POST(request({ deviceId: trucks[0].gpsDeviceId, lat: 1, lng: 1 }))).status, 200);
    assert.equal((await gps.POST(request({ deviceId: trucks[1].gpsDeviceId, lat: 1, lng: 1 }))).status, 404);
    await prisma.apiKey.update({ where: { id: key.id }, data: { scope: "SCADA" } });
    assert.equal((await gps.POST(request({ deviceId: trucks[0].gpsDeviceId, lat: 1, lng: 1 }))).status, 403);
    await prisma.apiKey.update({ where: { id: key.id }, data: { scope: "ALL", global: true, siteId: null } });
    assert.equal((await scada.POST(request({ siloId: otherSilo.id, levelTons: 12 }))).status, 200);
    assert.equal((await gps.POST(request({ deviceId: trucks[1].gpsDeviceId, lat: 1, lng: 1 }))).status, 200);
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    assert.equal((await scada.POST(request({ siloId, levelTons: 12 }))).status, 401);
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: null, global: false } });
    assert.equal((await scada.POST(request({ siloId, levelTons: 12 }))).status, 403);
  } finally {
    await prisma.apiKey.update({ where: { id: key.id }, data: { scope: "ALL", siteId, global: false, revokedAt: null } });
    await deleteAuditEvents({ recordId: { in: [siloId, otherSilo.id, ...trucks.map(t => t.id)] } });
    await prisma.truck.deleteMany({ where: { id: { in: trucks.map(t => t.id) } } });
    await prisma.silo.delete({ where: { id: otherSilo.id } });
  }
});

test("incentive actions reject malformed values and DB rejects bypasses", async () => {
  await asUser(adminId);
  const base = { siteId, role: "MIXER_DRIVER", freeTripsThreshold: "10", tier2Threshold: "15", tier3Threshold: "20", tier2RateSar: "1", tier3RateSar: "2", beyondRateSar: "3" };
  await incentives.updateIncentivePolicy(form(base));
  const before = await prisma.driverIncentivePolicy.findUniqueOrThrow({ where: { siteId_role: { siteId, role: base.role } } });
  for (const bad of [{ freeTripsThreshold: "-1" }, { tier2Threshold: "1.5" }, { tier2Threshold: "9" }, { tier3Threshold: "12" }, { tier2RateSar: "NaN" }, { tier3RateSar: "Infinity" }, { beyondRateSar: "-2" }, { role: "UNSUPPORTED" }]) {
    await assert.rejects(incentives.updateIncentivePolicy(form({ ...base, ...bad })));
  }
  assert.deepEqual(await prisma.driverIncentivePolicy.findUnique({ where: { id: before.id } }), before);
  for (const value of ["-1", "NaN", "Infinity"]) {
    await assert.rejects(incentives.updatePumpIncentivePolicy(form({ siteId, role: "PUMP_OPERATOR", freeVolumeM3: value })));
    await assert.rejects(incentives.setFlatVolumeRate(form({ siteId, role: "MIXER_DRIVER", ratePerM3Sar: value })));
  }
  await assert.rejects(incentives.addPumpRateBracket(form({ siteId, role: "PUMP_OPERATOR", minReachM: "40", maxReachM: "20", ratePerM3Sar: "1" })));
  await assert.rejects(prisma.driverIncentivePolicy.update({ where: { id: before.id }, data: { tier2Threshold: 1 } }));
  await assert.rejects(prisma.$executeRaw`UPDATE "DriverIncentivePolicy" SET "tier2RateSar" = 'NaN'::float8 WHERE "id" = ${before.id}`);
});

test("flat replacement has one deterministic last lock holder; concurrent overlaps cannot commit", async () => {
  await asUser(adminId);
  const role = "MIXER_DRIVER";
  await incentives.setFlatVolumeRate(form({ siteId, role, ratePerM3Sar: "1" }));
  const policy = await prisma.pumpIncentivePolicy.findUniqueOrThrow({ where: { siteId_role: { siteId, role } } });
  const held = latch(), release = latch(); let pid = 0;
  const holder = prisma.$transaction(async tx => {
    pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    await tx.$queryRaw`SELECT "id" FROM "PumpIncentivePolicy" WHERE "id" = ${policy.id} FOR UPDATE`;
    held.resolve(); await release.promise;
  }, { timeout: 15000 });
  await held.promise;
  const first = incentives.setFlatVolumeRate(form({ siteId, role, ratePerM3Sar: "2" }));
  let second: Promise<void> | undefined;
  try { await blockedBy(pid); second = incentives.setFlatVolumeRate(form({ siteId, role, ratePerM3Sar: "3" })); }
  finally { release.resolve(); }
  await Promise.all([holder, first, second]);
  const brackets = await prisma.pumpReachRateBracket.findMany({ where: { policyId: policy.id } });
  assert.equal(brackets.length, 1); assert.equal(brackets[0].ratePerM3Sar, 3);
  await prisma.pumpIncentivePolicy.deleteMany({ where: { siteId, role: "PUMP_OPERATOR" } });
  const results = await Promise.allSettled(["1", "2"].map(rate => incentives.addPumpRateBracket(form({ siteId, role: "PUMP_OPERATOR", minReachM: "10", maxReachM: "20", ratePerM3Sar: rate }))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});

for (const operation of ["recordPayment", "issueCreditNote", "markInvoiceSent", "cancelInvoice"] as const) {
  test(`${operation}: audit failure rolls back business record, status and journal; retry commits once`, async () => {
    await asUser(adminId);
    const d = await invoice(100);
    if (operation === "markInvoiceSent") await prisma.invoice.update({ where: { id: d.id }, data: { status: "DRAFT" } });
    if (operation === "cancelInvoice") await prisma.$transaction(tx => postInvoice(tx, { invoiceId: d.id, siteId, currency: "SAR", subtotal: d.subtotal, taxAmount: d.taxAmount, total: d.total }));
    const reason = { recordPayment: "PAYMENT_RECORDED", issueCreditNote: "CREDIT_NOTE_ISSUED", markInvoiceSent: "INVOICE_SENT", cancelInvoice: "INVOICE_CANCELLED" }[operation];
    const name = `audit_fail_${randomUUID().replaceAll("-", "")}`;
    const run = () => billing[operation](form({ id: d.id, invoiceId: d.id, amount: "20", reason: "OTHER" }));
    const snapshot = () => prisma.invoice.findUnique({ where: { id: d.id }, include: { payments: true, creditNotes: true, lines: true } });
    const before = await snapshot(), journals = await prisma.journalEntry.count({ where: { siteId } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."recordId" = '${d.id}' AND NEW."reasonCode" = '${reason}' THEN RAISE EXCEPTION 'Injected audit failure'; END IF; RETURN NEW; END $$`);
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "${name}" BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
      await assert.rejects(run());
      assert.deepEqual(await snapshot(), before);
      assert.equal(await prisma.journalEntry.count({ where: { siteId } }), journals);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "AuditEvent"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${name}"()`);
    }
    await run();
    assert.equal(await prisma.auditEvent.count({ where: { recordId: d.id, reasonCode: reason } }), 1);
    const saved = (await snapshot())!;
    if (operation === "recordPayment") assert.equal(saved.payments.length, 1);
    if (operation === "issueCreditNote") assert.equal(saved.creditNotes.length, 1);
    const entries = await prisma.journalEntry.findMany({ where: { siteId }, include: { lines: true } });
    for (const e of entries) assert.ok(Math.abs(e.lines.reduce((n, l) => n + l.debit - l.credit, 0)) < 0.01);
  });
}

test("reversal waits for uncommitted global JE allocation", async () => {
  const original = await invoice();
  await prisma.$transaction(tx => postInvoice(tx, { siteId, currency: "SAR", invoiceId: original.id, subtotal: 100, taxAmount: 15, total: 115 }));
  const held = latch(), release = latch(); let pid = 0;
  const normal = await invoice();
  const holder = prisma.$transaction(async tx => {
    pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    await postInvoice(tx, { siteId, currency: "SAR", invoiceId: normal.id, subtotal: 100, taxAmount: 15, total: 115 });
    held.resolve(); await release.promise;
  }, { timeout: 15000 });
  await held.promise;
  const reversal = prisma.$transaction(tx => reverseJournalEntry(tx, "Billing", original.id), { timeout: 15000 });
  try { await blockedBy(pid); } finally { release.resolve(); }
  await Promise.all([holder, reversal]);
  const entries = await prisma.journalEntry.findMany({ where: { sourceRecordId: { in: [normal.id, original.id] } } });
  assert.equal(entries.length, 3);
  assert.equal(new Set(entries.map(e => e.entryNumber)).size, 3);
});

for (const operation of ["approveLeaveRequest", "rejectLeaveRequest", "cancelLeaveRequest", "recordAttendance", "createLeaveRequest"] as const) {
  test(`${operation}: old site rejected after waiting on employee transfer`, async () => {
    await asUser(hrId);
    await prisma.employee.update({ where: { id: employeeId }, data: { plantId } });
    const leave = await prisma.leaveRequest.create({ data: { requestNumber: randomUUID(), employeeId, type: "ANNUAL", startDate: new Date("2026-10-01"), endDate: new Date("2026-10-01"), daysCount: 1, requestedById: hrId } });
    const attendance = await prisma.attendanceRecord.count({ where: { employeeId } });
    const audit = await prisma.auditEvent.count({ where: { actorId: hrId } });
    const leaves = await prisma.leaveRequest.count({ where: { employeeId } });
    const held = latch(), release = latch(); let pid = 0;
    const transfer = prisma.$transaction(async tx => {
      pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.employee.update({ where: { id: employeeId }, data: { plantId: otherPlantId } });
      held.resolve(); await release.promise;
    }, { timeout: 15000 });
    await held.promise;
    const action = hr[operation](form({ id: leave.id, employeeId, rejectionNote: "test", date: "2026-10-01", startDate: "2026-10-01", endDate: "2026-10-01", type: "ANNUAL" }));
    try { await blockedBy(pid); } finally { release.resolve(); }
    try {
      await Promise.all([transfer, action]);
      assert.equal((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: leave.id } })).status, "PENDING");
      assert.equal(await prisma.attendanceRecord.count({ where: { employeeId } }), attendance);
      assert.equal(await prisma.auditEvent.count({ where: { actorId: hrId } }), audit);
      assert.equal(await prisma.leaveRequest.count({ where: { employeeId } }), leaves);
    } finally { await prisma.employee.update({ where: { id: employeeId }, data: { plantId } }); }
  });
}
