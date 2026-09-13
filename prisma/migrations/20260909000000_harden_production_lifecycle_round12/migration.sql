-- PL-R12-P1-02, twelfth production-lifecycle review: an owner lease on
-- the staged auto-requisition intent, so completeBatch's immediate
-- post-commit processor and the daily cron sweep can no longer consume
-- the SAME intent concurrently (one creating the requisition while the
-- other sees ALREADY_OPEN and deletes the row out from under it, losing
-- the approval notification entirely). See PendingAutoRequisition's own
-- comment in schema.prisma.
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "leaseOwner" TEXT;
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Separates "requisition created" from "purchasing was actually told",
-- so a crash between the two retries only the half still owed.
ALTER TABLE "PendingAutoRequisition" ADD COLUMN "notificationDeliveredAt" TIMESTAMP(3);

-- The cross-intent idempotency key: two intents resolving to the same
-- open requisition must not both notify, but the second must never
-- simply ASSUME the first one did.
ALTER TABLE "MaterialRequisition" ADD COLUMN "autoRequisitionNotifiedAt" TIMESTAMP(3);
