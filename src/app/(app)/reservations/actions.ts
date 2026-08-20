"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createReservation(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const requestedVolumeM3 = Number(formData.get("requestedVolumeM3") ?? 0);
  const pourWindowStartRaw = String(formData.get("pourWindowStart") ?? "");

  if (!projectId || !mixId || !requestedVolumeM3 || !pourWindowStartRaw) return;

  // Credit check: requested project's customer credit limit must cover
  // the standing balance implied by this reservation (simplified for Phase 1
  // — a real implementation would sum outstanding invoices, not just flag).
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { customer: true } });
  const overCreditLimit = project ? project.customer.creditLimit <= 0 : false;

  const reservation = await prisma.reservation.create({
    data: {
      projectId,
      mixId,
      requestedVolumeM3,
      pourWindowStart: new Date(pourWindowStartRaw),
      status: overCreditLimit ? "ON_HOLD" : "CONFIRMED",
    },
  });

  await logAudit({
    module: "Reservations",
    recordId: reservation.id,
    afterValue: `${requestedVolumeM3} m3`,
    reasonCode: overCreditLimit ? "CREDIT_HOLD" : "RESERVATION_CREATED",
  });

  revalidatePath("/reservations");
}
