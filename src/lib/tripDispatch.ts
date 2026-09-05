import "server-only";
import type { Prisma } from "@prisma/client";
import { postSiloMovement, postHopperMovement, postChemicalTankMovement } from "@/lib/inventoryLedger";

// The claim core of startTrip (production/actions.ts), extracted so
// tests can exercise the REAL guard startTrip uses — the CR-01 fresh
// reversedAt/status re-check, plus the truck/pump/crew busy checks —
// instead of a paraphrase living only inside the test file. Takes the
// transaction client directly (like the postXMovement functions in
// src/lib/inventoryLedger.ts) rather than owning its own transaction,
// since startTrip needs this claim and the Trip creation (plus any
// reclaim credit-back) to commit or roll back together atomically.
type Tx = Prisma.TransactionClient;

export type DispatchClaimResult = { status: "OK" } | { status: "NOT_DISPATCHABLE" } | { status: "TRUCK_BUSY" } | { status: "PUMP_BUSY" } | { status: "CREW_BUSY" };

export async function claimTripSlot(
  tx: Tx,
  params: { ticketId: string; truckId: string; pumpId?: string | null; pumpOperatorId?: string | null; pumpAssistantId?: string | null },
): Promise<DispatchClaimResult> {
  // Re-verify status/reversedAt fresh, inside the caller's own
  // Serializable transaction — a plain pre-transaction read would miss a
  // reversal committed in the gap. If reverseBatchTicket's own
  // transaction (also Serializable — see src/lib/batchCompletion.ts)
  // commits first, this read sees reversedAt set; if the two are truly
  // concurrent, Postgres aborts one of them with a serialization failure
  // regardless. Either way, dispatch and reversal can never both succeed
  // for the same ticket.
  const freshTicket = await tx.batchTicket.findUnique({ where: { id: params.ticketId }, select: { status: true, reversedAt: true } });
  if (!freshTicket || freshTicket.status !== "COMPLETE" || freshTicket.reversedAt) return { status: "NOT_DISPATCHABLE" };

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

  return { status: "OK" };
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
