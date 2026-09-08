-- PL-R10-P2-01, tenth production-lifecycle review: PendingAutoRequisition
-- becomes a real staged intent (unique per ticket/material/site) with
-- separately-tracked progress for requisition creation
-- (requisitionId/requisitionNumber/materialName) versus approval
-- notification delivery — see that model's own comment in schema.prisma.
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "requisitionId" TEXT;
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "requisitionNumber" TEXT;
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "materialName" TEXT;

CREATE UNIQUE INDEX "PendingAutoRequisition_batchTicketId_materialId_siteId_key" ON "PendingAutoRequisition"("batchTicketId", "materialId", "siteId");

-- PL-R10-P2-03, tenth production-lifecycle review: fair retry scheduling
-- and dead-lettering for both retry-queue tables — see
-- PendingAutoRequisition's own nextAttemptAt/deadLetteredAt comment in
-- schema.prisma for why a blind `orderBy createdAt` let permanently
-- failing rows starve newer, resolvable ones forever.
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
DROP INDEX "PendingAutoRequisition_createdAt_idx";
CREATE INDEX "PendingAutoRequisition_nextAttemptAt_idx" ON "PendingAutoRequisition"("nextAttemptAt");

ALTER TABLE "PendingBlobDeletion" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PendingBlobDeletion" ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
DROP INDEX "PendingBlobDeletion_createdAt_idx";
CREATE INDEX "PendingBlobDeletion_nextAttemptAt_idx" ON "PendingBlobDeletion"("nextAttemptAt");
