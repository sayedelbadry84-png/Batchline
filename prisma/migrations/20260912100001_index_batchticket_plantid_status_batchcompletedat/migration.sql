CREATE INDEX CONCURRENTLY IF NOT EXISTS "BatchTicket_plantId_status_batchCompletedAt_idx" ON "BatchTicket"("plantId", "status", "batchCompletedAt");
