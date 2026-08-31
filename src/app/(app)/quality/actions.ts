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
