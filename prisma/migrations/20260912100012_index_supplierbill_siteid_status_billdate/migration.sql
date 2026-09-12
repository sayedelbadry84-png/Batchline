CREATE INDEX CONCURRENTLY IF NOT EXISTS "SupplierBill_siteId_status_billDate_idx" ON "SupplierBill"("siteId", "status", "billDate");
