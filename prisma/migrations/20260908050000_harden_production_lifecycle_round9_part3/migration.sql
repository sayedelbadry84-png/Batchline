-- PL-R9-P2-03, ninth production-lifecycle review: a durable retry queue
-- for completeBatch's own best-effort auto-requisition follow-up — see
-- PendingAutoRequisition's own comment in schema.prisma. Drained by the
-- same existing daily cron sweep (api/cron/cleanup) PendingBlobDeletion
-- already uses, rather than a new job runner.
CREATE TABLE "PendingAutoRequisition" (
    "id" TEXT NOT NULL,
    "batchTicketId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "newLevel" DOUBLE PRECISION NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "minThresholdPct" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "specificGravity" DOUBLE PRECISION,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTriedAt" TIMESTAMP(3),

    CONSTRAINT "PendingAutoRequisition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PendingAutoRequisition_createdAt_idx" ON "PendingAutoRequisition"("createdAt");
