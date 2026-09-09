-- REMEDIATION — DELETES ROWS. Run only after the detection script
-- (pending_auto_requisition_uniqueness_detect.sql) has reported conflicts,
-- and only inside the maintenance window described in prisma/MIGRATIONS.md.
--
-- PL-R13-P1-02: this file is deliberately separate from detection so that
-- merely *checking* a database can never delete anything, and it asserts
-- its own success in SQL — the previous version committed straight after
-- the delete and only told the operator to re-check in a comment, which
-- is not a check at all.
--
-- Schema assumption: a database that still needs this has NOT applied
-- round10, so only columns from round9_part3 exist. Nothing here
-- references requisitionId/notificationDeliveredAt (added later).
--
-- MERGE POLICY — within each duplicate group keep exactly one row, the
-- one carrying the most useful history, since at that point no row has
-- made any progress the others have not (the progress columns do not
-- exist yet):
--   1. most recently attempted (lastTriedAt), which carries the most
--      relevant lastError;
--   2. then the highest attempt count;
--   3. then the most recently created;
--   4. then id, purely so the choice is deterministic.
-- The survivor inherits the group's highest attempt count so backoff and
-- dead-letter history are not silently reset by the merge.

BEGIN;

-- Block concurrent writers for the duration of this transaction. Combined
-- with the maintenance window, this is what stops the application from
-- re-creating a duplicate between the cleanup and the index build.
LOCK TABLE "PendingAutoRequisition" IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "batchTicketId", "materialId", "siteId"
      ORDER BY "lastTriedAt" DESC NULLS LAST, attempts DESC, "createdAt" DESC, id
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
      ORDER BY "lastTriedAt" DESC NULLS LAST, attempts DESC, "createdAt" DESC, id
    ) AS rank
  FROM "PendingAutoRequisition"
)
DELETE FROM "PendingAutoRequisition"
WHERE id IN (SELECT id FROM ranked WHERE rank > 1);

-- A REAL assertion, not a comment: if any duplicate group survives, this
-- raises and the whole transaction rolls back, leaving the data exactly
-- as it was.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM (
    SELECT 1
    FROM "PendingAutoRequisition"
    GROUP BY "batchTicketId", "materialId", "siteId"
    HAVING count(*) > 1
  ) AS still_duplicated;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'PendingAutoRequisition still has % duplicated (batchTicketId, materialId, siteId) group(s) after remediation — rolling back, do NOT deploy round10 yet', remaining;
  END IF;
END $$;

COMMIT;
