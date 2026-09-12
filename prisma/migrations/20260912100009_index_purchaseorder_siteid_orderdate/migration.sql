CREATE INDEX CONCURRENTLY IF NOT EXISTS "PurchaseOrder_siteId_orderDate_idx" ON "PurchaseOrder"("siteId", "orderDate");
