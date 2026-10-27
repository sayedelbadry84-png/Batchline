-- PM review 2026-10-27 P2-2: sites whose plants disagree on time zone or
-- currency. READ ONLY, counts and site codes only. Site has no timezone or
-- currency column, so site-level records (cash, purchasing, maintenance,
-- warehouses) take them from the site's earliest-created plant; a site
-- listed here would see those records on that plant's clock and currency.
--   psql -X -v ON_ERROR_STOP=1 -f scripts/audit-2026-10/site_zone_currency_readonly.sql "<db>"
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database, now() AS checked_at;
SELECT s."code" AS site_code,
       COUNT(p."id") AS plants,
       COUNT(DISTINCT p."timezone") AS distinct_time_zones,
       COUNT(DISTINCT p."currency") AS distinct_currencies
FROM "Site" s JOIN "Plant" p ON p."siteId" = s."id"
GROUP BY s."code"
HAVING COUNT(DISTINCT p."timezone") > 1 OR COUNT(DISTINCT p."currency") > 1
ORDER BY s."code";
ROLLBACK;
