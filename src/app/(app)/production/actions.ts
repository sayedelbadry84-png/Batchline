"use server";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { getRemainingVolumeM3, isReservationApproved } from "@/lib/reservations";
import { effectiveSiteId, isPlantActive, isPlantInScope, isSiteInScope } from "@/lib/siteScope";
import { getAvailableReclaimForTruck } from "@/lib/reclaim";
import { adjustSiloLevel, adjustHopperLevel, adjustChemicalTankLevel } from "@/lib/inventoryLevels";
import { withSequentialNumber } from "@/lib/sequence";
import { REQUISITION_APPROVAL_ROLES } from "@/lib/permissions";
import { notify, notifyRoles } from "@/lib/notify";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Aggregate-family materials get moisture-corrected at batch time; cement,
// admixture and water do not (this mirrors the moisture-correction rule in
// the Batchline design spec — only aggregates carry surface moisture).
const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

// See the same note on billing/actions.ts's own TX_OPTIONS — completeBatch's
// per-component silo/hopper/tank lookups+updates are several sequential
// round trips to Neon, which can comfortably exceed Prisma's 5s default
// interactive-transaction timeout, especially on a cold connection. 15s
// gives real headroom without masking a genuinely broken/looping query.
const TX_OPTIONS = { timeout: 15000 };

// A hopper's aggregate/water heap, or a cement silo, can be shared by
// every production line at one SITE (Hopper/Silo.sharedAcrossPlants) —
// prefer a match at the ticket's own line, but fall back to a shared one
// at the SAME site rather than silently finding nothing. Deliberately
// scoped by siteId, not global: two unrelated sites' stock must never
// cross-contaminate just because both happen to have a hopper flagged
// shared.
//
// A store explicitly assigned to a specific material (Hopper/
// Silo.materialId) is always matched by that exact assignment first —
// materialType/aggregateType alone can't tell two products of the same
// general type apart (two cement brands, say), which is exactly the gap
// that let completeBatch pick an arbitrary same-type silo regardless of
// what was actually in it. The type-based match below is now a fallback
// used ONLY among stores nobody has explicitly assigned yet
// (materialId: null) — an explicitly-assigned store is never borrowed
// for a different material just because the type happens to match.
async function findMatchingHopper(
  db: Prisma.TransactionClient | typeof prisma,
  plantId: string,
  siteId: string,
  materialId: string,
  aggregateTypeWhere: { equals: string } | { startsWith: string },
) {
  const ownAssigned = await db.hopper.findFirst({ where: { plantId, materialId } });
  if (ownAssigned) return ownAssigned;
  const sharedAssigned = await db.hopper.findFirst({ where: { sharedAcrossPlants: true, materialId, plant: { siteId } } });
  if (sharedAssigned) return sharedAssigned;

  const own = await db.hopper.findFirst({ where: { plantId, aggregateType: aggregateTypeWhere, materialId: null } });
  if (own) return own;
  return db.hopper.findFirst({ where: { sharedAcrossPlants: true, aggregateType: aggregateTypeWhere, materialId: null, plant: { siteId } } });
}

async function findMatchingSilo(db: Prisma.TransactionClient | typeof prisma, plantId: string, siteId: string, materialId: string, materialType: string) {
  const ownAssigned = await db.silo.findFirst({ where: { plantId, materialId } });
  if (ownAssigned) return ownAssigned;
  const sharedAssigned = await db.silo.findFirst({ where: { sharedAcrossPlants: true, materialId, plant: { siteId } } });
  if (sharedAssigned) return sharedAssigned;

  const own = await db.silo.findFirst({ where: { plantId, materialType, materialId: null } });
  if (own) return own;
  return db.silo.findFirst({ where: { sharedAcrossPlants: true, materialType, materialId: null, plant: { siteId } } });
}

// Raw-material counterpart to issueSparePartToOrder's shortfall handling —
// called from completeBatch right after a silo/hopper/tank's level is
// deducted; if what's left is at or below the store's own minThresholdPct,
// opens a MaterialRequisition for enough to refill it (skipped if capacity
// is unset/zero, since there's then no percentage to compare against, or
// if one's already open for this material+site — a run of many low
// batches must not flood Purchasing with duplicate requests for the same
// shortage). toKg converts the store's own unit (tons for silo/hopper,
// liters for a chemical tank) to the kg PurchaseOrderLine.orderedMassKg
// expects.
async function maybeAutoRequisitionMaterial(
  materialId: string,
  siteId: string,
  currentLevel: number,
  capacity: number,
  minThresholdPct: number,
  toKg: (units: number) => number,
) {
  if (capacity <= 0) return;
  if ((currentLevel / capacity) * 100 > minThresholdPct) return;

  const shortfall = capacity - currentLevel;
  if (shortfall <= 0) return;

  const existing = await prisma.materialRequisition.findFirst({
    where: { materialId, siteId, status: { in: ["PENDING_APPROVAL", "APPROVED", "ORDERED"] } },
  });
  if (existing) return;

  const requisition = await withSequentialNumber(
    "MTR",
    (yr) => prisma.materialRequisition.count({ where: { createdAt: yr } }),
    (requisitionNumber) =>
      prisma.materialRequisition.create({
        data: { requisitionNumber, materialId, siteId, quantityNeededKg: toKg(shortfall) },
        include: { material: true },
      }),
  );

  await notifyRoles(REQUISITION_APPROVAL_ROLES, {
    title: requisition.requisitionNumber,
    body: `${requisition.material.name} — auto-requested, stock at or below threshold`,
    link: "/warehouses?tab=rawMaterials&sub=silos",
    module: "Warehouses",
  });
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

  // The remaining-volume read and the ticket create used to be two separate
  // round trips with no lock between them — two concurrent releases for the
  // same reservation could both read the same "remaining" figure and both
  // create a ticket, together dispatching more than was ever requested.
  // Serializable makes Postgres detect that read-write conflict and abort
  // one of the two competing transactions.
  let ticket;
  try {
    ticket = await prisma.$transaction(
      async (tx) => {
        const remaining = await getRemainingVolumeM3(reservationId, reservation.requestedVolumeM3, tx);
        const volumeM3 = Math.min(requestedVolume, remaining);
        if (volumeM3 <= 0) throw new Error("NO_REMAINING_VOLUME");

        // ticketNumber is globally unique (one company-wide sequence, not
        // per-plant) — it used to be counted per plantId while the column
        // itself has no per-plant scoping, so the FIRST ticket at any
        // second plant always collided with "BT-<year>-0001" from the
        // first one ever used. See withSequentialNumber's own comment for
        // the full story.
        const created = await withSequentialNumber(
          "BT",
          (yr) => tx.batchTicket.count({ where: { createdAt: yr } }),
          (ticketNumber) =>
            tx.batchTicket.create({
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
            }),
        );

        if (reservation.status !== "IN_PRODUCTION") {
          await tx.reservation.update({ where: { id: reservationId }, data: { status: "IN_PRODUCTION" } });
        }

        return created;
      },
      { ...TX_OPTIONS, isolationLevel: "Serializable" },
    );
  } catch {
    return null;
  }

  await logAudit({
    module: "Production",
    recordId: ticket.id,
    afterValue: `${ticket.ticketNumber} — ${ticket.volumeM3} m3`,
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
  const reservation = await withSequentialNumber(
    "RES",
    (yr) => prisma.reservation.count({ where: { createdAt: yr } }),
    (reservationNumber) =>
      prisma.reservation.create({
        data: {
          reservationNumber,
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
      }),
  );

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
  await requireActionPermission(user, "production", "recordActuals");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!batchTicketId) return;

  // Same COMPLETE boundary recordActualField already enforces (line ~337
  // below) — this bulk sibling was missing it entirely. Without this guard,
  // saving readings on an already-COMPLETE ticket flips it back to
  // BATCHING, which clears completeBatch's own `status === "COMPLETE"`
  // guard and lets a resubmit deduct the same materials from inventory a
  // second time.
  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId } });
  if (!ticket || ticket.status === "COMPLETE" || ticket.status === "CANCELLED") return;
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return;

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
    // A negative weighed mass (typo, scale glitch) would later be summed
    // into `currentLevelTons - massTons` in completeBatch and INCREASE the
    // silo/hopper reading instead of decreasing it.
    if (!Number.isFinite(enteredMass) || enteredMass < 0) continue;

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
  await requireActionPermission(user, "production", "recordActualField");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const componentId = String(formData.get("componentId") ?? "");
  const field = String(formData.get("field") ?? "");
  const rawValue = formData.get("value");
  if (!batchTicketId || !componentId || rawValue === null || rawValue === "") return;
  if (field !== "actual" && field !== "moisture") return;

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) return;

  const component = await prisma.batchComponentActual.findUnique({
    where: { id: componentId },
    include: { batchTicket: true },
  });
  if (!component || component.batchTicketId !== batchTicketId || component.batchTicket.status === "COMPLETE" || component.batchTicket.status === "CANCELLED") return;
  if (!(await isPlantInScope(component.batchTicket.plantId, effectiveSiteId(user)))) return;

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
  const shortageOverrideNote = String(formData.get("shortageOverrideNote") ?? "").trim() || null;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id: batchTicketId },
    include: {
      components: { include: { material: true } },
      plant: { include: { silos: true, hoppers: true, chemicalTanks: true } },
    },
  });
  if (!ticket || ticket.status === "COMPLETE" || ticket.status === "CANCELLED") return;
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return;

  // Would deducting this component take its store below zero? Completing
  // used to clamp at 0 silently (Math.max(0, current - usage)), hiding a
  // real physical shortfall — the mixer ran with less material than the
  // recipe called for, with no record anywhere that it happened. Same
  // "no note, no [consequential change]" rule as CAPA/waste-memo/incoming-
  // inspection elsewhere: a shortage still completes, but only with a
  // written override reason, and that reason is what gets audited.
  const shortages: string[] = [];
  for (const c of ticket.components) {
    const massKg = c.actualMassKg ?? c.targetMassKg;
    const massTons = massKg / 1000;
    if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
      const silo = await findMatchingSilo(prisma, ticket.plantId, ticket.plant.siteId, c.materialId, c.material.type);
      if (silo && silo.currentLevelTons < massTons) shortages.push(`${c.material.name}: ${silo.currentLevelTons.toFixed(2)}t on hand, ${massTons.toFixed(2)}t needed`);
    } else if (AGGREGATE_TYPES.has(c.material.type)) {
      const hopper = await findMatchingHopper(prisma, ticket.plantId, ticket.plant.siteId, c.materialId, c.material.type === "SAND" ? { equals: "SAND" } : { startsWith: "COARSE" });
      if (hopper && hopper.currentLevelTons < massTons) shortages.push(`${c.material.name}: ${hopper.currentLevelTons.toFixed(2)}t on hand, ${massTons.toFixed(2)}t needed`);
    } else if (c.material.type === "WATER") {
      const waterHopper = await findMatchingHopper(prisma, ticket.plantId, ticket.plant.siteId, c.materialId, { equals: "WATER" });
      if (waterHopper && waterHopper.currentLevelTons < massTons) shortages.push(`${c.material.name}: ${waterHopper.currentLevelTons.toFixed(2)}t on hand, ${massTons.toFixed(2)}t needed`);
    } else if (c.material.type === "ADMIXTURE" && c.material.specificGravity) {
      const tank = ticket.plant.chemicalTanks.find((t) => t.materialId === c.materialId);
      if (tank) {
        const liters = massKg / c.material.specificGravity;
        if (tank.currentLevelLiters < liters) shortages.push(`${c.material.name}: ${tank.currentLevelLiters.toFixed(0)}L on hand, ${liters.toFixed(0)}L needed`);
      }
    }
  }
  if (shortages.length > 0 && !shortageOverrideNote) return;

  // Auto-requisition checks (maybeAutoRequisitionMaterial) fire their own
  // notification side effect and aren't part of the inventory/status write
  // itself — collected here and run once the transaction below has
  // actually committed, rather than inside it.
  const requisitionChecks: Array<() => Promise<void>> = [];

  // Deduct actual (or target, if never weighed) mass from the matching
  // silo, hopper, or chemical tank — the same inventory the Silos screen
  // and dashboard alerts read. The whole loop plus the final status flip
  // run as one transaction: previously each update committed independently
  // and only the status flip at the end marked the ticket COMPLETE, so a
  // failure partway through the loop (e.g. the 3rd component's update
  // throws) left the first two materials already deducted but the ticket
  // still not COMPLETE — a retry would then re-run the whole loop and
  // double-deduct the materials that succeeded the first time.
  try {
    await prisma.$transaction(async (tx) => {
      // Claim the ticket atomically, first thing inside the transaction —
      // the plain `ticket.status === "COMPLETE"` check above was read
      // BEFORE this transaction started, so two concurrent completions of
      // the same ticket could both pass it and both run the deduction loop
      // below, double-consuming every component's mass for one physical
      // batch. Postgres row-locks this UPDATE, so only the first caller's
      // WHERE clause can still match a non-terminal status; the second's
      // updateMany then matches zero rows, the thrown error rolls the
      // whole transaction back, and nothing gets deducted twice. Excludes
      // CANCELLED too (not just COMPLETE) — the schema lists it as a valid
      // terminal status even though nothing sets it today, and a future
      // cancel feature must not silently reopen a batch this check was
      // meant to keep shut.
      const claim = await tx.batchTicket.updateMany({
        where: { id: batchTicketId, status: { notIn: ["COMPLETE", "CANCELLED"] } },
        data: { status: "COMPLETE", batchCompletedAt: new Date() },
      });
      if (claim.count === 0) throw new Error("ALREADY_TERMINAL");

      for (const c of ticket.components) {
        const massKg = c.actualMassKg ?? c.targetMassKg;
        const massTons = massKg / 1000;

        if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
          const silo = await findMatchingSilo(tx, ticket.plantId, ticket.plant.siteId, c.materialId, c.material.type);
          if (silo) {
            const newLevelTons = await adjustSiloLevel(tx, silo.id, -massTons);
            if (newLevelTons !== null) {
              requisitionChecks.push(() =>
                maybeAutoRequisitionMaterial(c.materialId, ticket.plant.siteId, newLevelTons, silo.capacityTons, silo.minThresholdPct, (tons) => tons * 1000),
              );
            }
          }
        } else if (AGGREGATE_TYPES.has(c.material.type)) {
          const hopper = await findMatchingHopper(
            tx,
            ticket.plantId,
            ticket.plant.siteId,
            c.materialId,
            c.material.type === "SAND" ? { equals: "SAND" } : { startsWith: "COARSE" },
          );
          if (hopper) {
            const newLevelTons = await adjustHopperLevel(tx, hopper.id, -massTons);
            if (newLevelTons !== null) {
              requisitionChecks.push(() =>
                maybeAutoRequisitionMaterial(c.materialId, ticket.plant.siteId, newLevelTons, hopper.capacityTons, hopper.minThresholdPct, (tons) => tons * 1000),
              );
            }
          }
        } else if (c.material.type === "WATER") {
          // Reuses Hopper (a plain tonnage heap) rather than a new model — a
          // plant that meters bulk water registers a Hopper with
          // aggregateType "WATER"; one that doesn't just has no match here,
          // same silent no-op as any other unregistered destination.
          const waterHopper = await findMatchingHopper(tx, ticket.plantId, ticket.plant.siteId, c.materialId, { equals: "WATER" });
          if (waterHopper) {
            const newLevelTons = await adjustHopperLevel(tx, waterHopper.id, -massTons);
            if (newLevelTons !== null) {
              requisitionChecks.push(() =>
                maybeAutoRequisitionMaterial(c.materialId, ticket.plant.siteId, newLevelTons, waterHopper.capacityTons, waterHopper.minThresholdPct, (tons) => tons * 1000),
              );
            }
          }
        } else if (c.material.type === "ADMIXTURE" && c.material.specificGravity) {
          // Batched mass is always stored in kg (see addComponent in
          // mix-designs/actions.ts) — convert back to liters, the unit a
          // chemical tank is actually metered in.
          const tank = ticket.plant.chemicalTanks.find((t) => t.materialId === c.materialId);
          if (tank) {
            const liters = massKg / c.material.specificGravity;
            const newLevelLiters = await adjustChemicalTankLevel(tx, tank.id, -liters);
            const specificGravity = c.material.specificGravity;
            if (newLevelLiters !== null) {
              requisitionChecks.push(() =>
                maybeAutoRequisitionMaterial(
                  c.materialId,
                  ticket.plant.siteId,
                  newLevelLiters,
                  tank.capacityLiters ?? 0,
                  tank.minThresholdPct,
                  (liters) => liters * specificGravity,
                ),
              );
            }
          }
        }
      }
    }, TX_OPTIONS);
  } catch {
    return;
  }

  for (const check of requisitionChecks) await check();

  await logAudit({
    module: "Production",
    recordId: batchTicketId,
    field: "status",
    afterValue: "COMPLETE",
    reasonCode: shortages.length > 0 ? "BATCH_COMPLETE_WITH_SHORTAGE_OVERRIDE" : "BATCH_COMPLETE_INVENTORY_DEDUCTED",
  });
  if (shortages.length > 0) {
    await logAudit({
      module: "Production",
      recordId: batchTicketId,
      field: "shortageOverrideNote",
      afterValue: `${shortageOverrideNote} — ${shortages.join("; ")}`,
      reasonCode: "BATCH_SHORTAGE_OVERRIDDEN",
    });
  }

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
  revalidatePath("/operator");
  revalidatePath("/warehouses");
  revalidatePath("/");
}

export async function startTrip(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "startTrip");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const truckId = String(formData.get("truckId") ?? "");
  const driverId = String(formData.get("driverId") ?? "");
  // Field view sends "/operator" so an operator who just dispatched a
  // truck lands back on their own ticket list, not the desktop Trip Board.
  const returnTo = String(formData.get("returnTo") ?? "/trips");
  if (!batchTicketId || !truckId || !driverId) return;

  const ticket = await prisma.batchTicket.findUnique({
    where: { id: batchTicketId },
    include: { reservation: true, components: { include: { material: true } }, plant: true },
  });
  if (!ticket) return;
  // The page only ever renders this form once the ticket is COMPLETE (see
  // production/[id]/page.tsx's showAssignForm) — re-checked here server-side
  // for the same reason every other "the picker already filtered this"
  // check in the app is re-verified against a crafted/stale request. This
  // also fixes a real sequencing bug: completeBatch deducts inventory using
  // each component's PRE-reclaim target mass; only requiring COMPLETE
  // before dispatch guarantees that deduction has already happened by the
  // time the reclaim credit-back below runs, so the two stay consistent.
  if (ticket.status !== "COMPLETE") return;
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return;

  const truck = await prisma.truck.findUnique({ where: { id: truckId }, include: { plant: true } });
  if (!truck || truck.status === "OUT_OF_SERVICE" || truck.status === "MAINTENANCE") return;
  if (truck.plant.siteId !== ticket.plant.siteId) return;
  // A drum physically can't carry more than its rated capacity — without
  // this, a ticket cut for more volume than any assigned truck can hold
  // would silently create a trip nobody can actually deliver as ordered.
  if (ticket.volumeM3 > truck.drumCapacityM3) return;

  const driver = await prisma.employee.findUnique({ where: { id: driverId } });
  if (!driver || driver.status !== "ACTIVE" || driver.role !== "DRIVER") return;

  // Pump crew/unit only apply when the reservation was booked for pump
  // delivery — ignore anything submitted for a chute delivery so a stray
  // pump doesn't attach itself to a trip that never used one.
  const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";
  const pumpId = isPumpDelivery ? String(formData.get("pumpId") ?? "").trim() || null : null;
  const pumpOperatorIdInput = isPumpDelivery ? String(formData.get("pumpOperatorId") ?? "").trim() || null : null;
  const pumpAssistantIdInput = isPumpDelivery ? String(formData.get("pumpAssistantId") ?? "").trim() || null : null;
  // A pump-delivery reservation with no pump actually assigned is an
  // incomplete dispatch, not a valid one — reject rather than silently
  // starting a trip that can't be discharged.
  if (isPumpDelivery && !pumpId) return;

  // Re-verify the submitted pump server-side, same reasoning as the
  // truck checks above — a stale/crafted picker value shouldn't be
  // trusted for existence, service status, site, or reach.
  if (isPumpDelivery && pumpId) {
    const pump = await prisma.pump.findUnique({ where: { id: pumpId }, include: { plant: true } });
    if (!pump || pump.status === "OUT_OF_SERVICE" || pump.status === "MAINTENANCE") return;
    if (pump.plant.siteId !== ticket.plant.siteId) return;
    if (pump.reachM != null && ticket.reservation.minPumpReachM != null && pump.reachM < ticket.reservation.minPumpReachM) return;
  }

  // The select offers the company-wide active roster (crew can work a
  // different plant's pump the same day — see the picker's own comment) —
  // re-verify the submitted id against that same company-wide set server-
  // side rather than trusting the picker, same reasoning as the truck-busy
  // check above. A stray id (stale page, crew member deactivated meanwhile)
  // is dropped rather than trusted.
  let pumpOperatorId: string | null = null;
  let pumpAssistantId: string | null = null;
  let pumpOperatorName: string | null = null;
  let pumpAssistantName: string | null = null;
  if (isPumpDelivery && (pumpOperatorIdInput || pumpAssistantIdInput)) {
    const crew = await prisma.pumpCrewMember.findMany({ where: { status: "ACTIVE" } });
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

  // If the chosen truck is still carrying reclaimed material from its
  // last CLOSED trip (same mix, not yet consumed — see getAvailableReclaimForTruck),
  // top it up instead of drawing full fresh materials: shrink every
  // component's target mass by the reclaimed share and mark that earlier
  // return consumed, atomically with creating this trip. The ticket's own
  // volumeM3 (what the customer is billed/ticketed for) is never touched.
  const availableReclaim = await getAvailableReclaimForTruck(truckId, ticket.mixId);
  const reclaimedVolumeM3 = availableReclaim ? Math.min(availableReclaim.volumeM3, ticket.volumeM3) : null;

  // Serializable: the plain findFirst-then-create this used to be let two
  // concurrent "start trip" submissions for the same truck both read "not
  // busy" before either commit, assigning the same truck to two open trips
  // at once. Under Serializable isolation, Postgres detects the read-write
  // conflict between the two transactions and aborts one with P2034 — that
  // one falls through to the silent-return below, same as every other
  // rejected submission in this action, and the caller just needs to retry.
  let trip;
  try {
    trip = await prisma.$transaction(
      async (tx) => {
        const truckBusy = await tx.trip.findFirst({ where: { truckId, status: { not: "CLOSED" } } });
        if (truckBusy) throw new Error("TRUCK_BUSY");

        // Same double-booking risk as the truck: a pump unit or a crew
        // member can only be actually running one trip at a time, so
        // check each the same way — under the same Serializable
        // transaction, so a concurrent submission can't slip both onto
        // two open trips at once.
        if (pumpId) {
          const pumpBusy = await tx.trip.findFirst({ where: { pumpId, status: { not: "CLOSED" } } });
          if (pumpBusy) throw new Error("PUMP_BUSY");
        }
        if (pumpOperatorId || pumpAssistantId) {
          const crewIds = [pumpOperatorId, pumpAssistantId].filter((v): v is string => Boolean(v));
          const crewBusy = await tx.trip.findFirst({
            where: {
              status: { not: "CLOSED" },
              OR: [{ pumpOperatorId: { in: crewIds } }, { pumpAssistantId: { in: crewIds } }],
            },
          });
          if (crewBusy) throw new Error("CREW_BUSY");
        }

        const created = await tx.trip.create({
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
            reclaimedVolumeM3,
          },
        });

        if (availableReclaim && reclaimedVolumeM3) {
          const freshFraction = 1 - reclaimedVolumeM3 / ticket.volumeM3;
          const reclaimedFraction = 1 - freshFraction;
          // completeBatch (required to have already run — see the
          // ticket.status === "COMPLETE" check above) deducted every
          // component's FULL pre-reclaim mass from inventory, since reclaim
          // for this specific truck wasn't known yet at completion time.
          // Now that it is, credit back the reclaimed share of whatever was
          // actually deducted (actualMassKg if weighed, else targetMassKg —
          // the same fallback completeBatch itself uses) to the same
          // silo/hopper/tank it came from, so the ledger matches the fresh
          // material genuinely drawn for this load.
          for (const c of ticket.components) {
            const deductedMassKg = c.actualMassKg ?? c.targetMassKg;
            const creditMassKg = deductedMassKg * reclaimedFraction;

            await tx.batchComponentActual.update({
              where: { id: c.id },
              data: { targetMassKg: c.targetMassKg * freshFraction },
            });

            if (creditMassKg <= 0) continue;
            const creditTons = creditMassKg / 1000;
            if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
              const silo = await findMatchingSilo(tx, ticket.plantId, ticket.plant.siteId, c.materialId, c.material.type);
              if (silo) await adjustSiloLevel(tx, silo.id, creditTons);
            } else if (AGGREGATE_TYPES.has(c.material.type)) {
              const hopper = await findMatchingHopper(
                tx,
                ticket.plantId,
                ticket.plant.siteId,
                c.materialId,
                c.material.type === "SAND" ? { equals: "SAND" } : { startsWith: "COARSE" },
              );
              if (hopper) await adjustHopperLevel(tx, hopper.id, creditTons);
            } else if (c.material.type === "WATER") {
              const waterHopper = await findMatchingHopper(tx, ticket.plantId, ticket.plant.siteId, c.materialId, { equals: "WATER" });
              if (waterHopper) await adjustHopperLevel(tx, waterHopper.id, creditTons);
            } else if (c.material.type === "ADMIXTURE" && c.material.specificGravity) {
              const tank = await tx.chemicalTank.findFirst({ where: { plantId: ticket.plantId, materialId: c.materialId } });
              if (tank) {
                const creditLiters = creditMassKg / c.material.specificGravity;
                await adjustChemicalTankLevel(tx, tank.id, creditLiters);
              }
            }
          }
          await tx.drumReturn.update({
            where: { id: availableReclaim.drumReturnId },
            data: { consumedAt: new Date(), consumedInTripId: created.id },
          });
        }

        return created;
      },
      { ...TX_OPTIONS, isolationLevel: "Serializable" },
    );
  } catch {
    return;
  }

  await logAudit({ module: "Fleet", recordId: trip.id, afterValue: "LOADING", reasonCode: "TRIP_STARTED" });

  // Real push notification (see src/lib/push.ts) the instant this driver
  // is actually dispatched — the whole point of the driver app knowing
  // about a trip the moment it exists, not whenever they next happen to
  // open it. A driver with no linked User account (or none subscribed to
  // push yet) simply gets nothing here — same silent no-op notify() and
  // sendPushToUser() already are in every other case.
  const driverUser = await prisma.user.findUnique({ where: { employeeId: driverId } });
  if (driverUser) {
    await notify([driverUser.id], {
      title: ticket.reservation.reservationNumber,
      body: `${ticket.ticketNumber} — ${ticket.volumeM3} m³`,
      link: `/driver/trip/${trip.id}`,
      module: "Fleet",
    });
  }

  // Same real push for whichever pump crew just got assigned — /pump-crew
  // has no per-trip detail page (see that page's own comment on why it
  // stays read-only), so the link opens straight to their job list, where
  // this trip now shows up.
  const pumpCrewIds = [pumpOperatorId, pumpAssistantId].filter((id): id is string => Boolean(id));
  if (pumpCrewIds.length > 0) {
    const pumpCrewUsers = await prisma.user.findMany({ where: { pumpCrewMemberId: { in: pumpCrewIds } } });
    if (pumpCrewUsers.length > 0) {
      await notify(pumpCrewUsers.map((u) => u.id), {
        title: ticket.reservation.reservationNumber,
        body: `${ticket.ticketNumber} — ${ticket.volumeM3} m³`,
        link: "/pump-crew",
        module: "Fleet",
      });
    }
  }

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
  await requireActionPermission(user, "production", "updateTripAssignment");

  const tripId = String(formData.get("tripId") ?? "");
  const truckId = String(formData.get("truckId") ?? "");
  const driverId = String(formData.get("driverId") ?? "");
  if (!tripId || !truckId || !driverId) return;

  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: { batchTicket: { include: { reservation: true } } },
  });
  if (!trip || trip.status !== "LOADING") return;

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
    const crew = await prisma.pumpCrewMember.findMany({ where: { status: "ACTIVE" } });
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

  // Same Serializable-transaction fix as startTrip above — re-checking
  // truck-busy and writing the reassignment outside one transaction let two
  // concurrent reassignments both see the truck as free and both take it.
  try {
    await prisma.$transaction(
      async (tx) => {
        const truckBusy = await tx.trip.findFirst({
          where: { truckId, status: { not: "CLOSED" }, id: { not: tripId } },
        });
        if (truckBusy) throw new Error("TRUCK_BUSY");

        await tx.trip.update({
          where: { id: tripId },
          data: { truckId, driverId, pumpId, pumpOperatorId, pumpOperatorName, pumpAssistantId, pumpAssistantName },
        });
      },
      { ...TX_OPTIONS, isolationLevel: "Serializable" },
    );
  } catch {
    return;
  }

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
  await requireActionPermission(user, "production", "addTicketComponent");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const targetMassKg = Number(formData.get("targetMassKg") ?? 0);
  if (!batchTicketId || !materialId || !targetMassKg || targetMassKg <= 0) return;

  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId } });
  if (!ticket || ticket.status === "COMPLETE" || ticket.status === "CANCELLED") return;
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return;

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
  await requireActionPermission(user, "production", "deleteTicketComponent");

  const id = String(formData.get("id") ?? "");
  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!id || !batchTicketId) return;

  const component = await prisma.batchComponentActual.findUnique({ where: { id }, include: { batchTicket: true } });
  if (!component || component.batchTicketId !== batchTicketId || component.batchTicket.status === "COMPLETE" || component.batchTicket.status === "CANCELLED") return;
  if (!(await isPlantInScope(component.batchTicket.plantId, effectiveSiteId(user)))) return;

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
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return;

  // The reversal loop and the delete itself used to be independent writes
  // — a failure partway through the loop (the 3rd component's update
  // throws, say) left some materials already credited back but the
  // ticket still on file, un-deletable a second time the same way without
  // double-crediting what already went back. One transaction makes the
  // whole reversal-plus-delete all-or-nothing, same as completeBatch's own
  // deduction loop.
  await prisma.$transaction(async (tx) => {
    if (ticket.status === "COMPLETE") {
      for (const c of ticket.components) {
        const massKg = c.actualMassKg ?? c.targetMassKg;
        const massTons = massKg / 1000;

        if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
          const silo = await findMatchingSilo(tx, ticket.plantId, ticket.plant.siteId, c.materialId, c.material.type);
          if (silo) await adjustSiloLevel(tx, silo.id, massTons);
        } else if (AGGREGATE_TYPES.has(c.material.type)) {
          const hopper = await findMatchingHopper(
            tx,
            ticket.plantId,
            ticket.plant.siteId,
            c.materialId,
            c.material.type === "SAND" ? { equals: "SAND" } : { startsWith: "COARSE" },
          );
          if (hopper) await adjustHopperLevel(tx, hopper.id, massTons);
        } else if (c.material.type === "WATER") {
          const waterHopper = await findMatchingHopper(tx, ticket.plantId, ticket.plant.siteId, c.materialId, { equals: "WATER" });
          if (waterHopper) await adjustHopperLevel(tx, waterHopper.id, massTons);
        } else if (c.material.type === "ADMIXTURE" && c.material.specificGravity) {
          const tank = ticket.plant.chemicalTanks.find((t) => t.materialId === c.materialId);
          if (tank) {
            const liters = massKg / c.material.specificGravity;
            await adjustChemicalTankLevel(tx, tank.id, liters);
          }
        }
      }
    }

    // Components cascade-delete with the ticket (see BatchComponentActual's
    // onDelete: Cascade in schema.prisma).
    await tx.batchTicket.delete({ where: { id } });
  }, TX_OPTIONS);

  await logAudit({
    module: "Production",
    recordId: id,
    afterValue: ticket.ticketNumber,
    reasonCode: ticket.status === "COMPLETE" ? "TICKET_DELETED_INVENTORY_RESTORED" : "TICKET_DELETED",
  });

  revalidatePath("/production");
  revalidatePath("/reservations");
  revalidatePath("/warehouses");
  revalidatePath("/");
  redirect("/production");
}
