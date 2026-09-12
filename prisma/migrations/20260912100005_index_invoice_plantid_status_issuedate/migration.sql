CREATE INDEX CONCURRENTLY IF NOT EXISTS "Invoice_plantId_status_issueDate_idx" ON "Invoice"("plantId", "status", "issueDate");
