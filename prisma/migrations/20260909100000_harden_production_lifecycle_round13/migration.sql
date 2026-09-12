-- PL-R13-P1-03, thirteenth production-lifecycle review: an idempotency
-- key for notifications raised by a retryable background job.
--
-- The automatic-requisition processor used to stamp
-- MaterialRequisition.autoRequisitionNotifiedAt BEFORE calling the
-- notifier that actually creates the Notification rows — so a process
-- crash in between left a requisition marked "announced", no notification
-- anywhere, and a next processor that saw the stamp, skipped delivery,
-- and deleted the intent. Delivery and cleanup now commit in ONE
-- transaction; this key (with skipDuplicates) is what makes re-running
-- that transaction after a rollback safe, so a retry can never fan out a
-- second copy of the same notification to the same user.
--
-- Nullable, and NULLs are distinct in a Postgres unique index, so every
-- existing and future un-keyed notification is unaffected.
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");
