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

const prefix = `REVIEW-${randomUUID()}`;
let siteId: string, otherSiteId: string, plantId: string, otherPlantId: string;
let customerId: string, adminId: string, operatorId: string, hrId: string;
let employeeId: string, otherEmployeeId: string, siloId: string;
const invoiceIds: string[] = [];
let initialAccountIds: string[] = [];
const apiKey = randomUUID(); // disposable test credential only

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
async function asUser(userId: string) {
  const session = await prisma.session.create({ data: { userId, expiresAt: new Date(Date.now() + 60000) } });
  cookieValues.set("batchline_session", session.id);
}
async function invoice(total = 115) {
  const row = await prisma.invoice.create({ data: {
    invoiceNumber: `${prefix}-${invoiceIds.length}`, customerId, plantId, currency: "SAR",
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
  await prisma.apiKey.create({ data: { label: prefix, keyHash: hashApiKey(apiKey), keyPrefix: "test", scope: "ALL", createdById: adminId } });
});

after(async () => {
  const users = [adminId, operatorId, hrId].filter(Boolean);
  const sites = [siteId, otherSiteId].filter(Boolean);
  const accounts = await prisma.journalLine.findMany({ where: { siteId: { in: sites } }, select: { accountId: true } });
  await prisma.auditEvent.deleteMany({ where: { actorId: { in: users } } });
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
  const data = form({ siteId: otherSiteId, role: "DRIVER", ratePerM3Sar: "5" });
  await incentives.updateIncentivePolicy(data);
  await incentives.updatePumpIncentivePolicy(data);
  await incentives.setFlatVolumeRate(data);
  await incentives.addPumpRateBracket(data);
  assert.equal(await prisma.driverIncentivePolicy.count({ where: { siteId: otherSiteId } }), 0);
  assert.equal(await prisma.pumpIncentivePolicy.count({ where: { siteId: otherSiteId } }), 0);
  const policy = await prisma.pumpIncentivePolicy.create({ data: { siteId: otherSiteId, role: "DRIVER", freeVolumeM3: 0 } });
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
