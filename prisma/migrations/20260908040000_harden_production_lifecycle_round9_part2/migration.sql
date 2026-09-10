-- PL-R9-P2-02, ninth production-lifecycle review: a durable retry queue
-- for object-storage deletes that failed after already being compensated
-- for once — see PendingBlobDeletion's own comment in schema.prisma. The
-- existing daily cron sweep (api/cron/cleanup) is extended to drain this
-- table rather than a new job runner being introduced for it.
CREATE TABLE "PendingBlobDeletion" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTriedAt" TIMESTAMP(3),

    CONSTRAINT "PendingBlobDeletion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PendingBlobDeletion_createdAt_idx" ON "PendingBlobDeletion"("createdAt");
