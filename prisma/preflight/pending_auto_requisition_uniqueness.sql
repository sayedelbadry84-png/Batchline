-- PL-R12-P2-04, twelfth production-lifecycle review: upgrade preflight for
-- migration 20260908060000_harden_production_lifecycle_round10, which
-- creates
--   PendingAutoRequisition_batchTicketId_materialId_siteId_key
-- directly. CI only ever proves that on an EMPTY database. Any database
-- that already holds PendingAutoRequisition rows written under the older,
-- non-unique schema can contain duplicates, and `prisma migrate deploy`
-- will then abort part-way with a raw Postgres unique-violation rather
-- than anything an operator can act on.
--
-- Run STEP 1 against the target database BEFORE deploying, and retain its
-- output with the deployment record. Run STEP 2 only if STEP 1 returns
-- rows. Neither step is part of the migration itself: the migration is
-- already applied to some databases, and Prisma checksums applied
-- migrations, so it must never be edited (see MIGRATIONS.md's hard rules).

-- =====================================================================
-- STEP 1 — detection. Empty result set = safe to deploy as-is.
-- =====================================================================
SELECT "batchTicketId", "materialId", "siteId", count(*)
FROM "PendingAutoRequisition"
GROUP BY "batchTicketId", "materialId", "siteId"
HAVING count(*) > 1;

-- =====================================================================
-- STEP 2 — merge policy, only if STEP 1 returned rows.
--
-- Within each duplicate group, keep the single row carrying the MOST
-- progress, because that is the row whose deletion would actually lose
-- work:
--   1. a row that already created its requisition (requisitionId set)
--      outranks one that never got that far;
--   2. among those, one that already delivered its notification
--      (notificationDeliveredAt set) outranks one still owing it;
--   3. then the most recently attempted row, which carries the most
--      useful lastError for whoever investigates;
--   4. finally id, purely so the choice is deterministic.
--
-- The surviving row inherits the highest attempt count in its group so
-- the backoff/dead-letter history is not silently reset by the merge.
-- Everything else in the group is deleted: they are duplicate intents for
-- the same (ticket, material, site), so at most one of them can ever have
-- a distinct real-world consequence.
--
-- Wrapped in an explicit transaction — review the SELECT above, run this,
-- confirm STEP 1 is now empty, and only then COMMIT.
-- =====================================================================
BEGIN;

WITH ranked AS (
  SELECT
    id,
    "batchTicketId",
    "materialId",
    "siteId",
    attempts,
    row_number() OVER (
      PARTITION BY "batchTicketId", "materialId", "siteId"
      ORDER BY
        ("requisitionId" IS NOT NULL) DESC,
        ("notificationDeliveredAt" IS NOT NULL) DESC,
        "lastTriedAt" DESC NULLS LAST,
        id
    ) AS rank,
    max(attempts) OVER (PARTITION BY "batchTicketId", "materialId", "siteId") AS group_max_attempts
  FROM "PendingAutoRequisition"
)
UPDATE "PendingAutoRequisition" p
SET attempts = r.group_max_attempts
FROM ranked r
WHERE p.id = r.id AND r.rank = 1 AND p.attempts < r.group_max_attempts;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "batchTicketId", "materialId", "siteId"
      ORDER BY
        ("requisitionId" IS NOT NULL) DESC,
        ("notificationDeliveredAt" IS NOT NULL) DESC,
        "lastTriedAt" DESC NULLS LAST,
        id
    ) AS rank
  FROM "PendingAutoRequisition"
)
DELETE FROM "PendingAutoRequisition"
WHERE id IN (SELECT id FROM ranked WHERE rank > 1);

-- Re-run STEP 1 here; it must return zero rows before COMMIT.
COMMIT;
