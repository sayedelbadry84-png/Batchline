CREATE INDEX CONCURRENTLY IF NOT EXISTS "Reservation_siteId_status_pourWindowStart_idx" ON "Reservation"("siteId", "status", "pourWindowStart");
