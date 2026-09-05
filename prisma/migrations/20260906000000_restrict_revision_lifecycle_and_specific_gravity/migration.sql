-- Hand-written, same reason as the two prior hardening migrations
-- (20260904185506_harden_inventory_movement,
-- 20260905210000_harden_reservation_mix_revision): triggers and CHECK
-- constraints aren't expressible in schema.prisma for this Prisma
-- version. This migration only ADDS to what's already applied — it never
-- edits the content of an already-applied migration file.

-- RMR-R2-P1-01: the previous version of this trigger froze identity/
-- content fields but let status/resolvedAt/resolvedById change to
-- ANYTHING as long as those other six fields stayed put — a direct
-- CANCELLED -> ACTIVE (or SUPERSEDED -> ACTIVE, or CANCELLED ->
-- SUPERSEDED, or clearing/rewriting an already-set resolvedAt) all
-- passed silently. CREATE OR REPLACE FUNCTION redefines the function
-- body in place; the trigger itself (already created by the prior
-- migration) picks up the new body automatically, with no need to touch
-- that migration's own file.
CREATE OR REPLACE FUNCTION reservation_mix_revision_restrict_update() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.bypass_reservation_mix_revision_immutability', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
     OR NEW."mixId" IS DISTINCT FROM OLD."mixId"
     OR NEW."revisionNumber" IS DISTINCT FROM OLD."revisionNumber"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ReservationMixRevision rows are immutable except status/resolvedAt/resolvedById — insert a new revision instead';
  END IF;

  -- The ONLY legitimate transition left, once the six fields above are
  -- confirmed unchanged: ACTIVE -> SUPERSEDED or ACTIVE -> CANCELLED,
  -- resolving resolvedAt/resolvedById from NULL to non-null in that same
  -- update. This single condition rejects every other shape a bare
  -- status/resolvedAt/resolvedById-only update could take: reactivating
  -- a terminal row, moving between two terminal statuses, a same-status
  -- no-op, and clearing or rewriting resolution metadata that's already
  -- been set once.
  IF OLD."status" != 'ACTIVE'
     OR NEW."status" NOT IN ('SUPERSEDED', 'CANCELLED')
     OR OLD."resolvedAt" IS NOT NULL OR NEW."resolvedAt" IS NULL
     OR OLD."resolvedById" IS NOT NULL OR NEW."resolvedById" IS NULL THEN
    RAISE EXCEPTION 'ReservationMixRevision only allows a single ACTIVE -> SUPERSEDED|CANCELLED transition, resolving resolvedAt/resolvedById from NULL — rejected: % -> %', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- RMR-R2-P1-03: saveReservationMixRevision/resolveTicketComponents both
-- used to check `!material.specificGravity`, a JS truthiness test — a
-- negative value or Infinity is truthy and passed straight through
-- (application code fixed alongside this migration). A negative specific
-- gravity turns liters = massKg / specificGravity negative, which turns
-- an admixture deduction into a positive inventory credit at completion
-- time. This is the database-level backstop: no Material row can ever
-- carry a non-positive or non-finite specific gravity, regardless of
-- which code path writes it (this table is also written directly from
-- the Suppliers/Materials admin screens, not just this feature).
-- Verified against the real database before adding this: zero existing
-- rows violate it, so no backfill/preflight update was needed.
--
-- "> 0 AND < Infinity" rather than "> 0" alone: PostgreSQL deliberately
-- treats NaN as sorting ABOVE Infinity for float4/float8 comparisons
-- (unlike raw IEEE754), so NaN > 0 is actually true in Postgres — only
-- the "< Infinity" half of this check excludes it.
ALTER TABLE "Material" ADD CONSTRAINT "Material_specificGravity_positive_finite"
  CHECK ("specificGravity" IS NULL OR ("specificGravity" > 0 AND "specificGravity" < 'Infinity'::float8));
