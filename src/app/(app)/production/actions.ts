"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole, requireActionPermission } from "@/lib/session";
import { getRemainingVolumeM3, isReservationApproved } from "@/lib/reservations";
import { effectiveSiteId, isPlantActive, isPlantInScope, isSiteInScope } from "@/lib/siteScope";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Aggregate-family materials get moisture-corrected at batch time; cement,
// admixture and water do not (this mirrors the moisture-correction rule in
// the Batchline design spec — only aggregates carry surface moisture).
const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

// A hopper's aggregate/water heap, or a cement silo, can be shared by
// every production line at one SITE (Hopper/Silo.sharedAcrossPlants) —
// prefer a match at the ticket's own line, but fall back to a shared one
// at the SAME site rather than silently finding nothing. Deliberately
// scoped by siteId, not global: two unrelated sites' stock must never
// cross-contaminate just because both happen to have a hopper flagged
// shared.
async function findMatchingHopper(plantId: string, siteId: string, aggregateTypeWhere: { equals: string } | { startsWith: string }) {
  const own = await prisma.hopper.findFirst({ where: { plantId, aggregateType: aggregateTypeWhere } });
  if (own) return own;
  return prisma.hopper.findFirst({ where: { sharedAcrossPlants: true, aggregateType: aggregateTypeWhere, plant: { siteId } } });
}

async function findMatchingSilo(plantId: string, siteId: string, materialType: string) {
  const own = await prisma.silo.findFirst({ where: { plantId, materialType } });
  if (own) return own;
  return prisma.silo.findFirst({ where: { sharedAcrossPlants: true, materialType, plant: { siteId } } });
}

// A single mixer truck load, never exceeded regardless of how much of the
// reservation remains — the same ceiling the release form's own input
// max enforces client-side (production/page.tsx); this is the real gate.
const MAX_LOAD_M3 = 15;

// The actual ticket-creation logic shared by releaseBatchTicket (a planned,
// pre-approved reservation) and createManualRelease (a walk-in sale that
// self-approves on the way in) — pulled out so neither has to duplicate
// the ticket-number/component-snapshot logic. Doesn't redirect; each
// caller does that itself since they land somewhere different.
//
// plantId here is the STATION — the reservation itself only committed to
// a plant/site (see the Reservation model comment); which station within
// it actually produces this ticket is decided right here, at release
// time, by whoever's releasing it. The caller is responsible for
// validating plantId belongs to reservation.siteId and is ACTIVE before
// calling this.
async function releaseTicketForReservation(reservationId: string, requestedVolume: number, plantId: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { mix: { include: { components: true } } },
  });
  if (!reservation) return null;

  const remaining = await getRemainingVolumeM3(reservationId, reservation.requestedVolumeM3);
  const volumeM3 = Math.min(requestedVolume, remaining);
  if (volumeM3 <= 0) return null;

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

  return ticket;
}

// A reservation's requested volume is a target, not a single truck load —
// a 200 m³ pour goes out as many partial tickets (one per truck), each
// deducting from what's left, until the reservation is fully dispatched.
// Which STATION each of those tickets actually comes from is picked right
// here, per release — not fixed once on the reservation — since capacity
// at a specific line can genuinely differ truck to truck.
export async function releaseBatchTicket(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "release");

  const reservationId = String(formData.get("reservationId") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const requestedVolume = Number(formData.get("volumeM3") ?? 0);
  // Lets the mobile field view (/operator) land back on its own ticket
  // detail page instead of the desktop one after releasing — same action,
  // same business logic, just a different "where do I keep working" target.
  const returnPrefix = String(formData.get("returnPrefix") ?? "/production");
  if (!reservationId || !plantId || !requestedVolume || requestedVolume <= 0) return;
  if (requestedVolume > MAX_LOAD_M3) return;

  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) return;
  // Re-check server-side — the picker on /production only ever lists
  // reservations that already cleared both sign-offs, but a stale page
  // or a second tab shouldn't be able to release against one that hasn't.
  if (!isReservationApproved(reservation)) return;
  const siteId = effectiveSiteId(user!);
  if (siteId !== null && reservation.siteId !== siteId) return;
  // The chosen station must actually belong to this reservation's plant
  // (site), and must be active — same guards used everywhere else a
  // station gets picked for something new.
  if (!(await isPlantInScope(plantId, reservation.siteId))) return;
  if (!(await isPlantActive(plantId))) return;

  const ticket = await releaseTicketForReservation(reservationId, requestedVolume, plantId);
  if (!ticket) return;

  revalidatePath("/production");
  revalidatePath("/operator");
  revalidatePath("/reservations");
  redirect(`${returnPrefix}/${ticket.id}`);
}

// A walk-in sale — a customer at the yard with no prior booking. Creates
// the reservation and releases the first ticket against it in one step,
// self-approved by the operator submitting it rather than going through
// the two-stage sign-off gate: that gate exists for a planned pour that
// hasn't happened yet, not a truck idling at the yard waiting to load.
export async function createManualRelease(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "manualBooking");

  const projectId = String(formData.get("projectId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const volumeM3 = Number(formData.get("volumeM3") ?? 0);
  if (!projectId || !siteId || !plantId || !mixId || !volumeM3 || volumeM3 <= 0) return;
  if (volumeM3 > MAX_LOAD_M3) return;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user!))) return;
  // The chosen station must actually belong to the chosen plant (site).
  if (!(await isPlantInScope(plantId, siteId))) return;
  if (!(await isPlantActive(plantId))) return; // frozen/decommissioned line: no new bookings

  const now = new Date();
  const reservation = await prisma.reservation.create({
    data: {
      projectId,
      siteId,
      mixId,
      requestedVolumeM3: volumeM3,
      pourWindowStart: now,
      status: "CONFIRMED",
      initialApprovedAt: now,
      initialApprovedById: user!.id,
      finalApprovedAt: now,
      finalApprovedById: user!.id,
    },
  });

  await logAudit({
    module: "Reservations",
    recordId: reservation.id,
    afterValue: `${volumeM3} m3`,
    reasonCode: "MANUAL_BOOKING_CREATED",
  });

  const ticket = await releaseTicketForReservation(reservation.id, volumeM3, plantId);
  if (!ticket) return;

  revalidatePath("/production");
  revalidatePath("/reservations");
  redirect(`/production/${ticket.id}`);
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
  await requireActionPermission(user, "production", "complete");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!batchTicketId) return;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id: batchTicketId },
    include: {
      components: { include: { material: true } },
      plant: { include: { silos: true, hoppers: true, chemicalTanks: true } },
    },
  });
  if (!ticket || ticket.status === "COMPLETE") return;

  // Deduct actual (or target, if never weighed) mass from the matching
  // silo, hopper, or chemical tank — the same inventory the Silos screen
  // and dashboard alerts read.
  for (const c of ticket.components) {
    const massKg = c.actualMassKg ?? c.targetMassKg;
    const massTons = massKg / 1000;

    if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
      const silo = await findMatchingSilo(ticket.plantId, ticket.plant.siteId, c.material.type);
      if (silo) {
        await prisma.silo.update({
          where: { id: silo.id },
          data: { currentLevelTons: Math.max(0, silo.currentLevelTons - massTons) },
        });
      }
    } else if (AGGREGATE_TYPES.has(c.material.type)) {
      const hopper = await findMatchingHopper(
        ticket.plantId,
        ticket.plant.siteId,
        c.material.type === "SAND" ? { equals: "SAND" } : { startsWith: "COARSE" },
      );
      if (hopper) {
        await prisma.hopper.update({
          where: { id: hopper.id },
          data: { currentLevelTons: Math.max(0, hopper.currentLevelTons - massTons) },
        });
      }
    } else if (c.material.type === "WATER") {
      // Reuses Hopper (a plain tonnage heap) rather than a new model — a
      // plant that meters bulk water registers a Hopper with
      // aggregateType "WATER"; one that doesn't just has no match here,
      // same silent no-op as any other unregistered destination.
      const waterHopper = await findMatchingHopper(ticket.plantId, ticket.plant.siteId, { equals: "WATER" });
      if (waterHopper) {
        await prisma.hopper.update({
          where: { id: waterHopper.id },
          data: { currentLevelTons: Math.max(0, waterHopper.currentLevelTons - massTons) },
        });
      }
    } else if (c.material.type === "ADMIXTURE" && c.material.specificGravity) {
      // Batched mass is always stored in kg (see addComponent in
      // mix-designs/actions.ts) — convert back to liters, the unit a
      // chemical tank is actually metered in.
      const tank = ticket.plant.chemicalTanks.find((t) => t.materialId === c.materialId);
      if (tank) {
        const liters = massKg / c.material.specificGravity;
        await prisma.chemicalTank.update({
          where: { id: tank.id },
          data: { currentLevelLiters: Math.max(0, tank.currentLevelLiters - liters) },
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

// A component missed at release time (or a last-minute site addition —
// an extra admixture dose, say) can still be added onto an already-
// released ticket, right up until it's marked COMPLETE and its mass is
// actually deducted from inventory.
export async function addTicketComponent(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const targetMassKg = Number(formData.get("targetMassKg") ?? 0);
  if (!batchTicketId || !materialId || !targetMassKg || targetMassKg <= 0) return;

  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId } });
  if (!ticket || ticket.status === "COMPLETE") return;

  await prisma.batchComponentActual.upsert({
    where: { batchTicketId_materialId: { batchTicketId, materialId } },
    create: { batchTicketId, materialId, targetMassKg },
    update: { targetMassKg },
  });

  await logAudit({
    module: "Production",
    recordId: batchTicketId,
    field: "component",
    afterValue: `${materialId}: ${targetMassKg} kg`,
    reasonCode: "TICKET_COMPONENT_ADDED",
  });

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
}

// Same COMPLETE boundary as addTicketComponent above — once a component's
// mass has actually been deducted from a silo or hopper, removing the row
// would leave that deduction unexplained rather than undoing it.
export async function deleteTicketComponent(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!id || !batchTicketId) return;

  const component = await prisma.batchComponentActual.findUnique({ where: { id }, include: { batchTicket: true } });
  if (!component || component.batchTicketId !== batchTicketId || component.batchTicket.status === "COMPLETE") return;

  await prisma.batchComponentActual.delete({ where: { id } });

  await logAudit({ module: "Production", recordId: batchTicketId, field: "component", reasonCode: "TICKET_COMPONENT_REMOVED" });

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
}

// Only ever safe before anything has actually been dispatched (no Trip on
// file yet — a Trip's own FK to this ticket is what would otherwise break).
// If the ticket had already reached COMPLETE, its components' mass was
// deducted from inventory in completeBatch — reverse that deduction here
// before deleting, the mirror image of that same deduction loop.
export async function deleteBatchTicket(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "deleteTicket");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id },
    include: {
      trip: true,
      components: { include: { material: true } },
      plant: { include: { silos: true, hoppers: true, chemicalTanks: true } },
    },
  });
  if (!ticket || ticket.trip) return;

  if (ticket.status === "COMPLETE") {
    for (const c of ticket.components) {
      const massKg = c.actualMassKg ?? c.targetMassKg;
      const massTons = massKg / 1000;

      if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
        const silo = await findMatchingSilo(ticket.plantId, ticket.plant.siteId, c.material.type);
        if (silo) {
          await prisma.silo.update({ where: { id: silo.id }, data: { currentLevelTons: silo.currentLevelTons + massTons } });
        }
      } else if (AGGREGATE_TYPES.has(c.material.type)) {
        const hopper = await findMatchingHopper(
          ticket.plantId,
          ticket.plant.siteId,
          c.material.type === "SAND" ? { equals: "SAND" } : { startsWith: "COARSE" },
        );
        if (hopper) {
          await prisma.hopper.update({ where: { id: hopper.id }, data: { currentLevelTons: hopper.currentLevelTons + massTons } });
        }
      } else if (c.material.type === "WATER") {
        const waterHopper = await findMatchingHopper(ticket.plantId, ticket.plant.siteId, { equals: "WATER" });
        if (waterHopper) {
          await prisma.hopper.update({ where: { id: waterHopper.id }, data: { currentLevelTons: waterHopper.currentLevelTons + massTons } });
        }
      } else if (c.material.type === "ADMIXTURE" && c.material.specificGravity) {
        const tank = ticket.plant.chemicalTanks.find((t) => t.materialId === c.materialId);
        if (tank) {
          const liters = massKg / c.material.specificGravity;
          await prisma.chemicalTank.update({ where: { id: tank.id }, data: { currentLevelLiters: tank.currentLevelLiters + liters } });
        }
      }
    }
  }

  // Components cascade-delete with the ticket (see BatchComponentActual's
  // onDelete: Cascade in schema.prisma).
  await prisma.batchTicket.delete({ where: { id } });

  await logAudit({
    module: "Production",
    recordId: id,
    afterValue: ticket.ticketNumber,
    reasonCode: ticket.status === "COMPLETE" ? "TICKET_DELETED_INVENTORY_RESTORED" : "TICKET_DELETED",
  });

  revalidatePath("/production");
  revalidatePath("/reservations");
  revalidatePath("/silos");
  revalidatePath("/");
  redirect("/production");
}
