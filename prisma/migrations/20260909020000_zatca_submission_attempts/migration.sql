ALTER TABLE "Invoice" ADD COLUMN "zatcaAttemptId" TEXT;
ALTER TABLE "CreditNote" ADD COLUMN "zatcaAttemptId" TEXT;
CREATE TABLE "ZatcaSubmissionAttempt" (
 "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "documentId" TEXT NOT NULL,
 "uuid" TEXT NOT NULL, "state" TEXT NOT NULL, "invoiceHash" TEXT, "signedXml" TEXT,
 "httpStatus" INTEGER, "response" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "finishedAt" TIMESTAMP(3)
);
CREATE INDEX "ZatcaSubmissionAttempt_documentId_kind_idx" ON "ZatcaSubmissionAttempt"("documentId", "kind");
-- Old FAILED may have been accepted remotely. Never silently resubmit it.
UPDATE "Invoice" SET "zatcaStatus" = 'UNKNOWN' WHERE "zatcaStatus" = 'FAILED';
UPDATE "CreditNote" SET "zatcaStatus" = 'UNKNOWN' WHERE "zatcaStatus" = 'FAILED';
