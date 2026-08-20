"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

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
