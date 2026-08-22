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
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const reservationId = String(formData.get("reservationId") ?? "");
  const requestedVolume = Number(formData.get("volumeM3") ?? 0);
  // Lets the mobile field view (/operator) land back on its own ticket
  // detail page instead of the desktop one after releasing — same action,
  // same business logic, just a different "where do I keep working" target.
  const returnPrefix = String(formData.get("returnPrefix") ?? "/production");
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
  revalidatePath("/operator");
  revalidatePath("/reservations");
  redirect(`${returnPrefix}/${ticket.id}`);
}

export async function recordActuals(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

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
  revalidatePath(`/operator/ticket/${batchTicketId}`);
}

// One field, saved the instant it's entered — called from AutoSaveField's
// onBlur handler rather than waiting for the whole "Save readings" form to
// be submitted, so a reading typed on the batching floor isn't lost to a
// tab switch or an interrupted operator before that button gets pressed.
// recordActuals (above) still exists for the explicit bulk save/status-flip.
export async function recordActualField(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const componentId = String(formData.get("componentId") ?? "");
  const field = String(formData.get("field") ?? "");
  const rawValue = formData.get("value");
  if (!batchTicketId || !componentId || rawValue === null || rawValue === "") return;
  if (field !== "actual" && field !== "moisture") return;

  const value = Number(rawValue);
  if (!Number.isFinite(value)) return;

  const component = await prisma.batchComponentActual.findUnique({
    where: { id: componentId },
    include: { batchTicket: true },
  });
  if (!component || component.batchTicketId !== batchTicketId || component.batchTicket.status === "COMPLETE") return;

  await prisma.batchComponentActual.update({
    where: { id: componentId },
    data: field === "actual" ? { actualMassKg: value } : { moisturePct: value },
  });

  if (component.batchTicket.status !== "BATCHING") {
    await prisma.batchTicket.update({ where: { id: batchTicketId }, data: { status: "BATCHING" } });
  }

  await logAudit({
    module: "Production",
    recordId: batchTicketId,
    field: `component:${componentId}:${field}`,
    afterValue: String(value),
    reasonCode: "ACTUAL_FIELD_AUTOSAVED",
  });

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
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
  revalidatePath(`/operator/ticket/${batchTicketId}`);
  revalidatePath("/operator");
  revalidatePath("/silos");
  revalidatePath("/");
}

export async function startTrip(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const truckId = String(formData.get("truckId") ?? "");
  const driverId = String(formData.get("driverId") ?? "");
  // Field view sends "/operator" so an operator who just dispatched a
  // truck lands back on their own ticket list, not the desktop Trip Board.
  const returnTo = String(formData.get("returnTo") ?? "/trips");
  if (!batchTicketId || !truckId || !driverId) return;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id: batchTicketId },
    include: { reservation: true },
  });
  if (!ticket) return;

  // Re-check server-side rather than trusting the picker only offered
  // free trucks — a second tab or a stale page could still submit a truck
  // that picked up another open trip in the meantime.
  const truckBusy = await prisma.trip.findFirst({ where: { truckId, status: { not: "CLOSED" } } });
  if (truckBusy) return;

  // Pump crew/unit only apply when the reservation was booked for pump
  // delivery — ignore anything submitted for a chute delivery so a stray
  // pump doesn't attach itself to a trip that never used one.
  const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";
  const pumpId = isPumpDelivery ? String(formData.get("pumpId") ?? "").trim() || null : null;
  const pumpOperatorIdInput = isPumpDelivery ? String(formData.get("pumpOperatorId") ?? "").trim() || null : null;
  const pumpAssistantIdInput = isPumpDelivery ? String(formData.get("pumpAssistantId") ?? "").trim() || null : null;

  // Re-check server-side, same reasoning as the truck-busy check above — the
  // picker only labels a short-reach pump, it doesn't remove it from the list.
  if (isPumpDelivery && pumpId && ticket.reservation.minPumpReachM != null) {
    const pump = await prisma.pump.findUnique({ where: { id: pumpId } });
    if (pump?.reachM != null && pump.reachM < ticket.reservation.minPumpReachM) return;
  }

  // The select only ever offers this plant's active roster — re-verify the
  // submitted id against it server-side rather than trusting the picker,
  // same reasoning as the truck-busy check above. A stray id (stale page,
  // crew member deactivated meanwhile) is dropped rather than trusted.
  let pumpOperatorId: string | null = null;
  let pumpAssistantId: string | null = null;
  let pumpOperatorName: string | null = null;
  let pumpAssistantName: string | null = null;
  if (isPumpDelivery && (pumpOperatorIdInput || pumpAssistantIdInput)) {
    const crew = await prisma.pumpCrewMember.findMany({ where: { plantId: ticket.plantId, status: "ACTIVE" } });
    if (pumpOperatorIdInput) {
      const match = crew.find((c) => c.id === pumpOperatorIdInput && c.role === "OPERATOR");
      if (match) {
        pumpOperatorId = match.id;
        pumpOperatorName = match.name;
      }
    }
    if (pumpAssistantIdInput) {
      const match = crew.find((c) => c.id === pumpAssistantIdInput && c.role === "HELPER");
      if (match) {
        pumpAssistantId = match.id;
        pumpAssistantName = match.name;
      }
    }
  }

  const trip = await prisma.trip.create({
    data: {
      batchTicketId,
      truckId,
      driverId,
      pumpId,
      pumpOperatorName,
      pumpAssistantName,
      pumpOperatorId,
      pumpAssistantId,
      status: "LOADING",
      batchTime: ticket.batchCompletedAt ?? new Date(),
    },
  });

  await logAudit({ module: "Fleet", recordId: trip.id, afterValue: "LOADING", reasonCode: "TRIP_STARTED" });

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath("/operator");
  revalidatePath("/trips");
  redirect(returnTo);
}

// A truck, driver, or pump crew name picked wrong at dispatch shouldn't
// need the trip cancelled and re-started — correctable up until it actually
// leaves the yard (status LOADING), same "pre-dispatch only" boundary the
// reservation editor uses for its own fields.
export async function updateTripAssignment(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const tripId = String(formData.get("tripId") ?? "");
  const truckId = String(formData.get("truckId") ?? "");
  const driverId = String(formData.get("driverId") ?? "");
  if (!tripId || !truckId || !driverId) return;

  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: { batchTicket: { include: { reservation: true } } },
  });
  if (!trip || trip.status !== "LOADING") return;

  const truckBusy = await prisma.trip.findFirst({
    where: { truckId, status: { not: "CLOSED" }, id: { not: tripId } },
  });
  if (truckBusy) return;

  const isPumpDelivery = trip.batchTicket.reservation.deliveryMethod === "PUMP";
  const pumpId = isPumpDelivery ? String(formData.get("pumpId") ?? "").trim() || null : null;
  const pumpOperatorIdInput = isPumpDelivery ? String(formData.get("pumpOperatorId") ?? "").trim() || null : null;
  const pumpAssistantIdInput = isPumpDelivery ? String(formData.get("pumpAssistantId") ?? "").trim() || null : null;

  if (isPumpDelivery && pumpId && trip.batchTicket.reservation.minPumpReachM != null) {
    const pump = await prisma.pump.findUnique({ where: { id: pumpId } });
    if (pump?.reachM != null && pump.reachM < trip.batchTicket.reservation.minPumpReachM) return;
  }

  let pumpOperatorId: string | null = null;
  let pumpAssistantId: string | null = null;
  let pumpOperatorName: string | null = null;
  let pumpAssistantName: string | null = null;
  if (isPumpDelivery && (pumpOperatorIdInput || pumpAssistantIdInput)) {
    const crew = await prisma.pumpCrewMember.findMany({ where: { plantId: trip.batchTicket.plantId, status: "ACTIVE" } });
    if (pumpOperatorIdInput) {
      const match = crew.find((c) => c.id === pumpOperatorIdInput && c.role === "OPERATOR");
      if (match) {
        pumpOperatorId = match.id;
        pumpOperatorName = match.name;
      }
    }
    if (pumpAssistantIdInput) {
      const match = crew.find((c) => c.id === pumpAssistantIdInput && c.role === "HELPER");
      if (match) {
        pumpAssistantId = match.id;
        pumpAssistantName = match.name;
      }
    }
  }

  await prisma.trip.update({
    where: { id: tripId },
    data: { truckId, driverId, pumpId, pumpOperatorId, pumpOperatorName, pumpAssistantId, pumpAssistantName },
  });

  await logAudit({ module: "Fleet", recordId: tripId, afterValue: `${truckId}/${driverId}`, reasonCode: "TRIP_ASSIGNMENT_UPDATED" });

  revalidatePath(`/production/${trip.batchTicketId}`);
  revalidatePath("/operator");
  revalidatePath("/trips");
}
