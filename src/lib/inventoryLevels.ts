import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

// Every silo/hopper/tank deduction and credit-back in the app used to be a
// plain read-then-write: read currentLevelTons, compute
// Math.max(0, level - massTons) in JS, write that number back. Two
// concurrent deductions against the same store (two batch completions
// drawing the same silo, a completion racing a reclaim credit-back, and
// so on) can each read the SAME starting level before either commits, and
// each write back a result computed from that same stale read — 100t on
// hand, two 10t deductions, and the second write can land as 90 instead
// of the correct 80, silently absorbing one of the two deductions.
//
// These helpers do the arithmetic (and the same clamp-at-zero floor the
// old JS code had, PLUS a clamp at the store's own capacity — nothing
// before this stopped a receipt, a reclaim credit, or a manual reading
// from pushing currentLevelTons/Liters above capacityTons/Liters, which
// then throws off every "% full" bar and low-stock threshold reading in
// the app) entirely inside one SQL UPDATE via
// LEAST(capacity, GREATEST(0, level + delta)) — the database computes the
// new value from whatever the row currently holds at the instant it
// runs, not from a value read earlier in application code, so the race
// above can't happen regardless of transaction isolation level. delta is
// negative for a deduction, positive for a credit; the resulting level is
// returned via RETURNING so callers that need it (auto-requisition
// threshold checks) don't need a second read.
// Returns null (rather than throwing) when siloId doesn't match any row —
// callers that already confirmed the row exists can ignore this, callers
// that were previously guarding with `if (silo) { ...update... }` on a
// separate existence read can drop that read and check this return value
// instead.
export async function adjustSiloLevel(db: Db, siloId: string, deltaTons: number): Promise<number | null> {
  const rows = await db.$queryRaw<{ currentLevelTons: number }[]>`
    UPDATE "Silo" SET "currentLevelTons" = LEAST("capacityTons", GREATEST(0, "currentLevelTons" + ${deltaTons}))
    WHERE id = ${siloId} RETURNING "currentLevelTons"`;
  return rows[0]?.currentLevelTons ?? null;
}

export async function adjustHopperLevel(db: Db, hopperId: string, deltaTons: number): Promise<number | null> {
  const rows = await db.$queryRaw<{ currentLevelTons: number }[]>`
    UPDATE "Hopper" SET "currentLevelTons" = LEAST("capacityTons", GREATEST(0, "currentLevelTons" + ${deltaTons}))
    WHERE id = ${hopperId} RETURNING "currentLevelTons"`;
  return rows[0]?.currentLevelTons ?? null;
}

// ChemicalTank.capacityLiters is nullable (a tank with no known capacity
// has no ceiling to enforce, same as it already has no percentage to
// compare a low-stock threshold against elsewhere in the app) — the CASE
// skips the LEAST clamp entirely rather than letting a NULL capacity
// propagate through LEAST() and null out the whole level.
export async function adjustChemicalTankLevel(db: Db, tankId: string, deltaLiters: number): Promise<number | null> {
  const rows = await db.$queryRaw<{ currentLevelLiters: number }[]>`
    UPDATE "ChemicalTank" SET "currentLevelLiters" = CASE
      WHEN "capacityLiters" IS NULL THEN GREATEST(0, "currentLevelLiters" + ${deltaLiters})
      ELSE LEAST("capacityLiters", GREATEST(0, "currentLevelLiters" + ${deltaLiters}))
    END
    WHERE id = ${tankId} RETURNING "currentLevelLiters"`;
  return rows[0]?.currentLevelLiters ?? null;
}
