import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withSequentialNumber } from "@/lib/sequence";
import { notifyRoles } from "@/lib/notify";
import { REQUISITION_APPROVAL_ROLES } from "@/lib/permissions";

// Extracted out of production/actions.ts (PL-R8-P2-02, eighth production-
// lifecycle review) so the concurrency behavior below is directly
// testable against real PostgreSQL, not only inspectable as code — the
// same reasoning that already pulled completeBatchTicket/
// claimAndRecordActualField/etc. out of their own Server Actions.

// withSequentialNumber's own P2002 retry loop treats EVERY P2002 as a
// requisitionNumber collision worth retrying with the next number — it
// has no way to know this create can also collide on the DIFFERENT
// partial unique index MaterialRequisition_open_per_material_site_key
// (migration harden_production_lifecycle_round7_part2). An earlier fix
// caught the SYMPTOM (5 exhausted retries, a generic "Could not
// allocate" message) but that message is also exactly what 5 genuine
// requisitionNumber collisions produce — treating it as "an equivalent
// requisition already exists" was itself capable of silently swallowing
// a real allocation failure. This sentinel lets the one create attempt
// that actually hits the open-requisition index escape
// withSequentialNumber's retry immediately (a non-P2002 error skips its
// retry entirely), so a genuine requisitionNumber collision still gets
// its five real retries and anything else still propagates as a real,
// visible failure.
class RequisitionAlreadyOpenError extends Error {}

function isRequisitionOpenConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return typeof target === "string" ? target.includes("open_per_material_site") : Array.isArray(target) && target.some((t) => String(t).includes("open_per_material_site"));
}

export type AutoRequisitionResult =
  | { status: "CREATED"; requisitionId: string; requisitionNumber: string }
  | { status: "ALREADY_OPEN"; requisitionId: string; requisitionNumber: string }
  | { status: "BELOW_THRESHOLD" }
  | { status: "NOT_TRACKED" };

// Raw-material counterpart to issueSparePartToOrder's shortfall handling —
// called from completeBatch right after a silo/hopper/tank's level is
// deducted; if what's left is at or below the store's own minThresholdPct,
// opens a MaterialRequisition for enough to refill it (skipped if capacity
// is unset/zero, since there's then no percentage to compare against, or
// if one's already open for this material+site). toKg converts the
// store's own unit (tons for silo/hopper, liters for a chemical tank) to
// the kg PurchaseOrderLine.orderedMassKg expects.
export async function maybeAutoRequisitionMaterial(
  materialId: string,
  siteId: string,
  currentLevel: number,
  capacity: number,
  minThresholdPct: number,
  toKg: (units: number) => number,
): Promise<AutoRequisitionResult> {
  if (capacity <= 0) return { status: "NOT_TRACKED" };
  if ((currentLevel / capacity) * 100 > minThresholdPct) return { status: "BELOW_THRESHOLD" };

  const shortfall = capacity - currentLevel;
  if (shortfall <= 0) return { status: "BELOW_THRESHOLD" };

  const existing = await prisma.materialRequisition.findFirst({
    where: { materialId, siteId, status: { in: ["PENDING_APPROVAL", "APPROVED", "ORDERED"] } },
  });
  if (existing) return { status: "ALREADY_OPEN", requisitionId: existing.id, requisitionNumber: existing.requisitionNumber };

  // The pre-check above is a plain read with no lock — a genuinely
  // concurrent completion for the same material+site can still race past
  // it and try to create a second open requisition; the partial unique
  // index is the real backstop for that race, classified precisely below.
  let requisition;
  try {
    requisition = await withSequentialNumber(
      "MTR",
      (yr) => prisma.materialRequisition.count({ where: { createdAt: yr } }),
      async (requisitionNumber) => {
        try {
          return await prisma.materialRequisition.create({
            data: { requisitionNumber, materialId, siteId, quantityNeededKg: toKg(shortfall) },
            include: { material: true },
          });
        } catch (e) {
          if (isRequisitionOpenConflict(e)) throw new RequisitionAlreadyOpenError();
          throw e; // a genuine requisitionNumber P2002 falls through unchanged — withSequentialNumber retries it with the next number, exactly as before.
        }
      },
    );
  } catch (e) {
    if (e instanceof RequisitionAlreadyOpenError) {
      // A concurrent completion won the exact race between our own
      // pre-check and this create — an equivalent open requisition now
      // genuinely exists. Return IT (not our own attempt) — the review's
      // own "return the existing open requisition" ask — so both
      // concurrent callers resolve to the SAME row instead of one of
      // them silently doing nothing with no visible result at all.
      const winner = await prisma.materialRequisition.findFirstOrThrow({
        where: { materialId, siteId, status: { in: ["PENDING_APPROVAL", "APPROVED", "ORDERED"] } },
      });
      return { status: "ALREADY_OPEN", requisitionId: winner.id, requisitionNumber: winner.requisitionNumber };
    }
    // Anything else — including 5 real requisitionNumber collisions —
    // is a genuine allocation failure, not a benign duplicate. It
    // propagates to the caller's own failure handling instead of being
    // silently reinterpreted as success here.
    throw e;
  }

  await notifyRoles(REQUISITION_APPROVAL_ROLES, {
    title: requisition.requisitionNumber,
    body: `${requisition.material.name} — auto-requested, stock at or below threshold`,
    link: "/warehouses?tab=rawMaterials&sub=silos",
    module: "Warehouses",
  });
  return { status: "CREATED", requisitionId: requisition.id, requisitionNumber: requisition.requisitionNumber };
}
