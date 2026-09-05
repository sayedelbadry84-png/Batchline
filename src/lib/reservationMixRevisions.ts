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
    // The database's own partial unique index guarantees at most one
    // ACTIVE row exists at a time, so this ordering is a defensive
    // tie-breaker only — never actually ambiguous in practice.
    orderBy: { revisionNumber: "desc" },
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
  | { status: "MATERIAL_NOT_FOUND"; materialId: string }
  | { status: "UNSUPPORTED_MATERIAL_TYPE"; materialId: string }
  | { status: "MISSING_SPECIFIC_GRAVITY"; materialId: string };

// The same set of material types resolveTicketComponents (batchCompletion.ts)
// actually knows how to resolve to a real silo/hopper/tank — a type outside
// this set would silently no-op at batch time (isInventoryTracked would
// never even consider it), so it's rejected here at save time instead of
// letting an operator build a revision around a material that can never be
// deducted from inventory (RMR-P2-02).
const SUPPORTED_MATERIAL_TYPES = new Set(["CEMENT", "FLY_ASH", "SLAG", "SILICA_FUME", "SAND", "COARSE_AGGREGATE", "ADMIXTURE", "WATER"]);

// A P2002 unique violation here means two concurrent saves both computed
// the same nextRevisionNumber (or, far less likely, both raced past the
// one-ACTIVE-per-reservation partial unique index) — Postgres checks a
// unique index at INSERT time, synchronously, so this can surface instead
// of a P2034 serialization failure even under Serializable isolation.
// withRetry (inventoryLedger.ts) only retries P2034 by design, for every
// one of its many unrelated callers — this is a local, narrower variant
// scoped to just this one call site (RMR-P2-06) rather than widening that
// shared contract.
async function withRevisionRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const code = typeof e === "object" && e !== null && "code" in e ? (e as { code?: string }).code : undefined;
      const isRetryable = code === "P2034" || code === "P2002";
      if (!isRetryable || attempt === maxAttempts - 1) throw e;
      const jitterMs = 25 + Math.random() * 50 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, jitterMs));
    }
  }
  throw lastError;
}

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

  const materials = await prisma.material.findMany({
    where: { id: { in: opts.components.map((c) => c.materialId) } },
    select: { id: true, type: true, specificGravity: true },
  });
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const missing = opts.components.find((c) => !materialById.has(c.materialId));
  if (missing) return { status: "MATERIAL_NOT_FOUND", materialId: missing.materialId };
  for (const c of opts.components) {
    const material = materialById.get(c.materialId)!;
    if (!SUPPORTED_MATERIAL_TYPES.has(material.type)) return { status: "UNSUPPORTED_MATERIAL_TYPE", materialId: c.materialId };
    if (material.type === "ADMIXTURE" && !material.specificGravity) return { status: "MISSING_SPECIFIC_GRAVITY", materialId: c.materialId };
  }

  return withRevisionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const reservation = await tx.reservation.findUnique({ where: { id: reservationId }, select: { status: true, mixId: true } });
        if (!reservation) return { status: "NOT_FOUND" as const };
        if (!EDITABLE_STATUSES.includes(reservation.status)) return { status: "INVALID_STATE" as const };

        // Read inside the same transaction, before superseding anything
        // below — this is the exact "before" state the audit record
        // needs, and computing it here (rather than the Server Action
        // reading it separately, beforehand, with the plain client)
        // closes the gap where the two reads could otherwise race
        // (RMR-P2-04).
        const before = await getEffectiveMix(tx, reservationId, reservation.mixId);
        const actor = await tx.user.findUniqueOrThrow({ where: { id: opts.actorId }, select: { role: true } });

        const lastRevision = await tx.reservationMixRevision.findFirst({
          where: { reservationId },
          orderBy: { revisionNumber: "desc" },
          select: { revisionNumber: true },
        });
        const nextRevisionNumber = (lastRevision?.revisionNumber ?? 0) + 1;

        // Supersede whatever's ACTIVE now (if anything) — atomically, in
        // the same transaction as the create below, so a concurrent save
        // can never leave two ACTIVE revisions for the same reservation.
        // The database's own partial unique index (one ACTIVE row per
        // reservation) backstops this if it's ever bypassed.
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

        // Written in the SAME transaction as the revision itself
        // (RMR-P2-04) — if this insert fails, the whole save rolls back
        // instead of leaving a recipe change on file with no audit
        // record. The Server Action wrapper (reservationMixActions.ts)
        // used to write this afterward, as a separate, later call.
        await tx.auditEvent.create({
          data: {
            actorId: opts.actorId,
            role: actor.role,
            module: "Production",
            recordId: reservationId,
            field: "mixRevision",
            beforeValue: JSON.stringify(before.components),
            afterValue: JSON.stringify({ revisionNumber: created.revisionNumber, reason: opts.reason, components: opts.components }),
            reasonCode: "RESERVATION_MIX_REVISED",
          },
        });

        return { status: "OK" as const, revisionId: created.id, revisionNumber: created.revisionNumber };
      },
      { isolationLevel: "Serializable", timeout: 15000 },
    ),
  );
}

export type CancelRevisionResult = { status: "OK" } | { status: "NOT_FOUND" } | { status: "INVALID_STATE" } | { status: "NO_ACTIVE_REVISION" };

// Falls back to the original MixDesign's own components — not a new
// revision whose numbers happen to match the original, an explicit "no
// revision is active" state, so getEffectiveMix reads straight from
// MixDesign/MixComponent again afterward. The cancelled revision's own
// row (and its components) stays on file permanently either way — see
// the model's own comment on why this is never a delete.
//
// Reads and validates the reservation's OWN status inside this same
// transaction (RMR-P2-01) — saveReservationMixRevision already refuses a
// terminal reservation, but this sibling function used to only check
// existence, letting a forged/late request cancel the active revision of
// a reservation that's already COMPLETE/CANCELLED/DELIVERED.
export async function cancelActiveReservationMixRevision(reservationId: string, opts: { actorId: string }): Promise<CancelRevisionResult> {
  return withRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const reservation = await tx.reservation.findUnique({ where: { id: reservationId }, select: { status: true } });
        if (!reservation) return { status: "NOT_FOUND" as const };
        if (!EDITABLE_STATUSES.includes(reservation.status)) return { status: "INVALID_STATE" as const };

        const active = await tx.reservationMixRevision.findFirst({ where: { reservationId, status: "ACTIVE" }, select: { id: true, revisionNumber: true, reason: true } });
        if (!active) return { status: "NO_ACTIVE_REVISION" as const };

        await tx.reservationMixRevision.update({
          where: { id: active.id },
          data: { status: "CANCELLED", resolvedAt: new Date(), resolvedById: opts.actorId },
        });

        // Atomic with the cancellation itself, same reasoning as
        // saveReservationMixRevision's own audit write (RMR-P2-04).
        const actor = await tx.user.findUniqueOrThrow({ where: { id: opts.actorId }, select: { role: true } });
        await tx.auditEvent.create({
          data: {
            actorId: opts.actorId,
            role: actor.role,
            module: "Production",
            recordId: reservationId,
            field: "mixRevision",
            beforeValue: JSON.stringify({ revisionId: active.id, revisionNumber: active.revisionNumber, reason: active.reason, status: "ACTIVE" }),
            afterValue: JSON.stringify({ revisionId: active.id, revisionNumber: active.revisionNumber, status: "CANCELLED" }),
            reasonCode: "RESERVATION_MIX_REVISION_CANCELLED",
          },
        });

        return { status: "OK" as const };
      },
      { isolationLevel: "Serializable" },
    ),
  );
}
