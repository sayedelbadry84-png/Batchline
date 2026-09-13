-- PL-R7-P2-02, seventh production-lifecycle review — completeBatch's own
-- auto-requisition follow-up (maybeAutoRequisitionMaterial, production/
-- actions.ts) only ever guarded against opening a duplicate open
-- requisition for the same material+site with a plain SELECT before the
-- INSERT — a real race window for two ticket completions against the
-- same shortfall material committing at nearly the same instant. This is
-- the database backstop the review asked for: a genuine concurrent
-- duplicate now fails a real constraint (caught and treated as a benign
-- no-op by the application, see maybeAutoRequisitionMaterial's own
-- comment) instead of silently committing two open requisitions for the
-- same shortfall.
--
-- A partial index, not a plain @@unique — this must only apply while a
-- requisition is actually OPEN (PENDING_APPROVAL/APPROVED/ORDERED); a
-- material can legitimately accumulate any number of REJECTED/FULFILLED/
-- CANCELLED requisitions over time, which is exactly the shape Prisma's
-- schema-level @@unique can't express, so this is a hand-written raw
-- migration.
--
-- Preflighted against the real database first (read-only): zero existing
-- (materialId, siteId) pairs currently have more than one open
-- requisition.
CREATE UNIQUE INDEX "MaterialRequisition_open_per_material_site_key"
  ON "MaterialRequisition" ("materialId", "siteId")
  WHERE status IN ('PENDING_APPROVAL', 'APPROVED', 'ORDERED');
