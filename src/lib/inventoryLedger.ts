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

// A single explicit epsilon (in the movement's own unit — tons for
// Silo/Hopper, liters for ChemicalTank), used everywhere this module
// decides "is this shortfall/applied-delta effectively zero." A floating-
// point tolerance, NOT a business "small quantity" cutoff. A fourth
// external review caught that this module used to mix two different ad-
// hoc thresholds: shortfall/capacity checks compared against a whole
// 0.001 (a full kg/liter), while the zero-effect check (below) had
// already been tightened to 1e-9 by an earlier review — so a real
// shortfall UNDER 1kg/1L slipped through with no shortage flagged and no
// override needed at all, the opposite of "every real event has a
// nonzero footprint" this whole ledger exists to enforce. One constant,
// used consistently, closes that gap.
export const EPSILON = 1e-6;

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
  /**
   * How much of a consumption shortfall (in this movement's own unit) may
   * be clamped through instead of rejected outright — a real, audited
   * ceiling bound to a specific approved ShortageOverrideRequest (P1-03,
   * fourth review), never a blanket "any shortfall is fine" boolean. A
   * real shortfall bigger than this still throws INSUFFICIENT_STOCK, so
   * an approval only ever covers exactly what it was given for. Omit (or
   * 0) to reject any shortfall at all — the default, safe posture.
   * Ignored for a credit (positive quantity): there's no equivalent
   * override for losing material off the top of a full silo.
   */
  maxAllowedShortfall?: number;
};

export type MovementResult =
  | { status: "OK"; appliedQuantity: number; newLevel: number; shortfallAllowed: number }
  | { status: "ALREADY_POSTED" }
  | { status: "STORAGE_NOT_CONFIGURED" };

export class DomainError extends Error {
  constructor(
    public code: "INSUFFICIENT_STOCK" | "CAPACITY_EXCEEDED" | "CONCURRENT_CONFLICT" | "STORAGE_NOT_CONFIGURED" | "NO_POSTED_MOVEMENTS",
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
  const maxAllowedShortfall = Math.max(0, input.maxAllowedShortfall ?? 0);
  if (isConsumption && shortfall > maxAllowedShortfall + EPSILON) {
    // Rolls back the balance update above — the whole point of computing
    // the shortfall before ever recording a movement, rather than
    // clamping silently and moving on. Fires for ANY real shortfall
    // beyond what maxAllowedShortfall actually covers — including one
    // smaller than a whole kg/liter, and including one that exceeds an
    // approved request's own snapshotted amount (P1-03).
    throw new DomainError("INSUFFICIENT_STOCK", `Insufficient stock on ${storageType} ${input.storageId}: requested ${Math.abs(input.quantity)}, only ${Math.abs(applied)} available`);
  }
  if (!isConsumption && shortfall > EPSILON) {
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

  // How much of a real shortfall this call actually let through — 0 for
  // an exact/near-exact fill, otherwise the audited amount that was
  // within maxAllowedShortfall. The caller (completeBatchTicket) uses
  // this, not a separate recomputation, to decide whether an approved
  // request was actually needed and should be marked consumed — one
  // source of truth for "did a real shortage happen here."
  const shortfallAllowed = isConsumption ? Math.max(0, shortfall) : 0;

  // A zero-effect movement — either a fully-authorized shortage against a
  // completely empty store (applied clamps all the way to 0), or a
  // genuinely zero-quantity request (an actualMassKg of exactly 0kg is a
  // real, reachable weighed value) — posts no ledger row at all. The
  // table's own quantity<>0 CHECK constraint (see the migration) exists
  // precisely so a real event always has a nonzero footprint; a zero-
  // effect "event" isn't one, and there's nothing for a later reversal to
  // undo either way. Found this the hard way: the very first version of
  // this function tried to insert quantity=0 whenever a shortage override
  // hit a fully-empty store and got a raw, unhandled CHECK-constraint
  // failure instead of a clean result. EPSILON here is the same floating-
  // point tolerance used above, not a business "small quantity" cutoff —
  // only a TRUE no-op (oldLevel and newLevel land on the exact same clamp
  // boundary) skips posting; a genuinely tiny but real movement still
  // gets its own ledger row.
  if (Math.abs(applied) < EPSILON) {
    return { status: "OK", appliedQuantity: 0, newLevel, shortfallAllowed };
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

  return { status: "OK", appliedQuantity: applied, newLevel, shortfallAllowed };
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
