import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Aggregate-family materials get moisture-corrected at batch time; cement,
// admixture and water do not (this mirrors the moisture-correction rule in
// the Batchline design spec — only aggregates carry surface moisture).
export const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

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
export async function findMatchingHopper(
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

export async function findMatchingSilo(db: Prisma.TransactionClient | typeof prisma, plantId: string, siteId: string, materialId: string, materialType: string) {
  const ownAssigned = await db.silo.findFirst({ where: { plantId, materialId } });
  if (ownAssigned) return ownAssigned;
  const sharedAssigned = await db.silo.findFirst({ where: { sharedAcrossPlants: true, materialId, plant: { siteId } } });
  if (sharedAssigned) return sharedAssigned;

  const own = await db.silo.findFirst({ where: { plantId, materialType, materialId: null } });
  if (own) return own;
  return db.silo.findFirst({ where: { sharedAcrossPlants: true, materialType, materialId: null, plant: { siteId } } });
}
