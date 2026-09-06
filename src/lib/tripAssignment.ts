import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRetry } from "@/lib/inventoryLedger";
import { lockPlantSiteId } from "@/lib/siteScope";

type Tx = Prisma.TransactionClient;

// See the same note on production/actions.ts's own TX_OPTIONS — several
// sequential round trips (the row locks below, then claimTripResources'
// own truck/driver/pump/crew locks and reads) can add up on a cold Neon
// connection.
const TX_OPTIONS = { timeout: 15000 };

// The shared resource-safety gate for BOTH startTrip and
// updateTripAssignment (production/actions.ts) — PL-P1-02, first
// production-lifecycle review. Before this, startTrip validated truck/
// pump/crew existence, status, site, and reach OUTSIDE the transaction
// (stale by the time the transaction actually committed), never checked
// whether the driver already had another open trip at all, and
// updateTripAssignment skipped nearly all of this, checking only whether
// the truck itself was busy. A crafted or merely slow reassignment could
// attach an out-of-service, cross-site, undersized, or already-busy
// resource, remove the pump a PUMP-delivery trip actually needs, or
// double-book a driver/pump/crew member across two open trips.
//
// Takes the transaction client directly and does its own row locking
// (PL-P1-02 requirement #6: lock resource rows in deterministic order) —
// Truck, then Employee (driver), then Pump, then PumpCrewMember (operator
// and assistant, sorted by id) — so two concurrent calls that both touch
// the same resource always take their locks in the same order and never
// deadlock each other. Each lock is a plain `SELECT id ... FOR UPDATE`
// (same shape as closeReservationForId/releaseTicketForReservation's own
// row locks) followed by a normal Prisma read for the actual fields —
// the read is guaranteed fresh once the lock is held, exactly like every
// other locked-read pattern in this codebase.
//
// siteId here is the ticket/trip's OWN site (already re-verified against
// the caller's allowedSiteId by whoever calls this — see startTrip/
// updateTripAssignment) — used only to check that the CHOSEN truck/pump
// actually belongs to it, same scope rule the pre-existing inline checks
// used. excludeTripId lets updateTripAssignment's own busy checks ignore
// the trip being reassigned itself.
export type TripResourceInput = {
  siteId: string;
  truckId: string;
  driverId: string;
  loadVolumeM3: number;
  isPumpDelivery: boolean;
  pumpId: string | null;
  pumpOperatorId: string | null;
  pumpAssistantId: string | null;
  minPumpReachM: number | null;
  excludeTripId?: string;
};

export type TripResourceResult =
  | { status: "OK"; pumpOperatorName: string | null; pumpAssistantName: string | null }
  | { status: "TRUCK_NOT_FOUND" }
  | { status: "TRUCK_OUT_OF_SERVICE" }
  | { status: "TRUCK_OUT_OF_SCOPE" }
  | { status: "TRUCK_CAPACITY_EXCEEDED" }
  | { status: "TRUCK_BUSY" }
  | { status: "DRIVER_NOT_FOUND" }
  | { status: "DRIVER_INACTIVE" }
  | { status: "DRIVER_BUSY" }
  | { status: "PUMP_REQUIRED" }
  | { status: "PUMP_NOT_FOUND" }
  | { status: "PUMP_OUT_OF_SERVICE" }
  | { status: "PUMP_OUT_OF_SCOPE" }
  | { status: "PUMP_INSUFFICIENT_REACH" }
  | { status: "PUMP_REACH_UNKNOWN" }
  | { status: "PUMP_OPERATOR_REQUIRED" }
  | { status: "PUMP_BUSY" }
  | { status: "PUMP_CREW_SAME_PERSON" }
  | { status: "PUMP_OPERATOR_INVALID" }
  | { status: "PUMP_ASSISTANT_INVALID" }
  | { status: "CREW_BUSY" };

function busyTripWhere(field: "truckId" | "driverId" | "pumpId", id: string, excludeTripId?: string) {
  return { [field]: id, status: { not: "CLOSED" }, ...(excludeTripId ? { id: { not: excludeTripId } } : {}) };
}

export async function claimTripResources(tx: Tx, input: TripResourceInput): Promise<TripResourceResult> {
  if (input.pumpOperatorId && input.pumpOperatorId === input.pumpAssistantId) return { status: "PUMP_CREW_SAME_PERSON" };

  await tx.$queryRaw`SELECT "id" FROM "Truck" WHERE "id" = ${input.truckId} FOR UPDATE`;
  const truck = await tx.truck.findUnique({ where: { id: input.truckId }, select: { status: true, drumCapacityM3: true, plantId: true } });
  if (!truck) return { status: "TRUCK_NOT_FOUND" };
  if (truck.status === "OUT_OF_SERVICE" || truck.status === "MAINTENANCE") return { status: "TRUCK_OUT_OF_SERVICE" };
  // Locked, not just joined (PL-R2-P1-03, second production-lifecycle
  // review) — see lockPlantSiteId's own comment (siteScope.ts) for why a
  // plain read of a resource's own Plant.siteId isn't authoritative on
  // its own: an ADMIN can move this exact Plant to another site mid-flight.
  const truckPlantSiteId = await lockPlantSiteId(tx, truck.plantId);
  if (truckPlantSiteId !== input.siteId) return { status: "TRUCK_OUT_OF_SCOPE" };
  if (input.loadVolumeM3 > truck.drumCapacityM3) return { status: "TRUCK_CAPACITY_EXCEEDED" };
  if (await tx.trip.findFirst({ where: busyTripWhere("truckId", input.truckId, input.excludeTripId) })) return { status: "TRUCK_BUSY" };

  await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${input.driverId} FOR UPDATE`;
  const driver = await tx.employee.findUnique({ where: { id: input.driverId } });
  if (!driver || driver.role !== "DRIVER") return { status: "DRIVER_NOT_FOUND" };
  if (driver.status !== "ACTIVE") return { status: "DRIVER_INACTIVE" };
  if (await tx.trip.findFirst({ where: busyTripWhere("driverId", input.driverId, input.excludeTripId) })) return { status: "DRIVER_BUSY" };

  if (!input.isPumpDelivery) return { status: "OK", pumpOperatorName: null, pumpAssistantName: null };
  if (!input.pumpId) return { status: "PUMP_REQUIRED" };
  // A PUMP delivery with no operator at all is an incomplete dispatch —
  // the UI's own picker already marks this required, but a crafted or
  // stale request must never be trusted to have kept that constraint
  // (PL-R2-P2-03, second production-lifecycle review). A helper remains
  // optional, matching the UI's own stated policy.
  if (!input.pumpOperatorId) return { status: "PUMP_OPERATOR_REQUIRED" };

  await tx.$queryRaw`SELECT "id" FROM "Pump" WHERE "id" = ${input.pumpId} FOR UPDATE`;
  const pump = await tx.pump.findUnique({ where: { id: input.pumpId }, select: { status: true, reachM: true, plantId: true } });
  if (!pump) return { status: "PUMP_NOT_FOUND" };
  if (pump.status === "OUT_OF_SERVICE" || pump.status === "MAINTENANCE") return { status: "PUMP_OUT_OF_SERVICE" };
  const pumpPlantSiteId = await lockPlantSiteId(tx, pump.plantId);
  if (pumpPlantSiteId !== input.siteId) return { status: "PUMP_OUT_OF_SCOPE" };
  if (input.minPumpReachM != null) {
    // An unknown reach must never satisfy a stated minimum — the old
    // check only rejected a KNOWN reach below the minimum, silently
    // passing a pump whose reach was simply never recorded (PL-R2-P2-03).
    if (pump.reachM == null) return { status: "PUMP_REACH_UNKNOWN" };
    if (pump.reachM < input.minPumpReachM) return { status: "PUMP_INSUFFICIENT_REACH" };
  }
  if (await tx.trip.findFirst({ where: busyTripWhere("pumpId", input.pumpId, input.excludeTripId) })) return { status: "PUMP_BUSY" };

  let pumpOperatorName: string | null = null;
  let pumpAssistantName: string | null = null;
  const crewIds = [input.pumpOperatorId, input.pumpAssistantId].filter((v): v is string => Boolean(v)).sort();
  for (const id of crewIds) {
    await tx.$queryRaw`SELECT "id" FROM "PumpCrewMember" WHERE "id" = ${id} FOR UPDATE`;
  }
  const operator = await tx.pumpCrewMember.findUnique({ where: { id: input.pumpOperatorId } });
  if (!operator || operator.role !== "OPERATOR" || operator.status !== "ACTIVE") return { status: "PUMP_OPERATOR_INVALID" };
  pumpOperatorName = operator.name;
  if (input.pumpAssistantId) {
    const asst = await tx.pumpCrewMember.findUnique({ where: { id: input.pumpAssistantId } });
    if (!asst || asst.role !== "HELPER" || asst.status !== "ACTIVE") return { status: "PUMP_ASSISTANT_INVALID" };
    pumpAssistantName = asst.name;
  }
  const crewBusy = await tx.trip.findFirst({
    where: {
      status: { not: "CLOSED" },
      OR: [{ pumpOperatorId: { in: crewIds } }, { pumpAssistantId: { in: crewIds } }],
      ...(input.excludeTripId ? { id: { not: input.excludeTripId } } : {}),
    },
  });
  if (crewBusy) return { status: "CREW_BUSY" };

  return { status: "OK", pumpOperatorName, pumpAssistantName };
}

export type ReassignTripResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "NOT_LOADING" } | Exclude<TripResourceResult, { status: "OK" }>;

// Extracted out of updateTripAssignment (production/actions.ts) — a pure
// domain function, no session/formData access, so it's callable from
// tests directly, same split as closeReservationForId/
// releaseTicketForReservation. PL-P1-01/PL-P1-02, first production-
// lifecycle review: the old version never checked the trip's own site
// against the actor's allowed scope at all (a plant-scoped operator who
// knew or guessed another site's trip id could reassign it), and
// validated almost nothing about the chosen resources beyond whether the
// truck itself was already busy.
export async function reassignTrip(
  tripId: string,
  opts: { truckId: string; driverId: string; pumpId: string | null; pumpOperatorId: string | null; pumpAssistantId: string | null; allowedSiteId: string | null; actorId: string; actorRole: string },
): Promise<ReassignTripResult> {
  // withRetry (src/lib/inventoryLedger.ts) — same reasoning as
  // startTrip's own dispatch transaction (production/actions.ts): a
  // transaction that was already mid-flight when a concurrent
  // reassignment or dispatch for the same resource committed can hit a
  // genuine Postgres serialization failure on its own pre-commit
  // snapshot rather than a clean typed busy result: retrying re-runs the
  // whole attempt against a fresh snapshot instead of failing outright.
  return withRetry(() =>
    prisma.$transaction(
      async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Trip" WHERE "id" = ${tripId} FOR UPDATE`;
      if (locked.length === 0) return { status: "NOT_FOUND" as const };

      const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, include: { batchTicket: { include: { reservation: true } } } });
      // Locked, not just joined — see lockPlantSiteId's own comment
      // (siteScope.ts) for why (PL-R2-P1-03, second production-lifecycle
      // review).
      const ticketPlantSiteId = await lockPlantSiteId(tx, trip.batchTicket.plantId);
      // Out-of-scope and "doesn't exist" both resolve to NOT_FOUND — same
      // "a scope mismatch behaves like not-found" convention as every
      // other domain function in this app.
      if (opts.allowedSiteId !== null && ticketPlantSiteId !== opts.allowedSiteId) return { status: "NOT_FOUND" as const };
      // Correctable only up until the trip actually leaves the yard.
      if (trip.status !== "LOADING") return { status: "NOT_LOADING" as const };

      const isPumpDelivery = trip.batchTicket.reservation.deliveryMethod === "PUMP";
      const resources = await claimTripResources(tx, {
        siteId: ticketPlantSiteId!,
        truckId: opts.truckId,
        driverId: opts.driverId,
        loadVolumeM3: trip.batchTicket.volumeM3,
        isPumpDelivery,
        pumpId: isPumpDelivery ? opts.pumpId : null,
        pumpOperatorId: isPumpDelivery ? opts.pumpOperatorId : null,
        pumpAssistantId: isPumpDelivery ? opts.pumpAssistantId : null,
        minPumpReachM: trip.batchTicket.reservation.minPumpReachM,
        excludeTripId: tripId,
      });
      if (resources.status !== "OK") return resources;

      await tx.trip.update({
        where: { id: tripId },
        data: {
          truckId: opts.truckId,
          driverId: opts.driverId,
          pumpId: isPumpDelivery ? opts.pumpId : null,
          pumpOperatorId: isPumpDelivery ? opts.pumpOperatorId : null,
          pumpOperatorName: resources.pumpOperatorName,
          pumpAssistantId: isPumpDelivery ? opts.pumpAssistantId : null,
          pumpAssistantName: resources.pumpAssistantName,
        },
      });
      // Written in the SAME transaction as the reassignment itself
      // (PL-P2-03), using the real authenticated actor.
      await tx.auditEvent.create({
        data: { actorId: opts.actorId, role: opts.actorRole, module: "Fleet", recordId: tripId, afterValue: `${opts.truckId}/${opts.driverId}`, reasonCode: "TRIP_ASSIGNMENT_UPDATED" },
      });

        return { status: "OK" as const };
      },
      { ...TX_OPTIONS, isolationLevel: "Serializable" },
    ),
  );
}
