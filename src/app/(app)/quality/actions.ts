"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isPlantInScope } from "@/lib/siteScope";
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
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

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
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

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

  revalidatePath("/quality");
}

export async function createCertificate(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

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
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

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
  requireRole(user, ["QUALITY_SUPERVISOR", "ADMIN"]);

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
