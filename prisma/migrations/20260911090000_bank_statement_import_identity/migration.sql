-- PR4-R6-P1-01, external-review validation round 6 (2026-09-11): give a
-- bank-statement import a durable identity, and make a statement line's
-- claim on a financial movement exclusive at the database level.
--
-- Two independent problems, one table each:
--
--  1. importBankStatement had no identity at all. The same file could be
--     uploaded twice — or once with the HTTP response lost, then retried —
--     and every line was inserted again. BankStatementImport's unique
--     (siteId, fileDigest) makes the second attempt fail instead.
--
--  2. Two concurrent imports could each read the same still-unreconciled
--     payment, each pick it as their unique match, and both commit a line
--     claiming it. The application now claims each movement with a
--     conditional update, and this partial unique index is the backstop
--     underneath that: at most one line may claim any one movement.
--
-- The index is PARTIAL on purpose. Unmatched lines all carry
-- (NULL, NULL), and in Postgres NULLs never conflict — but writing the
-- predicate explicitly documents the intent rather than relying on that,
-- and keeps the index small on a table where most rows are unmatched.
-- Prisma's schema language cannot express a WHERE clause on an index, so
-- this is hand-written (see prisma/MIGRATIONS.md).
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "fileDigest" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "matchedCount" INTEGER NOT NULL,
    "importedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankStatementImport_siteId_fileDigest_key" ON "BankStatementImport"("siteId", "fileDigest");

ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_importedById_fkey"
    FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BankStatementLine" ADD COLUMN "importId" TEXT;
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "BankStatementImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BankStatementLine_siteId_statementDate_idx" ON "BankStatementLine"("siteId", "statementDate");

-- The exclusivity backstop. Any pre-existing duplicate claim would make
-- this fail loudly at deploy time, which is the correct outcome: a bank
-- reconciliation with two lines against one movement needs a human, not a
-- silently skipped constraint.
CREATE UNIQUE INDEX "BankStatementLine_matched_movement_key"
    ON "BankStatementLine"("matchedKind", "matchedId")
    WHERE "matchedKind" IS NOT NULL AND "matchedId" IS NOT NULL;
