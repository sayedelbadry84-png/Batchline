-- EXCEPTIONAL. NOT part of a normal rollback.
--
-- The normal rollback for PR #9 is the application only (see README.md):
-- both migrations are expand-only and main's code runs on the migrated
-- schema, so the table, the CHECK and the migration records stay.
--
-- This script undoes both migrations. It destroys the credit-limit request
-- and decision history (the AuditEvent rows survive, but not the request
-- rows they refer to), and it removes the migrations' records from
-- _prisma_migrations, after which re-applying them is a fresh start.
-- Use it only on the owner's separate decision, and only after the
-- application has been rolled back to a build that does not use the table.
--
-- It refuses to run while the table holds any row: dropping real requests
-- is not a rollback, and preserving them needs its own reviewed and
-- rehearsed plan, not this file.
--
--   psql -X -v ON_ERROR_STOP=1 -f scripts/pr9-predeploy/destructive_schema_rollback_pr9.sql
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM "CustomerCreditLimitRequest";
  IF n > 0 THEN
    RAISE EXCEPTION 'CustomerCreditLimitRequest holds % row(s); refusing to drop credit decision history. Roll back the application only.', n;
  END IF;
END
$$;
DROP TABLE "CustomerCreditLimitRequest";
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_creditLimit_check";
DELETE FROM "_prisma_migrations" WHERE "migration_name" IN
  ('20260925130000_customer_credit_limit_request', '20260925120000_customer_credit_limit_check');
COMMIT;
