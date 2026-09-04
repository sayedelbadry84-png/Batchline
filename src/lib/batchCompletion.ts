import "server-only";
import { prisma } from "@/lib/prisma";
import { findMatchingSilo, findMatchingHopper, AGGREGATE_TYPES } from "@/lib/storageMatching";
import { postSiloMovement, postHopperMovement, postChemicalTankMovement, DomainError, withRetry, type MovementResult } from "@/lib/inventoryLedger";

// completeBatch's per-component silo/hopper/tank lookups+posts are several
// sequential round trips to Neon, which can comfortably exceed Prisma's 5s
// default interactive-transaction timeout, especially on a cold
// connection. 15s gives real headroom without masking a genuinely
// broken/looping query. Same figure billing/actions.ts's own TX_OPTIONS uses.
const TX_OPTIONS = { timeout: 15000 };

export type RequisitionCandidate = {
  materialId: string;
  siteId: string;
  newLevel: number;
  capacity: number;
  minThresholdPct: number;
  unit: "TONS" | "LITERS";
  specificGravity?: number;
};

export type CompleteBatchResult =
  | { status: "SUCCESS"; shortages: string[]; requisitionCandidates: RequisitionCandidate[] }
  | { status: "ALREADY_COMPLETED" }
  | { status: "INVALID_STATE" }
  | { status: "INSUFFICIENT_STOCK"; shortages: string[] }
  | { status: "CONCURRENT_CONFLICT" }
  | { status: "STORAGE_NOT_CONFIGURED"; material: string };

// Materials whose type is normally inventory-tracked (they SHOULD always
// resolve to a real silo/hopper/tank) — used to distinguish "this
// material type has nothing to deduct from at all" (a real
// STORAGE_NOT_CONFIGURED failure, CR-02) from a material type this app
// doesn't inventory-track in the first place (left as a no-op, same as
// before this fix — not every BatchComponentActual row necessarily
// represents a physically stocked material).
//
// material.inventoryTracked (schema.prisma) is a per-material override on
// top of this — WATER defaults to tracked like every other normally-
// stocked type, but a site that genuinely doesn't meter a specific water
// material into inventory (municipal supply, no water hopper on file) can
// mark THAT material untracked without affecting every other site's own
// Water material. Checked first so an explicit "don't track this one"
// always wins regardless of type.
function isInventoryTracked(material: { type: string; inventoryTracked: boolean }): boolean {
  if (!material.inventoryTracked) return false;
  return ["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME", "WATER", "ADMIXTURE"].includes(material.type) || AGGREGATE_TYPES.has(material.type);
}

type ResolvedComponent = {
  materialId: string;
  materialName: string;
  storageType: "SILO" | "HOPPER" | "CHEMICAL_TANK";
  storageId: string;
  quantity: number; // negative — this is always a deduction
  capacity: number;
  minThresholdPct: number;
  specificGravity?: number;
};

function isP2034(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2034";
}

/**
 * The domain service behind the "complete batch" action — pure DB logic,
 * no session/formData access, so it's callable from tests directly. Claims
 * the ticket, resolves every component's target storage, posts one
 * BATCH_COMPLETION movement per component through the ledger (see
 * src/lib/inventoryLedger.ts), and flips the ticket to COMPLETE, all in
 * one retried, Postgres-atomic transaction. A repeated call for the same
 * ticket changes nothing (see the ledger's own idempotency claim) beyond
 * returning ALREADY_COMPLETED.
 */
export async function completeBatchTicket(
  ticketId: string,
  opts: { shortageOverrideNote?: string | null; actorId?: string | null },
): Promise<CompleteBatchResult> {
  const exists = await prisma.batchTicket.findUnique({ where: { id: ticketId }, select: { id: true } });
  if (!exists) return { status: "INVALID_STATE" };

  try {
    return await withRetry(() =>
      prisma.$transaction(async (tx) => {
        // Claim the ticket atomically, first thing inside the transaction
        // — a plain pre-transaction status read would let two concurrent
        // completions of the same ticket both pass it and both post
        // deductions for one physical batch. Postgres row-locks this
        // UPDATE, so only the first caller's WHERE clause can still match
        // a non-terminal status; the second's updateMany matches zero
        // rows and this returns ALREADY_COMPLETED without touching
        // anything else — an expected, not exceptional, outcome.
        const claim = await tx.batchTicket.updateMany({
          where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } },
          data: { status: "COMPLETE", batchCompletedAt: new Date() },
        });
        if (claim.count === 0) return { status: "ALREADY_COMPLETED" as const };

        // The authoritative read happens AFTER the claim, inside the same
        // transaction — not before it. Reading components before the
        // claim (the original version of this function) meant a
        // concurrent actual/component edit that raced the claim could
        // leave the ledger posting against a stale snapshot instead of
        // whatever the ticket showed at the instant it actually became
        // COMPLETE. recordActuals/recordActualField/addTicketComponent/
        // deleteTicketComponent (production/actions.ts) now hold their
        // own atomic claim against this same row before writing a
        // component, so whichever side — this claim or theirs — commits
        // first is what the other sees.
        const ticket = await tx.batchTicket.findUnique({
          where: { id: ticketId },
          include: { components: { include: { material: true } }, plant: true },
        });
        if (!ticket) throw new DomainError("CONCURRENT_CONFLICT", "ticket vanished mid-transaction");

        // Resolve every component's target storage before posting
        // anything to the ledger. A material type this app doesn't
        // inventory-track at all (see isInventoryTracked) is skipped, as
        // before — but a material type that SHOULD have a matching store
        // and doesn't is now a hard failure (STORAGE_NOT_CONFIGURED),
        // never a silent skip: the ticket used to still complete
        // successfully with that component's material never actually
        // deducted from anywhere, which is exactly the kind of gap this
        // whole ledger exists to close.
        const resolved: ResolvedComponent[] = [];
        for (const c of ticket.components) {
          if (!isInventoryTracked(c.material)) continue;

          const massKg = c.actualMassKg ?? c.targetMassKg;
          const massTons = massKg / 1000;

          if (["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME"].includes(c.material.type)) {
            const silo = await findMatchingSilo(tx, ticket.plantId, ticket.plant.siteId, c.materialId, c.material.type);
            if (!silo) throw new DomainError("STORAGE_NOT_CONFIGURED", c.material.name);
            resolved.push({ materialId: c.materialId, materialName: c.material.name, storageType: "SILO", storageId: silo.id, quantity: -massTons, capacity: silo.capacityTons, minThresholdPct: silo.minThresholdPct });
          } else if (AGGREGATE_TYPES.has(c.material.type)) {
            const hopper = await findMatchingHopper(tx, ticket.plantId, ticket.plant.siteId, c.materialId, c.material.type === "SAND" ? { equals: "SAND" } : { startsWith: "COARSE" });
            if (!hopper) throw new DomainError("STORAGE_NOT_CONFIGURED", c.material.name);
            resolved.push({ materialId: c.materialId, materialName: c.material.name, storageType: "HOPPER", storageId: hopper.id, quantity: -massTons, capacity: hopper.capacityTons, minThresholdPct: hopper.minThresholdPct });
          } else if (c.material.type === "WATER") {
            const waterHopper = await findMatchingHopper(tx, ticket.plantId, ticket.plant.siteId, c.materialId, { equals: "WATER" });
            if (!waterHopper) throw new DomainError("STORAGE_NOT_CONFIGURED", c.material.name);
            resolved.push({ materialId: c.materialId, materialName: c.material.name, storageType: "HOPPER", storageId: waterHopper.id, quantity: -massTons, capacity: waterHopper.capacityTons, minThresholdPct: waterHopper.minThresholdPct });
          } else if (c.material.type === "ADMIXTURE") {
            if (!c.material.specificGravity) throw new DomainError("STORAGE_NOT_CONFIGURED", `${c.material.name} (missing specific gravity)`);
            const tank = await tx.chemicalTank.findFirst({ where: { plantId: ticket.plantId, materialId: c.materialId } });
            if (!tank) throw new DomainError("STORAGE_NOT_CONFIGURED", c.material.name);
            const liters = massKg / c.material.specificGravity;
            resolved.push({ materialId: c.materialId, materialName: c.material.name, storageType: "CHEMICAL_TANK", storageId: tank.id, quantity: -liters, capacity: tank.capacityLiters ?? 0, minThresholdPct: tank.minThresholdPct, specificGravity: c.material.specificGravity });
          }
        }

        // Sort before iterating — completeBatchTicket, startTrip's reclaim
        // credit-back, and reverseBatchTicket all touch the same kind of
        // rows for one ticket; iterating in a consistent order across all
        // three avoids a lock-ordering deadlock between concurrent
        // transactions that a bounded retry would otherwise just paper
        // over.
        resolved.sort((a, b) => (a.storageType === b.storageType ? a.storageId.localeCompare(b.storageId) : a.storageType.localeCompare(b.storageType)));

        const shortages: string[] = [];
        const requisitionCandidates: RequisitionCandidate[] = [];
        for (const r of resolved) {
          const post = r.storageType === "SILO" ? postSiloMovement : r.storageType === "HOPPER" ? postHopperMovement : postChemicalTankMovement;
          const movement: MovementResult = await post(tx, {
            storageId: r.storageId,
            materialId: r.materialId,
            quantity: r.quantity,
            movementType: "BATCH_COMPLETION",
            sourceType: "BatchTicket",
            sourceId: ticketId,
            plantId: ticket.plantId,
            siteId: ticket.plant.siteId,
            actorId: opts.actorId ?? null,
            reason: opts.shortageOverrideNote ?? null,
            allowShortage: !!opts.shortageOverrideNote,
          });

          if (movement.status === "ALREADY_POSTED") continue; // a retried attempt after this exact component already landed
          if (movement.status === "STORAGE_NOT_CONFIGURED") {
            // The storage we JUST resolved above vanished before we could
            // post to it — near-impossible outside real data corruption.
            // Roll back the whole completion rather than commit a partial
            // deduction across only some of the ticket's components.
            throw new DomainError("STORAGE_NOT_CONFIGURED", r.materialName);
          }

          if (Math.abs(movement.appliedQuantity) < Math.abs(r.quantity) - 0.001) {
            shortages.push(`${r.materialName}: requested ${Math.abs(r.quantity).toFixed(2)}, applied ${Math.abs(movement.appliedQuantity).toFixed(2)}`);
          }
          requisitionCandidates.push({
            materialId: r.materialId,
            siteId: ticket.plant.siteId,
            newLevel: movement.newLevel,
            capacity: r.capacity,
            minThresholdPct: r.minThresholdPct,
            unit: r.storageType === "CHEMICAL_TANK" ? "LITERS" : "TONS",
            specificGravity: r.specificGravity,
          });
        }

        return { status: "SUCCESS" as const, shortages, requisitionCandidates };
      }, TX_OPTIONS),
    );
  } catch (e) {
    if (e instanceof DomainError) {
      if (e.code === "INSUFFICIENT_STOCK") return { status: "INSUFFICIENT_STOCK", shortages: [e.message] };
      if (e.code === "STORAGE_NOT_CONFIGURED") return { status: "STORAGE_NOT_CONFIGURED", material: e.message };
      return { status: "CONCURRENT_CONFLICT" };
    }
    if (isP2034(e)) return { status: "CONCURRENT_CONFLICT" };
    throw e;
  }
}

export type ReverseBatchResult =
  | { status: "SUCCESS" }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_STATE" }
  | { status: "ALREADY_REVERSED" }
  | { status: "CONCURRENT_CONFLICT" }
  | { status: "CAPACITY_EXCEEDED"; storage: string }
  | { status: "STORAGE_NOT_CONFIGURED"; material: string }
  // A COMPLETE ticket with zero posted BATCH_COMPLETION movements — either
  // it predates the ledger entirely (completed before this system
  // existed), or every one of its components happened to apply as a
  // zero-effect movement (see inventoryLedger.ts's own zero-quantity
  // skip). Refusing outright, rather than silently stamping reversedAt
  // with nothing to actually credit back, is the whole point of this
  // status existing.
  | { status: "NO_POSTED_MOVEMENTS" };

/**
 * Undoes a completed ticket's posted inventory movements without ever
 * deleting the ticket itself — replaces deleteBatchTicket's old behavior
 * for a COMPLETE ticket (a hard delete that also re-resolved "the current
 * matching silo/hopper" rather than the one actually used at completion
 * time, a latent wrong-storage bug). This reverses the EXACT storageId
 * each original BATCH_COMPLETION movement posted to, not a fresh lookup.
 * Refuses a ticket that's already dispatched (has a Trip) — reversing a
 * ticket a truck already loaded against would orphan that Trip's own
 * RECLAIM_CREDIT movements and its relationship to real physical material
 * already in motion; that needs its own, separate flow, not this one.
 */
export async function reverseBatchTicket(ticketId: string, opts: { actorId: string; reason: string }): Promise<ReverseBatchResult> {
  const ticket = await prisma.batchTicket.findUnique({ where: { id: ticketId }, include: { trip: true } });
  if (!ticket) return { status: "NOT_FOUND" };
  if (ticket.status !== "COMPLETE" || ticket.trip) return { status: "INVALID_STATE" };
  if (ticket.reversedAt) return { status: "ALREADY_REVERSED" };

  try {
    return await withRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Claim the reversal first — same claim-before-work convention
          // as completeBatchTicket's own status claim. Two concurrent
          // reversal requests can only have one of them actually post the
          // opposite movements; the second's updateMany matches zero
          // rows. `trip: null` closes the reversal side of CR-01: without
          // it, a startTrip call that creates a Trip between this
          // function's own pre-transaction read and this claim could
          // still let a reversal through against a ticket that just got
          // dispatched. Serializable isolation is the backstop for the
          // symmetric race — startTrip's own transaction (see
          // production/actions.ts) re-reads this same ticket row inside
          // ITS Serializable transaction before creating the Trip, so
          // whichever of the two transactions commits first is what the
          // other necessarily sees, and Postgres aborts one with a
          // serialization failure if they were truly concurrent.
          const claim = await tx.batchTicket.updateMany({
            where: { id: ticketId, reversedAt: null, trip: null },
            data: { reversedAt: new Date(), reversedById: opts.actorId, reversalReason: opts.reason },
          });
          if (claim.count === 0) {
            // Distinguish why the claim missed — same transaction, so
            // this read is consistent with whatever actually blocked it.
            const fresh = await tx.batchTicket.findUnique({ where: { id: ticketId }, select: { reversedAt: true, trip: { select: { id: true } } } });
            if (fresh?.trip) return { status: "INVALID_STATE" as const };
            return { status: "ALREADY_REVERSED" as const };
          }

          const originalMovements = await tx.inventoryMovement.findMany({
            where: { sourceType: "BatchTicket", sourceId: ticketId, movementType: "BATCH_COMPLETION" },
          });

          // A COMPLETE ticket with nothing posted against it — most likely
          // it predates the ledger (every ticket completed before this
          // system existed has zero InventoryMovement rows) — must never
          // silently stamp reversedAt as if inventory had been restored.
          // Throwing rolls back the claim above too, so the ticket stays
          // exactly as it was: COMPLETE, not reversed, free to try again
          // once/if it's ever legitimately resolved.
          if (originalMovements.length === 0) throw new DomainError("NO_POSTED_MOVEMENTS", ticketId);

          const sorted = [...originalMovements].sort((a, b) => (a.storageType === b.storageType ? a.storageId.localeCompare(b.storageId) : a.storageType.localeCompare(b.storageType)));

          for (const m of sorted) {
            const post = m.storageType === "SILO" ? postSiloMovement : m.storageType === "HOPPER" ? postHopperMovement : postChemicalTankMovement;
            const movement = await post(tx, {
              storageId: m.storageId, // the ORIGINAL storage, not re-resolved
              materialId: m.materialId,
              quantity: -m.quantity, // opposite sign of the original deduction
              movementType: "BATCH_COMPLETION_REVERSAL",
              sourceType: "BatchTicket",
              sourceId: ticketId,
              plantId: m.plantId,
              siteId: m.siteId,
              actorId: opts.actorId,
              reason: opts.reason,
            });
            if (movement.status === "STORAGE_NOT_CONFIGURED") throw new DomainError("STORAGE_NOT_CONFIGURED", m.materialId);
            // ALREADY_POSTED means a retried reversal attempt already
            // landed this exact movement — nothing more to do for it.
            // CAPACITY_EXCEEDED propagates as a DomainError throw from
            // postMovement itself (see inventoryLedger.ts) — rolls back
            // the whole reversal rather than stamping reversedAt over a
            // credit that didn't fully land (CR-04).
          }

          return { status: "SUCCESS" as const };
        },
        { isolationLevel: "Serializable" },
      ),
    );
  } catch (e) {
    if (e instanceof DomainError) {
      if (e.code === "STORAGE_NOT_CONFIGURED") return { status: "STORAGE_NOT_CONFIGURED", material: e.message };
      if (e.code === "CAPACITY_EXCEEDED") return { status: "CAPACITY_EXCEEDED", storage: e.message };
      if (e.code === "NO_POSTED_MOVEMENTS") return { status: "NO_POSTED_MOVEMENTS" };
      return { status: "CONCURRENT_CONFLICT" };
    }
    if (isP2034(e)) return { status: "CONCURRENT_CONFLICT" };
    throw e;
  }
}
