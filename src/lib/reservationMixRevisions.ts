import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRetry } from "@/lib/inventoryLedger";

type Db = Prisma.TransactionClient | typeof prisma;

// A reservation-scoped, copy-on-write override of its mix design's
// components — see ReservationMixRevision's own schema comment for the
// full design. This file is the domain layer: pure functions, no
// session/formData access, so it's callable from tests directly — same
// split as batchCompletion.ts/shortageOverrideRequests.ts. Permission,
// site-scope, and audit-logging live in the Server Action wrapper
// (production/reservationMixActions.ts).

export type EffectiveMixComponent = {
  materialId: string;
  materialName: string;
  designMassKgPerM3: number;
  note: string | null;
};

export type EffectiveMix = {
  revisionId: string | null;
  revisionNumber: number | null;
  components: EffectiveMixComponent[];
};

// Reads whichever component set a NEW ticket for this reservation would
// actually be built from right now — the reservation's own ACTIVE
// revision if one exists, else the original MixDesign's components
// unchanged. Used both by releaseTicketForReservation (via `tx`, inside
// its own transaction) and by the edit page (via the plain `prisma`
// singleton, read-only, just for display) — one function, so the two can
// never disagree about what "active" means.
export async function getEffectiveMix(db: Db, reservationId: string, mixId: string): Promise<EffectiveMix> {
  const activeRevision = await db.reservationMixRevision.findFirst({
    where: { reservationId, status: "ACTIVE" },
    include: { components: { include: { material: true } } },
  });
  if (activeRevision) {
    return {
      revisionId: activeRevision.id,
      revisionNumber: activeRevision.revisionNumber,
      components: activeRevision.components.map((c) => ({
        materialId: c.materialId,
        materialName: c.material.name,
        designMassKgPerM3: Number(c.designMassKgPerM3),
        note: c.note,
      })),
    };
  }
  const mix = await db.mixDesign.findUniqueOrThrow({ where: { id: mixId }, include: { components: { include: { material: true } } } });
  return {
    revisionId: null,
    revisionNumber: null,
    components: mix.components.map((c) => ({
      materialId: c.materialId,
      materialName: c.material.name,
      designMassKgPerM3: c.designMassKgPerM3,
      note: null,
    })),
  };
}

export type ComponentInput = { materialId: string; designMassKgPerM3: number; note?: string | null };

export type SaveRevisionResult =
  | { status: "OK"; revisionId: string; revisionNumber: number }
  | { status: "NOT_FOUND" }
  | { status: "INVALID_STATE" }
  | { status: "NO_COMPONENTS" }
  | { status: "DUPLICATE_MATERIAL"; materialId: string }
  | { status: "INVALID_QUANTITY"; materialId: string }
  | { status: "MATERIAL_NOT_FOUND"; materialId: string };

// Only a reservation that's cleared both sign-offs and hasn't been
// delivered/cancelled can have its mix edited — same "ready for release
// or actively being fulfilled" window releaseBatchTicket itself requires
// (isReservationApproved), narrowed further to exclude a reservation
// that's already fully done, since there's nothing left for a revision to
// ever apply to at that point.
const EDITABLE_STATUSES = ["CONFIRMED", "IN_PRODUCTION"];

export async function saveReservationMixRevision(
  reservationId: string,
  opts: { reason: string; actorId: string; components: ComponentInput[] },
): Promise<SaveRevisionResult> {
  if (opts.components.length === 0) return { status: "NO_COMPONENTS" };

  const seen = new Set<string>();
  for (const c of opts.components) {
    if (seen.has(c.materialId)) return { status: "DUPLICATE_MATERIAL", materialId: c.materialId };
    seen.add(c.materialId);
    if (!Number.isFinite(c.designMassKgPerM3) || c.designMassKgPerM3 <= 0) return { status: "INVALID_QUANTITY", materialId: c.materialId };
  }

  const materials = await prisma.material.findMany({ where: { id: { in: opts.components.map((c) => c.materialId) } }, select: { id: true } });
  const foundIds = new Set(materials.map((m) => m.id));
  const missing = opts.components.find((c) => !foundIds.has(c.materialId));
  if (missing) return { status: "MATERIAL_NOT_FOUND", materialId: missing.materialId };

  return withRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const reservation = await tx.reservation.findUnique({ where: { id: reservationId }, select: { status: true, mixId: true } });
        if (!reservation) return { status: "NOT_FOUND" as const };
        if (!EDITABLE_STATUSES.includes(reservation.status)) return { status: "INVALID_STATE" as const };

        const lastRevision = await tx.reservationMixRevision.findFirst({
          where: { reservationId },
          orderBy: { revisionNumber: "desc" },
          select: { revisionNumber: true },
        });
        const nextRevisionNumber = (lastRevision?.revisionNumber ?? 0) + 1;

        // Supersede whatever's ACTIVE now (if anything) — atomically, in
        // the same transaction as the create below, so a concurrent save
        // can never leave two ACTIVE revisions for the same reservation.
        await tx.reservationMixRevision.updateMany({
          where: { reservationId, status: "ACTIVE" },
          data: { status: "SUPERSEDED", resolvedAt: new Date(), resolvedById: opts.actorId },
        });

        const created = await tx.reservationMixRevision.create({
          data: {
            reservationId,
            mixId: reservation.mixId,
            revisionNumber: nextRevisionNumber,
            status: "ACTIVE",
            reason: opts.reason,
            createdById: opts.actorId,
            components: {
              create: opts.components.map((c) => ({
                materialId: c.materialId,
                designMassKgPerM3: new Prisma.Decimal(c.designMassKgPerM3),
                note: c.note ?? null,
              })),
            },
          },
        });

        return { status: "OK" as const, revisionId: created.id, revisionNumber: created.revisionNumber };
      },
      { isolationLevel: "Serializable", timeout: 15000 },
    ),
  );
}

export type CancelRevisionResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "NO_ACTIVE_REVISION" };

// Falls back to the original MixDesign's own components — not a new
// revision whose numbers happen to match the original, an explicit "no
// revision is active" state, so getEffectiveMix reads straight from
// MixDesign/MixComponent again afterward. The cancelled revision's own
// row (and its components) stays on file permanently either way — see
// the model's own comment on why this is never a delete.
export async function cancelActiveReservationMixRevision(reservationId: string, opts: { actorId: string }): Promise<CancelRevisionResult> {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true } });
  if (!reservation) return { status: "NOT_FOUND" };

  return withRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const claim = await tx.reservationMixRevision.updateMany({
          where: { reservationId, status: "ACTIVE" },
          data: { status: "CANCELLED", resolvedAt: new Date(), resolvedById: opts.actorId },
        });
        if (claim.count === 0) return { status: "NO_ACTIVE_REVISION" as const };
        return { status: "OK" as const };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}
