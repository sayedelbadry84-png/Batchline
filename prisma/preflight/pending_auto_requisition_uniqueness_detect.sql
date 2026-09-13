-- DETECTION ONLY — read-only, safe to run at any time, changes nothing.
--
-- PL-R12-P2-04 / PL-R13-P1-02: upgrade preflight for migration
-- 20260908060000_harden_production_lifecycle_round10, which creates
--   PendingAutoRequisition_batchTicketId_materialId_siteId_key
-- directly. CI only ever proves that on an EMPTY database; a database
-- holding rows written under the older non-unique schema can contain
-- duplicates, and `prisma migrate deploy` then aborts part-way with a raw
-- Postgres unique violation.
--
-- WHICH DATABASES THIS APPLIES TO
-- Only a database that has NOT yet applied round10. Once round10 is
-- applied the unique index exists, so duplicates cannot be present — and
-- the columns the earlier version of this script sorted on
-- (`requisitionId`, `notificationDeliveredAt`) do not exist BEFORE
-- round10 and round12 respectively, which is why that version could never
-- run on the only database that needed it (PL-R13-P1-02). Everything
-- below uses only columns created by round9_part3, the migration that
-- introduced this table.
--
-- Run this, retain its output with the deployment record, and only run
-- the remediation script if it returns rows.

SELECT
  "batchTicketId",
  "materialId",
  "siteId",
  count(*)             AS duplicate_rows,
  min("createdAt")     AS first_created,
  max("lastTriedAt")   AS last_attempted,
  max("attempts")      AS max_attempts
FROM "PendingAutoRequisition"
GROUP BY "batchTicketId", "materialId", "siteId"
HAVING count(*) > 1
ORDER BY duplicate_rows DESC, first_created;
