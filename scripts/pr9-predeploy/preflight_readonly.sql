-- Batchline PR #9 pre-deploy checks. READ ONLY: everything runs inside a
-- READ ONLY transaction that is rolled back. Run with
--   psql -X -v ON_ERROR_STOP=1 -f scripts/pr9-predeploy/preflight_readonly.sql
-- and check the exit code: any failed query (a permission, a schema that
-- differs from main's) stops the run with a non-zero exit, so a final
-- ROLLBACK is never mistaken for success. The ON_ERROR_STOP below makes
-- that hold even when the flag is forgotten.
--
-- Q0 is a blocker for migration 20260925120000. Q1 to Q5 are deliberately
-- broad CANDIDATE lists (a fully released booking, an unused price, a
-- settled invoice, an inactive booking can all appear); the exposure report
-- on a restored copy decides who is actually held. Do not change sound
-- historical rows just because they are listed here.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
\echo '== target (record this with the results)'
SELECT current_database() AS database, inet_server_addr() AS server, now() AS checked_at, pg_is_in_recovery() AS is_replica;
\echo '== Q0 invalid Customer.creditLimit (blocks migration 20260925120000)'
SELECT "id", "code", "creditLimit" FROM "Customer"
WHERE NOT ("creditLimit" >= 0 AND "creditLimit" < 'Infinity'::float8);
\echo '== Q1 confirmed/in-production bookings with no price for the customer'
SELECT r."reservationNumber", pj."customerId", r."mixId"
FROM "Reservation" r JOIN "Project" pj ON pj."id" = r."projectId"
LEFT JOIN "PriceListEntry" e ON e."customerId" = pj."customerId" AND e."mixId" = r."mixId"
WHERE r."status" IN ('CONFIRMED', 'IN_PRODUCTION') AND e."id" IS NULL;
\echo '== Q2 stored prices that cannot be valued'
SELECT "customerId", "mixId", "pricePerM3" FROM "PriceListEntry"
WHERE NOT ("pricePerM3" > 0 AND "pricePerM3" < 'Infinity');
\echo '== Q3 sites with confirmed bookings but no ACTIVE station'
SELECT DISTINCT r."siteId" FROM "Reservation" r
WHERE r."status" IN ('CONFIRMED', 'IN_PRODUCTION')
  AND NOT EXISTS (SELECT 1 FROM "Plant" p WHERE p."siteId" = r."siteId" AND p."status" = 'ACTIVE');
\echo '== Q4 customers spanning more than one currency (over-reports settled invoices)'
SELECT c."id", array_agg(DISTINCT x.cur) AS currencies FROM "Customer" c JOIN (
  SELECT i."customerId" AS cid, i."currency" AS cur FROM "Invoice" i WHERE i."status" NOT IN ('DRAFT', 'CANCELLED')
  UNION SELECT pj."customerId", pl."currency" FROM "Reservation" r JOIN "Project" pj ON pj."id" = r."projectId" JOIN "Plant" pl ON pl."siteId" = r."siteId" AND pl."status" = 'ACTIVE'
  WHERE r."status" IN ('CONFIRMED', 'IN_PRODUCTION')
) x ON x.cid = c."id" GROUP BY c."id" HAVING COUNT(DISTINCT x.cur) > 1;
\echo '== Q5 reservations with a non-finite or non-positive volume'
SELECT "id", "reservationNumber", "status", "requestedVolumeM3" FROM "Reservation"
WHERE NOT ("requestedVolumeM3" > 0 AND "requestedVolumeM3" < 'Infinity');
\echo '== Q6 customers at limit 0 (every new booking of theirs holds after deploy)'
SELECT COUNT(*) AS customers_at_zero,
       COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Project" pj JOIN "Reservation" r ON r."projectId" = pj."id"
                                      WHERE pj."customerId" = c."id" AND r."createdAt" > now() - interval '90 days')) AS booked_last_90_days
FROM "Customer" c WHERE c."creditLimit" = 0;
ROLLBACK;
