"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { getRemainingVolumeM3 } from "@/lib/reservations";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Aggregate-family materials get moisture-corrected at batch time; cement,
// admixture and water do not (this mirrors the moisture-correction rule in
// the Batchline design spec — only aggregates carry surface moisture).
const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

// A reservation's requested volume is a target, not a single truck load —
// a 200 m³ pour goes out as many partial tickets (one per truck), each
// deducting from what's left, until the reservation is fully dispatched.
export async function releaseBatchTicket(formData: FormData) {
  const reservationId = String(formData.get("reservationId") ?? "");
  const requestedVolume = Number(formData.get("volumeM3") ?? 0);
  if (!reservationId || !requestedVolume || requestedVolume <= 0) return;

  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { project: true, mix: { include: { components: true } } },
  });
  if (!reservation) return;

  const remaining = await getRemainingVolumeM3(reservationId, reservation.requestedVolumeM3);
  const volumeM3 = Math.min(requestedVolume, remaining);
  if (volumeM3 <= 0) return;

  const plantId = reservation.project.plantId;
  const ticketCount = await prisma.batchTicket.count({ where: { plantId } });
  const ticketNumber = `BT-${new Date().getFullYear()}-${String(ticketCount + 1).padStart(4, "0")}`;

  const ticket = await prisma.batchTicket.create({
    data: {
      reservationId,
      mixId: reservation.mixId,
      plantId,
      ticketNumber,
      volumeM3,
      status: "RELEASED",
      components: {
        create: reservation.mix.components.map((c) => ({
          materialId: c.materialId,
          targetMassKg: c.designMassKgPerM3 * volumeM3,
        })),
      },
    },
  });

  if (reservation.status !== "IN_PRODUCTION") {
    await prisma.reservation.update({ where: { id: reservationId }, data: { status: "IN_PRODUCTION" } });
  }

  await logAudit({
    module: "Production",
    recordId: ticket.id,
    afterValue: `${ticketNumber} — ${volumeM3} m3`,
    reasonCode: "BATCH_RELEASED",
  });

  revalidatePath("/production");
  revalidatePath("/reservations");
  redirect(`/production/${ticket.id}`);
}

export async function recordActuals(formData: FormData) {
  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!batchTicketId) return;

  const components = await prisma.batchComponentActual.findMany({
    where: { batchTicketId },
    include: { material: true },
  });

  for (const c of components) {
    const rawActual = formData.get(`actual_${c.id}`);
    const rawMoisture = formData.get(`moisture_${c.id}`);
    // A blank field means "not weighed yet", not "weighed at 0kg" — Number("")
    // is 0, which would otherwise record a real (and wildly wrong) reading.
    if (rawActual === null || rawActual === "") continue;

    const moisturePct = AGGREGATE_TYPES.has(c.material.type) && rawMoisture !== null ? Number(rawMoisture) : null;
    const enteredMass = Number(rawActual);
    if (!Number.isFinite(enteredMass)) continue;

    await prisma.batchComponentActual.update({
      where: { id: c.id },
      data: { actualMassKg: enteredMass, moisturePct },
    });
  }

  await prisma.batchTicket.update({ where: { id: batchTicketId }, data: { status: "BATCHING" } });

  await logAudit({
    module: "Production",
    recordId: batchTicketId,
    field: "actuals",
    reasonCode: "ACTUALS_RECORDED",
  });

  revalidatePath(`/production/${batchTicketId}`);
}

export async function completeBatch(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!batchTicketId) return;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id: batchTicketId },
    include: { components: { include: { material: true } }, plant: { include: { silos: true, hoppers: true } } },
  });
  if (!ticket || ticket.status === "COMPLETE") return;

  // Deduct actual (or target, if never weighed) mass from the matching silo
  // or hopper — the same inventory the Silos screen and dashboard alerts read.
  for (const c of ticket.components) {
    const massKg = c.actualMassKg ?? c.targetMassKg;
    const massTons = massKg / 1000;

    if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
      const silo = ticket.plant.silos.find((s) => s.materialType === c.material.type);
      if (silo) {
        await prisma.silo.update({
          where: { id: silo.id },
          data: { currentLevelTons: Math.max(0, silo.currentLevelTons - massTons) },
        });
      }
    } else if (AGGREGATE_TYPES.has(c.material.type)) {
      const hopper = ticket.plant.hoppers.find((h) =>
        c.material.type === "SAND" ? h.aggregateType === "SAND" : h.aggregateType.startsWith("COARSE"),
      );
      if (hopper) {
        await prisma.hopper.update({
          where: { id: hopper.id },
          data: { currentLevelTons: Math.max(0, hopper.currentLevelTons - massTons) },
        });
      }
    }
  }

  await prisma.batchTicket.update({
    where: { id: batchTicketId },
    data: { status: "COMPLETE", batchCompletedAt: new Date() },
  });

  await logAudit({
    module: "Production",
    recordId: batchTicketId,
    field: "status",
    afterValue: "COMPLETE",
    reasonCode: "BATCH_COMPLETE_INVENTORY_DEDUCTED",
  });

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath("/silos");
  revalidatePath("/");
}

export async function startTrip(formData: FormData) {
  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const truckId = String(formData.get("truckId") ?? "");
  const driverId = String(formData.get("driverId") ?? "");
  if (!batchTicketId || !truckId || !driverId) return;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id: batchTicketId },
    include: { reservation: true },
  });
  if (!ticket) return;

  // Pump crew/unit only apply when the reservation was booked for pump
  // delivery — ignore anything submitted for a chute delivery so a stray
  // pump doesn't attach itself to a trip that never used one.
  const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";
  const pumpId = isPumpDelivery ? String(formData.get("pumpId") ?? "").trim() || null : null;
  const pumpOperatorName = isPumpDelivery ? String(formData.get("pumpOperatorName") ?? "").trim() || null : null;
  const pumpAssistantName = isPumpDelivery ? String(formData.get("pumpAssistantName") ?? "").trim() || null : null;

  const trip = await prisma.trip.create({
    data: {
      batchTicketId,
      truckId,
      driverId,
      pumpId,
      pumpOperatorName,
      pumpAssistantName,
      status: "LOADING",
      batchTime: ticket.batchCompletedAt ?? new Date(),
    },
  });

  await logAudit({ module: "Fleet", recordId: trip.id, afterValue: "LOADING", reasonCode: "TRIP_STARTED" });

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath("/trips");
  redirect("/trips");
}
