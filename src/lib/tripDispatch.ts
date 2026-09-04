import "server-only";
import type { Prisma } from "@prisma/client";

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
