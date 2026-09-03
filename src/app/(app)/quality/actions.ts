"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isPlantInScope } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { notifyRoles } from "@/lib/notify";
import { revalidatePath } from "next/cache";

async function tripInScope(tripId: string, siteId: string | null): Promise<boolean> {
  if (siteId === null) return true;
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { batchTicket: { select: { plantId: true } } } });
  if (!trip) return false;
  return isPlantInScope(trip.batchTicket.plantId, siteId);
}

async function testBatchInScope(testBatchId: string, siteId: string | null): Promise<boolean> {
  if (siteId === null) return true;
  const tb = await prisma.testBatch.findUnique({ where: { id: testBatchId }, select: { trip: { select: { batchTicket: { select: { plantId: true } } } } } });
  if (!tb) return false;
  return isPlantInScope(tb.trip.batchTicket.plantId, siteId);
}

async function wasteMemoInScope(wasteMemoId: string, siteId: string | null): Promise<boolean> {
  if (siteId === null) return true;
  const memo = await prisma.wasteIncidentMemo.findUnique({ where: { id: wasteMemoId }, select: { batchTicket: { select: { plantId: true } } } });
  if (!memo) return false;
  return isPlantInScope(memo.batchTicket.plantId, siteId);
}

export async function createTestBatch(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "createTestBatch");

  const tripId = String(formData.get("tripId") ?? "");
  const sampleType = String(formData.get("sampleType") ?? "CYLINDER");
  const slumpMeasuredMm = Number(formData.get("slumpMeasuredMm") ?? 0) || null;
  const airContentPct = Number(formData.get("airContentPct") ?? 0) || null;
  const concreteTempC = Number(formData.get("concreteTempC") ?? 0) || null;
  const sampledById = String(formData.get("sampledById") ?? "") || null;

  if (!tripId) return;
  if (!(await tripInScope(tripId, effectiveSiteId(user)))) return;

  const testBatch = await prisma.testBatch.create({
    data: { tripId, sampleType, slumpMeasuredMm, airContentPct, concreteTempC, sampledById },
  });

  await logAudit({
    module: "Quality",
    recordId: testBatch.id,
    afterValue: `${sampleType} @ trip ${tripId}`,
    reasonCode: "TEST_BATCH_SAMPLED",
  });

  revalidatePath("/quality");
}

export async function addLabResult(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "addLabResult");

  const testBatchId = String(formData.get("testBatchId") ?? "");
  const ageDays = Number(formData.get("ageDays") ?? 28);
  const breakStrengthMpa = Number(formData.get("breakStrengthMpa") ?? 0);
  const targetStrengthMpa = Number(formData.get("targetStrengthMpa") ?? 0);

  if (!testBatchId || !breakStrengthMpa || !targetStrengthMpa) return;
  if (!(await testBatchInScope(testBatchId, effectiveSiteId(user)))) return;

  const passFail = breakStrengthMpa >= targetStrengthMpa ? "PASS" : "FAIL";

  const result = await prisma.labResult.create({
    data: { testBatchId, ageDays, breakStrengthMpa, targetStrengthMpa, passFail },
  });

  await logAudit({
    module: "Quality",
    recordId: result.id,
    afterValue: `${breakStrengthMpa} MPa @ ${ageDays}d — ${passFail}`,
    reasonCode: "LAB_RESULT_RECORDED",
  });

  // A FAIL used to just sit there as a red chip with nobody assigned to
  // explain why or fix it — auto-opening a CAPA the instant it's recorded
  // closes that gap the same way a low silo now auto-opens a
  // MaterialRequisition (see completeBatch in production/actions.ts):
  // detection is automatic, the actual write-up (root cause, corrective/
  // preventive action) still needs a person, via saveCapaRecord below.
  if (passFail === "FAIL") {
    const capa = await withSequentialNumber(
      "CAPA",
      () => prisma.capaRecord.count(),
      (capaNumber) => prisma.capaRecord.create({ data: { capaNumber, labResultId: result.id } }),
    );
    await logAudit({ module: "Quality", recordId: capa.id, afterValue: capa.capaNumber, reasonCode: "CAPA_AUTO_OPENED" });
    await notifyRoles(["QUALITY_SUPERVISOR", "ADMIN"], {
      title: capa.capaNumber,
      body: `Lab result failed — ${breakStrengthMpa} / ${targetStrengthMpa} MPa @ ${ageDays}d`,
      link: "/quality",
      module: "Quality",
    });
  }

  revalidatePath("/quality");
}

// Fills in the write-up (root cause, corrective/preventive action,
// responsible person, due date) — bumps status to IN_PROGRESS the first
// time this is saved from OPEN, same "started work on it" signal
// startMaintenanceOrder/startMaintenanceTicket already give elsewhere.
export async function saveCapaRecord(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "quality", "saveCapaRecord");

  const id = String(formData.get("id") ?? "");
  const rootCause = String(formData.get("rootCause") ?? "").trim() || null;
  const correctiveAction = String(formData.get("correctiveAction") ?? "").trim() || null;
  const preventiveAction = String(formData.get("preventiveAction") ?? "").trim() || null;
  const responsibleId = String(formData.get("responsibleId") ?? "") || null;
  const dueDateRaw = String(formData.get("dueDate") ?? "");
  if (!id) return;

  const capa = await prisma.capaRecord.findUnique({ where: { id } });
  if (!capa || capa.status === "CLOSED") return;

  await prisma.capaRecord.update({
    where: { id },
    data: {
      rootCause,
      correctiveAction,
      preventiveAction,
      responsibleId,
      dueDate: dueDateRaw ? new Date(dueDateRaw) : null,
      status: capa.status === "OPEN" ? "IN_PROGRESS" : capa.status,
    },
  });

  await logAudit({ module: "Quality", recordId: id, reasonCode: "CAPA_UPDATED" });
  revalidatePath("/quality");
}

// Requires the write-up to actually exist first — same "the reason must
// be written" precedent as WasteIncidentMemo.approvalNote — rather than
// letting a FAIL get closed out with nothing on file about why it
// happened or what was done about it.
export async function closeCapaRecord(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "quality", "closeCapaRecord");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const capa = await prisma.capaRecord.findUnique({ where: { id } });
  if (!capa || capa.status === "CLOSED" || !capa.rootCause || !capa.correctiveAction) return;

  await prisma.capaRecord.update({
    where: { id },
    data: { status: "CLOSED", closedAt: new Date(), closedById: actor!.id },
  });

  await logAudit({ module: "Quality", recordId: id, afterValue: "CLOSED", reasonCode: "CAPA_CLOSED" });
  revalidatePath("/quality");
}

export async function createCertificate(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "createCertificate");

  const mixId = String(formData.get("mixId") ?? "");
  const standardRef = String(formData.get("standardRef") ?? "").trim();
  const issuedDateRaw = String(formData.get("issuedDate") ?? "");
  const expiryDateRaw = String(formData.get("expiryDate") ?? "");
  const issuingBody = String(formData.get("issuingBody") ?? "").trim();
  const documentUrl = String(formData.get("documentUrl") ?? "").trim() || null;

  if (!mixId || !standardRef || !issuedDateRaw || !expiryDateRaw || !issuingBody) return;

  const cert = await prisma.complianceCertificate.create({
    data: {
      mixId,
      standardRef,
      issuingBody,
      documentUrl,
      issuedDate: new Date(issuedDateRaw),
      expiryDate: new Date(expiryDateRaw),
    },
  });

  await logAudit({
    module: "Quality",
    recordId: cert.id,
    afterValue: `${standardRef} — ${issuingBody}`,
    reasonCode: "CERTIFICATE_ISSUED",
  });

  revalidatePath("/quality");
}

export async function updateCertificate(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "updateCertificate");

  const id = String(formData.get("id") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const standardRef = String(formData.get("standardRef") ?? "").trim();
  const issuedDateRaw = String(formData.get("issuedDate") ?? "");
  const expiryDateRaw = String(formData.get("expiryDate") ?? "");
  const issuingBody = String(formData.get("issuingBody") ?? "").trim();
  const documentUrl = String(formData.get("documentUrl") ?? "").trim() || null;

  if (!id || !mixId || !standardRef || !issuedDateRaw || !expiryDateRaw || !issuingBody) return;

  await prisma.complianceCertificate.update({
    where: { id },
    data: {
      mixId,
      standardRef,
      issuingBody,
      documentUrl,
      issuedDate: new Date(issuedDateRaw),
      expiryDate: new Date(expiryDateRaw),
    },
  });

  await logAudit({
    module: "Quality",
    recordId: id,
    afterValue: `${standardRef} — ${issuingBody}`,
    reasonCode: "CERTIFICATE_UPDATED",
  });

  revalidatePath("/quality");
}

// Signs off on an auto-created WasteIncidentMemo (see closeTripWithReturn
// in trips/actions.ts, which creates one whenever a load is closed with
// reasonCode QUALITY_REJECTED) — a real state transition distinct from the
// return-billing reduction, which already applied regardless of this
// approval.
export async function approveWasteMemo(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "approveWasteMemo");

  const id = String(formData.get("id") ?? "");
  // A written finding is mandatory — reasonCode alone is just the coarse
  // category picked at return-close time, not an actual QA explanation of
  // what was wrong with the load. No note, no approval.
  const approvalNote = String(formData.get("approvalNote") ?? "").trim();
  if (!id || !approvalNote) return;
  if (!(await wasteMemoInScope(id, effectiveSiteId(user)))) return;

  const existing = await prisma.wasteIncidentMemo.findUnique({ where: { id } });
  if (!existing || existing.status !== "PENDING") return;

  const memo = await prisma.wasteIncidentMemo.update({
    where: { id },
    data: { status: "APPROVED", approvalNote, approvedAt: new Date(), approvedById: user!.id },
  });

  await logAudit({
    module: "Quality",
    recordId: id,
    afterValue: `${memo.wastedVolumeM3} m3 — ${memo.reasonCode} — ${approvalNote}`,
    reasonCode: "WASTE_MEMO_APPROVED",
  });

  revalidatePath("/quality");
  revalidatePath(`/production/${memo.batchTicketId}`);
}

// Backfills a written finding onto a memo that was approved before that
// requirement existed (approveWasteMemo above now refuses to approve
// without one going forward). Deliberately only fills a genuinely missing
// note rather than allowing an edit — once a finding is on file it's part
// of the audit record, not something to quietly rewrite later.
export async function recordWasteMemoNote(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "recordWasteMemoNote");

  const id = String(formData.get("id") ?? "");
  const approvalNote = String(formData.get("approvalNote") ?? "").trim();
  if (!id || !approvalNote) return;
  if (!(await wasteMemoInScope(id, effectiveSiteId(user)))) return;

  const existing = await prisma.wasteIncidentMemo.findUnique({ where: { id } });
  if (!existing || existing.status !== "APPROVED" || existing.approvalNote) return;

  const memo = await prisma.wasteIncidentMemo.update({ where: { id }, data: { approvalNote } });

  await logAudit({
    module: "Quality",
    recordId: id,
    afterValue: approvalNote,
    reasonCode: "WASTE_MEMO_NOTE_BACKFILLED",
  });

  revalidatePath("/quality");
  revalidatePath(`/production/${memo.batchTicketId}`);
}

// ---------------------------------------------------------------------------
// Calibration — see the schema section comment for why this is its own
// registry, separate from the Truck/Pump/Silo/Hopper equipment one.
// ---------------------------------------------------------------------------

export async function createInstrument(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "createInstrument");

  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const manufacturer = String(formData.get("manufacturer") ?? "").trim() || null;
  const model = String(formData.get("model") ?? "").trim() || null;
  const serialNumber = String(formData.get("serialNumber") ?? "").trim() || null;
  const location = String(formData.get("location") ?? "").trim() || null;
  const siteId = String(formData.get("siteId") ?? "") || null;
  const calibrationIntervalMonths = Number(formData.get("calibrationIntervalMonths") ?? 0) || null;
  if (!code || !name) return;

  const instrument = await prisma.calibratedInstrument.create({
    data: { code, name, manufacturer, model, serialNumber, location, siteId, calibrationIntervalMonths },
  });

  await logAudit({ module: "Quality", recordId: instrument.id, afterValue: `${code} — ${name}`, reasonCode: "INSTRUMENT_REGISTERED" });
  revalidatePath("/quality");
}

// Logs a calibration event and moves the instrument's status to match —
// OUT_OF_TOLERANCE withdraws it (the real calibration procedure requires
// segregating/withdrawing an out-of-tolerance instrument from use), and a
// later PASSED reinstates it automatically, so nobody needs a separate
// "bring it back" action once it's been recalibrated and passes.
export async function recordCalibration(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "recordCalibration");

  const instrumentId = String(formData.get("instrumentId") ?? "");
  const calibratedAtRaw = String(formData.get("calibratedAt") ?? "");
  const nextDueAtRaw = String(formData.get("nextDueAt") ?? "");
  const method = String(formData.get("method") ?? "").trim() || null;
  const criteria = String(formData.get("criteria") ?? "").trim() || null;
  const measurementResult = String(formData.get("measurementResult") ?? "").trim() || null;
  const result = String(formData.get("result") ?? "");
  const certificateAvailable = formData.get("certificateAvailable") === "on";
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!instrumentId || !calibratedAtRaw || !nextDueAtRaw || !result) return;

  const instrument = await prisma.calibratedInstrument.findUnique({ where: { id: instrumentId } });
  if (!instrument) return;

  const record = await withSequentialNumber(
    "CAL",
    () => prisma.calibrationRecord.count(),
    (recordNumber) =>
      prisma.calibrationRecord.create({
        data: {
          recordNumber,
          instrumentId,
          calibratedAt: new Date(calibratedAtRaw),
          nextDueAt: new Date(nextDueAtRaw),
          method,
          criteria,
          measurementResult,
          result,
          certificateAvailable,
          notes,
          calibratedById: user!.id,
        },
      }),
  );

  if (instrument.status !== "OUT_OF_SERVICE") {
    await prisma.calibratedInstrument.update({
      where: { id: instrumentId },
      data: { status: result === "OUT_OF_TOLERANCE" ? "WITHDRAWN" : "ACTIVE" },
    });
  }

  await logAudit({
    module: "Quality",
    recordId: record.id,
    afterValue: `${record.recordNumber} — ${instrument.name} — ${result}`,
    reasonCode: "CALIBRATION_RECORDED",
  });
  revalidatePath("/quality");
}

// ---------------------------------------------------------------------------
// Internal audits — ISO 9001:2015 clause 9.2. See the schema section
// comment for why findings are their own model rather than reusing
// CapaRecord.
// ---------------------------------------------------------------------------

export async function scheduleInternalAudit(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "scheduleInternalAudit");

  const department = String(formData.get("department") ?? "").trim();
  const processAudited = String(formData.get("processAudited") ?? "").trim() || null;
  const isoClauseScope = String(formData.get("isoClauseScope") ?? "").trim() || null;
  const auditorId = String(formData.get("auditorId") ?? "");
  const scheduledDateRaw = String(formData.get("scheduledDate") ?? "");
  if (!department || !auditorId || !scheduledDateRaw) return;

  const audit = await withSequentialNumber(
    "AUD",
    () => prisma.internalAudit.count(),
    (auditNumber) =>
      prisma.internalAudit.create({
        data: { auditNumber, department, processAudited, isoClauseScope, auditorId, scheduledDate: new Date(scheduledDateRaw), createdById: user!.id },
      }),
  );

  await logAudit({ module: "Quality", recordId: audit.id, afterValue: `${audit.auditNumber} — ${department}`, reasonCode: "INTERNAL_AUDIT_SCHEDULED" });
  revalidatePath("/quality");
}

export async function startInternalAudit(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "startInternalAudit");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const audit = await prisma.internalAudit.findUnique({ where: { id } });
  if (!audit || audit.status !== "SCHEDULED") return;

  await prisma.internalAudit.update({ where: { id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
  await logAudit({ module: "Quality", recordId: id, afterValue: "IN_PROGRESS", reasonCode: "INTERNAL_AUDIT_STARTED" });
  revalidatePath(`/quality/audits/${id}`);
  revalidatePath("/quality");
}

// Requires the actual write-up (observations) to exist first — same "no
// note, no close" precedent as WasteIncidentMemo/CapaRecord elsewhere in
// this module — an audit marked complete with nothing recorded about
// what was found isn't a real audit record.
export async function completeInternalAudit(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "completeInternalAudit");

  const id = String(formData.get("id") ?? "");
  const observations = String(formData.get("observations") ?? "").trim();
  const areasFoundGood = String(formData.get("areasFoundGood") ?? "").trim() || null;
  if (!id || !observations) return;

  const audit = await prisma.internalAudit.findUnique({ where: { id } });
  if (!audit || audit.status === "COMPLETED" || audit.status === "CANCELLED") return;

  await prisma.internalAudit.update({
    where: { id },
    data: { status: "COMPLETED", completedAt: new Date(), observations, areasFoundGood },
  });
  await logAudit({ module: "Quality", recordId: id, afterValue: "COMPLETED", reasonCode: "INTERNAL_AUDIT_COMPLETED" });
  revalidatePath(`/quality/audits/${id}`);
  revalidatePath("/quality");
}

export async function addAuditFinding(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "addAuditFinding");

  const auditId = String(formData.get("auditId") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const classification = String(formData.get("classification") ?? "");
  const isoClauseRef = String(formData.get("isoClauseRef") ?? "").trim() || null;
  if (!auditId || !description || !classification) return;

  const audit = await prisma.internalAudit.findUnique({ where: { id: auditId } });
  if (!audit) return;

  const finding = await withSequentialNumber(
    "AF",
    () => prisma.internalAuditFinding.count(),
    (findingNumber) => prisma.internalAuditFinding.create({ data: { findingNumber, auditId, description, classification, isoClauseRef } }),
  );

  await logAudit({ module: "Quality", recordId: finding.id, afterValue: `${finding.findingNumber} — ${classification}`, reasonCode: "AUDIT_FINDING_ADDED" });
  revalidatePath(`/quality/audits/${auditId}`);
}

// Fills in the write-up (corrective action, responsible person, due
// date) — bumps status to IN_PROGRESS the first time this is saved from
// OPEN, same signal saveCapaRecord already gives.
export async function saveAuditFinding(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "quality", "saveAuditFinding");

  const id = String(formData.get("id") ?? "");
  const correctiveAction = String(formData.get("correctiveAction") ?? "").trim() || null;
  const responsibleId = String(formData.get("responsibleId") ?? "") || null;
  const dueDateRaw = String(formData.get("dueDate") ?? "");
  if (!id) return;

  const finding = await prisma.internalAuditFinding.findUnique({ where: { id } });
  if (!finding || finding.status === "CLOSED") return;

  await prisma.internalAuditFinding.update({
    where: { id },
    data: {
      correctiveAction,
      responsibleId,
      dueDate: dueDateRaw ? new Date(dueDateRaw) : null,
      status: finding.status === "OPEN" ? "IN_PROGRESS" : finding.status,
    },
  });

  await logAudit({ module: "Quality", recordId: id, reasonCode: "AUDIT_FINDING_UPDATED" });
  revalidatePath(`/quality/audits/${finding.auditId}`);
}

export async function closeAuditFinding(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "quality", "closeAuditFinding");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const finding = await prisma.internalAuditFinding.findUnique({ where: { id } });
  if (!finding || finding.status === "CLOSED" || !finding.correctiveAction) return;

  await prisma.internalAuditFinding.update({
    where: { id },
    data: { status: "CLOSED", closedAt: new Date(), closedById: actor!.id },
  });

  await logAudit({ module: "Quality", recordId: id, afterValue: "CLOSED", reasonCode: "AUDIT_FINDING_CLOSED" });
  revalidatePath(`/quality/audits/${finding.auditId}`);
}

// ---------------------------------------------------------------------------
// Document control — ISO 9001:2015 clause 7.5. See the schema section
// comment for why this is a plain current-revision registry rather than
// a version-history chain.
// ---------------------------------------------------------------------------

export async function createControlledDocument(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "createControlledDocument");

  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "");
  const owningDepartment = String(formData.get("owningDepartment") ?? "").trim() || null;
  const revisionNumber = String(formData.get("revisionNumber") ?? "").trim();
  const releaseDateRaw = String(formData.get("releaseDate") ?? "");
  const documentUrl = String(formData.get("documentUrl") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!code || !name || !category || !revisionNumber || !releaseDateRaw) return;

  const doc = await prisma.controlledDocument.create({
    data: { code, name, category, owningDepartment, revisionNumber, releaseDate: new Date(releaseDateRaw), documentUrl, notes, createdById: user!.id },
  });

  await logAudit({ module: "Quality", recordId: doc.id, afterValue: `${code} — ${name} (rev ${revisionNumber})`, reasonCode: "CONTROLLED_DOCUMENT_CREATED" });
  revalidatePath("/quality");
}

export async function updateControlledDocument(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "updateControlledDocument");

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "");
  const owningDepartment = String(formData.get("owningDepartment") ?? "").trim() || null;
  const revisionNumber = String(formData.get("revisionNumber") ?? "").trim();
  const releaseDateRaw = String(formData.get("releaseDate") ?? "");
  const documentUrl = String(formData.get("documentUrl") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!id || !name || !category || !revisionNumber || !releaseDateRaw) return;

  await prisma.controlledDocument.update({
    where: { id },
    data: { name, category, owningDepartment, revisionNumber, releaseDate: new Date(releaseDateRaw), documentUrl, notes },
  });

  await logAudit({ module: "Quality", recordId: id, afterValue: `rev ${revisionNumber}`, reasonCode: "CONTROLLED_DOCUMENT_REVISED" });
  revalidatePath("/quality");
}

export async function setControlledDocumentStatus(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "setControlledDocumentStatus");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || (status !== "ACTIVE" && status !== "OBSOLETE")) return;

  await prisma.controlledDocument.update({ where: { id }, data: { status } });
  await logAudit({ module: "Quality", recordId: id, afterValue: status, reasonCode: "CONTROLLED_DOCUMENT_STATUS_CHANGED" });
  revalidatePath("/quality");
}

// ---------------------------------------------------------------------------
// Employee training records — ISO 9001:2015 clause 7.2. See the schema
// section comment for why this is one session with many attendees,
// mirroring the real attendance-roster form directly.
// ---------------------------------------------------------------------------

export async function createTrainingSession(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "createTrainingSession");

  const programName = String(formData.get("programName") ?? "").trim();
  const trainerName = String(formData.get("trainerName") ?? "").trim() || null;
  const location = String(formData.get("location") ?? "").trim() || null;
  const startDateRaw = String(formData.get("startDate") ?? "");
  const endDateRaw = String(formData.get("endDate") ?? "");
  const durationHours = Number(formData.get("durationHours") ?? 0) || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!programName || !startDateRaw) return;

  const session = await withSequentialNumber(
    "TRN",
    () => prisma.trainingSession.count(),
    (sessionNumber) =>
      prisma.trainingSession.create({
        data: {
          sessionNumber,
          programName,
          trainerName,
          location,
          startDate: new Date(startDateRaw),
          endDate: endDateRaw ? new Date(endDateRaw) : null,
          durationHours,
          notes,
          createdById: user!.id,
        },
      }),
  );

  await logAudit({ module: "Quality", recordId: session.id, afterValue: `${session.sessionNumber} — ${programName}`, reasonCode: "TRAINING_SESSION_CREATED" });
  revalidatePath("/quality");
}

export async function addTrainingAttendee(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "addTrainingAttendee");

  const sessionId = String(formData.get("sessionId") ?? "");
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!sessionId || !employeeId) return;

  const session = await prisma.trainingSession.findUnique({ where: { id: sessionId } });
  if (!session) return;

  const existing = await prisma.trainingAttendance.findUnique({ where: { sessionId_employeeId: { sessionId, employeeId } } });
  if (existing) return;

  const attendance = await prisma.trainingAttendance.create({ data: { sessionId, employeeId } });

  await logAudit({ module: "Quality", recordId: attendance.id, afterValue: `${session.sessionNumber} — ${employeeId}`, reasonCode: "TRAINING_ATTENDEE_ADDED" });
  revalidatePath("/quality");
}

export async function removeTrainingAttendee(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "quality", "removeTrainingAttendee");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const attendance = await prisma.trainingAttendance.findUnique({ where: { id } });
  if (!attendance) return;

  await prisma.trainingAttendance.delete({ where: { id } });
  await logAudit({ module: "Quality", recordId: id, reasonCode: "TRAINING_ATTENDEE_REMOVED" });
  revalidatePath("/quality");
}
