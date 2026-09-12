CREATE INDEX CONCURRENTLY IF NOT EXISTS "CashTransaction_siteId_occurredAt_idx" ON "CashTransaction"("siteId", "occurredAt");
