import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

// Every function here takes a real transaction handle, never the plain
// prisma singleton — postMovement's two-statement SELECT ... FOR UPDATE
// then UPDATE only hold their row lock across both statements if they run
// inside the same database transaction. Calling this outside a
// prisma.$transaction is a programming error, not something to degrade
// gracefully from.
type Tx = Prisma.TransactionClient;

export type MovementInput = {
  storageId: string;
  materialId: string;
  quantity: number; // signed: negative = consumption, positive = credit
  movementType: string;
  sourceType: string;
  sourceId: string;
  plantId: string;
  siteId: string;
  actorId?: string | null;
  reason?: string | null;
  /** Allow this movement to be clamped at zero (a real, audited shortage) instead of being rejected outright. */
  allowShortage?: boolean;
};

export type MovementResult =
  | { status: "OK"; appliedQuantity: number; newLevel: number }
  | { status: "ALREADY_POSTED" }
  | { status: "STORAGE_NOT_CONFIGURED" };

export class DomainError extends Error {
  constructor(
    public code: "INSUFFICIENT_STOCK" | "CAPACITY_EXCEEDED" | "CONCURRENT_CONFLICT" | "STORAGE_NOT_CONFIGURED",
    message?: string,
  ) {
    super(message ?? code);
  }
}

// Cheap idempotency pre-check — no row lock taken. Both real callers
// (completeBatchTicket, reverseBatchTicket) already hold their OWN
// ticket-level atomic claim (an updateMany on BatchTicket) before they
// ever loop into postMovement, so two calls for the truly same movement
// should never reach here concurrently in practice; this is a fast-path
// no-op for the "already ran, someone retried the outer call" case, not
// the primary correctness mechanism (that's the storage row lock +
// unique-constrained insert below, which stays correct even without this
// check).
async function alreadyPosted(tx: Tx, input: MovementInput): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "InventoryMovement"
    WHERE "sourceType" = ${input.sourceType} AND "sourceId" = ${input.sourceId} AND "movementType" = ${input.movementType}
      AND "materialId" = ${input.materialId} AND "storageId" = ${input.storageId}`;
  return rows.length > 0;
}

// The real idempotency claim, posted AFTER the balance is adjusted (see
// postMovement below) so the recorded quantity is always the TRUE applied
// delta — never the pre-clamp requested one, which would make a later
// reversal over-credit a shortage that was allowed through with an
// override note. INSERT ... ON CONFLICT DO NOTHING is intentional here
// rather than `create()` in a try/catch for a unique-constraint error:
// Postgres aborts the whole transaction on a statement error until
// rollback, so catching a P2002 and continuing in the same tx would just
// fail on the very next statement. ON CONFLICT DO NOTHING has no such
// problem — a conflicting row simply isn't inserted, RETURNING gives back
// nothing, and the transaction stays healthy.
async function claimMovement(tx: Tx, storageType: string, input: MovementInput, appliedQuantity: number): Promise<string | null> {
  const id = randomUUID();
  const unit = storageType === "CHEMICAL_TANK" ? "LITERS" : "TONS";
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "InventoryMovement"
      ("id", "storageType", "storageId", "materialId", "quantity", "unit", "movementType", "sourceType", "sourceId", "plantId", "siteId", "actorId", "reason", "createdAt")
    VALUES
      (${id}, ${storageType}, ${input.storageId}, ${input.materialId}, ${appliedQuantity}, ${unit}, ${input.movementType}, ${input.sourceType}, ${input.sourceId}, ${input.plantId}, ${input.siteId}, ${input.actorId ?? null}, ${input.reason ?? null}, now())
    ON CONFLICT ("sourceType", "sourceId", "movementType", "materialId", "storageId") DO NOTHING
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}

// The atomic read-modify-write: SELECT ... FOR UPDATE takes a row lock and
// blocks until it can return the row's true, post-commit value (unlike a
// plain SELECT, which would see a stale snapshot under a concurrent
// writer) — then the UPDATE that follows, still holding that same lock in
// the same transaction, computes the new clamped value from that same
// row. Nothing can interleave between the two statements. Returns null if
// storageId matches no row.
async function lockAndAdjust(
  tx: Tx,
  table: "Silo" | "Hopper" | "ChemicalTank",
  levelColumn: string,
  capacityColumn: string,
  capacityNullable: boolean,
  storageId: string,
  delta: number,
): Promise<{ oldLevel: number; newLevel: number } | null> {
  const before = await tx.$queryRawUnsafe<{ level: number }[]>(
    `SELECT "${levelColumn}" AS level FROM "${table}" WHERE id = $1 FOR UPDATE`,
    storageId,
  );
  const oldLevel = before[0]?.level;
  if (oldLevel === undefined) return null;

  const setExpr = capacityNullable
    ? `CASE WHEN "${capacityColumn}" IS NULL THEN GREATEST(0, "${levelColumn}" + $1) ELSE LEAST("${capacityColumn}", GREATEST(0, "${levelColumn}" + $1)) END`
    : `LEAST("${capacityColumn}", GREATEST(0, "${levelColumn}" + $1))`;
  const after = await tx.$queryRawUnsafe<{ level: number }[]>(
    `UPDATE "${table}" SET "${levelColumn}" = ${setExpr} WHERE id = $2 RETURNING "${levelColumn}" AS level`,
    delta,
    storageId,
  );
  return { oldLevel, newLevel: after[0].level };
}

async function postMovement(
  tx: Tx,
  storageType: "SILO" | "HOPPER" | "CHEMICAL_TANK",
  table: "Silo" | "Hopper" | "ChemicalTank",
  levelColumn: string,
  capacityColumn: string,
  capacityNullable: boolean,
  input: MovementInput,
): Promise<MovementResult> {
  if (await alreadyPosted(tx, input)) return { status: "ALREADY_POSTED" };

  const adjusted = await lockAndAdjust(tx, table, levelColumn, capacityColumn, capacityNullable, input.storageId, input.quantity);
  if (!adjusted) return { status: "STORAGE_NOT_CONFIGURED" };

  const { oldLevel, newLevel } = adjusted;
  const applied = newLevel - oldLevel;
  const isConsumption = input.quantity < 0;
  const shortfall = Math.abs(input.quantity) - Math.abs(applied);
  if (isConsumption && shortfall > 0.001 && !input.allowShortage) {
    // Rolls back the balance update above — the whole point of computing
    // the shortfall before ever recording a movement, rather than
    // clamping silently and moving on.
    throw new DomainError("INSUFFICIENT_STOCK", `Insufficient stock on ${storageType} ${input.storageId}: requested ${Math.abs(input.quantity)}, only ${Math.abs(applied)} available`);
  }
  if (!isConsumption && shortfall > 0.001) {
    // A credit (reclaim, or a reversal crediting a deduction back) that
    // gets clamped by LEAST(capacity, ...) because the store filled up in
    // the meantime is NOT a lesser version of success — it silently loses
    // the difference and, for a reversal specifically, would let the
    // caller stamp reversedAt over a credit that never actually landed in
    // full. Always a hard failure, never an opt-in like INSUFFICIENT_STOCK
    // — there's no equivalent "audited override" for losing material off
    // the top of a full silo.
    throw new DomainError("CAPACITY_EXCEEDED", `${storageType} ${input.storageId} has no room for the full credit: requested ${input.quantity}, only ${applied} fit`);
  }

  // Record the ledger row with the TRUE applied delta (post-clamp), not
  // the originally requested one — a reversal later reverses exactly what
  // actually happened. Guards the astronomically unlikely case where
  // something raced past the alreadyPosted check above (both real callers
  // hold their own ticket-level claim, so this shouldn't be reachable in
  // practice) by throwing rather than silently under-reporting a balance
  // change that already landed — the caller's retry wrapper will retry
  // this as a fresh attempt.
  const claimedId = await claimMovement(tx, storageType, input, applied);
  if (!claimedId) throw new DomainError("CONCURRENT_CONFLICT", `Movement for ${input.sourceType}/${input.sourceId}/${input.movementType} was posted by another transaction`);

  return { status: "OK", appliedQuantity: applied, newLevel };
}

export function postSiloMovement(tx: Tx, input: MovementInput): Promise<MovementResult> {
  return postMovement(tx, "SILO", "Silo", "currentLevelTons", "capacityTons", false, input);
}

export function postHopperMovement(tx: Tx, input: MovementInput): Promise<MovementResult> {
  return postMovement(tx, "HOPPER", "Hopper", "currentLevelTons", "capacityTons", false, input);
}

export function postChemicalTankMovement(tx: Tx, input: MovementInput): Promise<MovementResult> {
  return postMovement(tx, "CHEMICAL_TANK", "ChemicalTank", "currentLevelLiters", "capacityLiters", true, input);
}

// Bounded, jittered retry for the one class of error that's genuinely
// worth retrying automatically: a Postgres write conflict or deadlock
// (Prisma error code P2034) between two transactions racing the same
// rows. Any other error (including DomainError above) propagates
// immediately — those are real outcomes, not transient contention.
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const isConflict = typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2034";
      if (!isConflict || attempt === maxAttempts - 1) throw e;
      const jitterMs = 25 + Math.random() * 50 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, jitterMs));
    }
  }
  throw lastError;
}
