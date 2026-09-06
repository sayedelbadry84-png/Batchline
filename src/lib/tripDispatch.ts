import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { postSiloMovement, postHopperMovement, postChemicalTankMovement, withRetry } from "@/lib/inventoryLedger";
import { claimTripResources, type TripResourceResult } from "@/lib/tripAssignment";
import { getAvailableReclaimForTruck } from "@/lib/reclaim";
import { lockPlantSiteId } from "@/lib/siteScope";

// The claim core of startTrip (production/actions.ts), extracted so
// tests can exercise the REAL guard startTrip uses — the CR-01 fresh
// reversedAt/status re-check, plus the truck/pump/crew busy checks —
// instead of a paraphrase living only inside the test file. Takes the
// transaction client directly (like the postXMovement functions in
// src/lib/inventoryLedger.ts) rather than owning its own transaction,
// since startTrip needs this claim and the Trip creation (plus any
// reclaim credit-back) to commit or roll back together atomically.
type Tx = Prisma.TransactionClient;

export type DispatchClaimResult =
  | { status: "OK"; plantId: string; siteId: string }
  | { status: "NOT_DISPATCHABLE" }
  | { status: "OUT_OF_SCOPE" }
  | { status: "TRUCK_BUSY" }
  | { status: "PUMP_BUSY" }
  | { status: "CREW_BUSY" };

export async function claimTripSlot(
  tx: Tx,
  params: {
    ticketId: string;
    truckId: string;
    pumpId?: string | null;
    pumpOperatorId?: string | null;
    pumpAssistantId?: string | null;
    // Optional — an existing caller (see the "dispatch and reversal are
    // mutually exclusive" test) that never passes this gets no scope
    // check at all, same as before this field existed. startTrip
    // (production/actions.ts) always passes the actor's own
    // effectiveSiteId(user) now (PL-P1-03, first production-lifecycle
    // review): the ticket's own site is re-verified fresh, inside this
    // same lock, rather than only by a pre-transaction read that a
    // concurrent plant reassignment could have already invalidated.
    allowedSiteId?: string | null;
  },
): Promise<DispatchClaimResult> {
  // Re-verify status/reversedAt fresh, inside the caller's own
  // Serializable transaction — a plain pre-transaction read would miss a
  // reversal committed in the gap. If reverseBatchTicket's own
  // transaction (also Serializable — see src/lib/batchCompletion.ts)
  // commits first, this read sees reversedAt set; if the two are truly
  // concurrent, Postgres aborts one of them with a serialization failure
  // regardless. Either way, dispatch and reversal can never both succeed
  // for the same ticket.
  const freshTicket = await tx.batchTicket.findUnique({
    where: { id: params.ticketId },
    select: { status: true, reversedAt: true, plantId: true },
  });
  if (!freshTicket || freshTicket.status !== "COMPLETE" || freshTicket.reversedAt) return { status: "NOT_DISPATCHABLE" };

  // Locked, not just joined (PL-R2-P1-03, second production-lifecycle
  // review) — updatePlant (plants/actions.ts) lets an ADMIN move this
  // exact Plant to a different site at any time; a plain read of its
  // siteId here could already be stale by the time this transaction
  // commits, even under Serializable isolation ("operator action, then
  // transfer" is a legitimate serial order). Locking forces the two to
  // actually contend for the same row.
  const plantSiteId = await lockPlantSiteId(tx, freshTicket.plantId);
  if (plantSiteId === null) return { status: "NOT_DISPATCHABLE" };
  if (params.allowedSiteId !== undefined && params.allowedSiteId !== null && plantSiteId !== params.allowedSiteId) {
    return { status: "OUT_OF_SCOPE" };
  }

  const truckBusy = await tx.trip.findFirst({ where: { truckId: params.truckId, status: { not: "CLOSED" } } });
  if (truckBusy) return { status: "TRUCK_BUSY" };

  // Same double-booking risk as the truck: a pump unit or a crew member
  // can only be actually running one trip at a time.
  if (params.pumpId) {
    const pumpBusy = await tx.trip.findFirst({ where: { pumpId: params.pumpId, status: { not: "CLOSED" } } });
    if (pumpBusy) return { status: "PUMP_BUSY" };
  }
  if (params.pumpOperatorId || params.pumpAssistantId) {
    const crewIds = [params.pumpOperatorId, params.pumpAssistantId].filter((v): v is string => Boolean(v));
    const crewBusy = await tx.trip.findFirst({
      where: { status: { not: "CLOSED" }, OR: [{ pumpOperatorId: { in: crewIds } }, { pumpAssistantId: { in: crewIds } }] },
    });
    if (crewBusy) return { status: "CREW_BUSY" };
  }

  return { status: "OK", plantId: freshTicket.plantId, siteId: plantSiteId };
}

export type ReclaimCreditResult = { status: "OK" } | { status: "CREDIT_FAILED"; reason: string };

/**
 * Credits a reclaimed truck's carried-over share of a ticket's already-
 * deducted components back to the exact storage completion drew from —
 * extracted from startTrip (production/actions.ts) so tests can exercise
 * the REAL reclaim logic instead of a paraphrase (P1-04, fourth review:
 * the previous inline version, tested only via a bare postSiloMovement
 * call with a reclaim-shaped payload, never actually ran through this
 * code at all).
 *
 * Derives credits from the ticket's own immutable BATCH_COMPLETION ledger
 * rows — never recomputed from the recipe/current component mass, and
 * never re-resolved against whatever storage is CURRENTLY assigned to the
 * material. That fixes three bugs at once a review found in the previous
 * version: an inventoryTracked:false material posts no BATCH_COMPLETION
 * row in the first place, so it's naturally excluded here too (no
 * separate check needed); m.quantity IS the actual applied amount, so a
 * component that hit a real, allowed shortage at completion is only ever
 * credited its actual share, never the full recipe target; m.storageId
 * IS the exact original destination, so a since-changed material→storage
 * assignment can never send the credit to the wrong place.
 */
export async function applyReclaimCredit(
  tx: Tx,
  params: {
    batchTicketId: string;
    tripId: string;
    components: { id: string; materialId: string; material: { specificGravity: number | null } }[];
    reclaimedFraction: number;
    actorId: string;
  },
): Promise<ReclaimCreditResult> {
  const originalMovements = await tx.inventoryMovement.findMany({
    where: { sourceType: "BatchTicket", sourceId: params.batchTicketId, movementType: "BATCH_COMPLETION" },
  });

  // Sort before iterating — same lock-ordering reasoning as
  // completeBatchTicket and reverseBatchTicket: this loop and theirs can
  // all touch the same rows for one ticket, and a consistent order
  // across all three avoids a lock-ordering deadlock between concurrent
  // transactions that a bounded retry would otherwise just paper over.
  const sorted = [...originalMovements].sort((a, b) => (a.storageType === b.storageType ? a.storageId.localeCompare(b.storageId) : a.storageType.localeCompare(b.storageType)));

  for (const m of sorted) {
    const component = params.components.find((c) => c.materialId === m.materialId);
    if (!component) continue; // component was deleted since completion — nothing to credit back onto

    // m.quantity/unit round-trips back to kg the same way
    // batchCompletion.ts converts kg to tons/liters when posting.
    const appliedMassKg = m.unit === "LITERS" ? Math.abs(m.quantity) * (component.material.specificGravity ?? 1) : Math.abs(m.quantity) * 1000;
    const creditMassKg = appliedMassKg * params.reclaimedFraction;
    if (creditMassKg <= 0) continue;
    const creditQuantity = m.unit === "LITERS" ? creditMassKg / (component.material.specificGravity ?? 1) : creditMassKg / 1000;

    await tx.batchComponentActual.update({
      where: { id: component.id },
      data: { reclaimCreditMassKg: { increment: creditMassKg } },
    });
    const post = m.storageType === "SILO" ? postSiloMovement : m.storageType === "HOPPER" ? postHopperMovement : postChemicalTankMovement;
    const movementResult = await post(tx, {
      storageId: m.storageId, // the ORIGINAL storage, never re-resolved
      materialId: m.materialId,
      quantity: creditQuantity,
      movementType: "RECLAIM_CREDIT",
      sourceType: "Trip",
      sourceId: params.tripId,
      plantId: m.plantId,
      siteId: m.siteId,
      actorId: params.actorId,
      reason: null,
    });
    // Any non-OK result — the original storage no longer exists
    // (STORAGE_NOT_CONFIGURED) or postMovement threw CAPACITY_EXCEEDED
    // directly (a DomainError, propagating past this function to the
    // caller's own transaction) — must roll back the whole trip/reclaim,
    // not silently consume the truck's returned load with a missing or
    // partial credit.
    if (movementResult.status !== "OK") return { status: "CREDIT_FAILED", reason: movementResult.status };
  }

  return { status: "OK" };
}

const TX_OPTIONS = { timeout: 15000 };

// Thrown from inside startTripForTicket's transaction to unwind (and
// roll back everything already written in it, including the just-
// created Trip) to a typed result — a plain `return` here would let
// Prisma COMMIT the transaction with the trip already created despite
// the reclaim credit failing. Never escapes this file. Same pattern as
// ReleaseAbort in src/lib/reservationRelease.ts.
class StartTripAbort extends Error {
  constructor(public result: Extract<StartTripResult, { status: "RECLAIM_CREDIT_FAILED" }>) {
    super(result.status);
  }
}

export type StartTripResult =
  | { status: "OK"; tripId: string }
  | { status: "NOT_DISPATCHABLE" }
  | { status: "OUT_OF_SCOPE" }
  | { status: "TRUCK_BUSY" }
  | { status: "PUMP_BUSY" }
  | { status: "CREW_BUSY" }
  | Exclude<TripResourceResult, { status: "OK" }>
  | { status: "RECLAIM_CREDIT_FAILED"; reason: string };

// The one real start-trip domain command — extracted out of startTrip
// (production/actions.ts) so the Server Action and the integration
// suite both call the exact same production transaction, not two copies
// that can silently diverge (PL-R2-P2-06, second production-lifecycle
// review: the test file used to hand-assemble its own
// claimTripSlot+claimTripResources+trip.create sequence, which omitted
// reclaim consumption/credit and the atomic start audit entirely). No
// session/formData access, so it's callable from tests directly, same
// split as every other domain command in this app.
export async function startTripForTicket(
  ticketId: string,
  params: {
    truckId: string;
    driverId: string;
    pumpId: string | null;
    pumpOperatorId: string | null;
    pumpAssistantId: string | null;
    allowedSiteId: string | null;
    actorId: string;
    actorRole: string;
  },
): Promise<StartTripResult> {
  try {
    return await withRetry(() =>
      prisma.$transaction(
        async (tx) => {
        const claim = await claimTripSlot(tx, {
          ticketId,
          truckId: params.truckId,
          pumpId: params.pumpId,
          pumpOperatorId: params.pumpOperatorId,
          pumpAssistantId: params.pumpAssistantId,
          allowedSiteId: params.allowedSiteId,
        });
        if (claim.status !== "OK") return claim;

        const ticket = await tx.batchTicket.findUniqueOrThrow({
          where: { id: ticketId },
          include: { reservation: true, components: { include: { material: true } } },
        });
        const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";

        const resources = await claimTripResources(tx, {
          siteId: claim.siteId,
          truckId: params.truckId,
          driverId: params.driverId,
          loadVolumeM3: ticket.volumeM3,
          isPumpDelivery,
          pumpId: params.pumpId,
          pumpOperatorId: params.pumpOperatorId,
          pumpAssistantId: params.pumpAssistantId,
          minPumpReachM: ticket.reservation.minPumpReachM,
        });
        if (resources.status !== "OK") return resources;

        // If the chosen truck is still carrying reclaimed material from
        // its last CLOSED trip (same mix, not yet consumed), top it up
        // instead of drawing full fresh materials — see
        // getAvailableReclaimForTruck's own comment (reclaim.ts). The
        // ticket's own volumeM3 (what the customer is billed/ticketed
        // for) is never touched.
        const availableReclaim = await getAvailableReclaimForTruck(params.truckId, ticket.mixId);
        const reclaimedVolumeM3 = availableReclaim ? Math.min(availableReclaim.volumeM3, ticket.volumeM3) : null;

        const created = await tx.trip.create({
          data: {
            batchTicketId: ticketId,
            truckId: params.truckId,
            driverId: params.driverId,
            pumpId: params.pumpId,
            pumpOperatorName: resources.pumpOperatorName,
            pumpAssistantName: resources.pumpAssistantName,
            pumpOperatorId: params.pumpOperatorId,
            pumpAssistantId: params.pumpAssistantId,
            status: "LOADING",
            batchTime: ticket.batchCompletedAt ?? new Date(),
            reclaimedVolumeM3,
          },
        });

        if (availableReclaim && reclaimedVolumeM3) {
          const freshFraction = 1 - reclaimedVolumeM3 / ticket.volumeM3;
          const reclaimedFraction = 1 - freshFraction;

          const creditResult = await applyReclaimCredit(tx, {
            batchTicketId: ticketId,
            tripId: created.id,
            components: ticket.components,
            reclaimedFraction,
            actorId: params.actorId,
          });
          if (creditResult.status !== "OK") throw new StartTripAbort({ status: "RECLAIM_CREDIT_FAILED", reason: creditResult.reason });

          await tx.drumReturn.update({
            where: { id: availableReclaim.drumReturnId },
            data: { consumedAt: new Date(), consumedInTripId: created.id },
          });
        }

        // Written in the SAME transaction as the trip itself (PL-P2-03)
        // — a version that logged this after commit meant a successful
        // dispatch could exist with no matching audit event if that
        // later, separate write ever failed.
        await tx.auditEvent.create({
          data: { actorId: params.actorId, role: params.actorRole, module: "Fleet", recordId: created.id, afterValue: "LOADING", reasonCode: "TRIP_STARTED" },
        });

        return { status: "OK" as const, tripId: created.id };
        },
        { ...TX_OPTIONS, isolationLevel: "Serializable" },
      ),
    );
  } catch (e) {
    if (e instanceof StartTripAbort) return e.result;
    throw e;
  }
}
