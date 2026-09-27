-- Rollback of PR #9's two migrations, in reverse order. Run only after the
-- application has been rolled back to a build that does not use them.
-- Dropping CustomerCreditLimitRequest discards the request/decision history
-- (the AuditEvent rows remain): export the table first.
BEGIN;
DROP TABLE "CustomerCreditLimitRequest";
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_creditLimit_check";
DELETE FROM "_prisma_migrations" WHERE "migration_name" IN
  ('20260925130000_customer_credit_limit_request', '20260925120000_customer_credit_limit_check');
COMMIT;
