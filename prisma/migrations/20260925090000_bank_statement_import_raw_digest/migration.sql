-- Bank statement import identity: from a digest of the decoded text to a
-- digest of the uploaded bytes, without losing the ability to recognise a
-- file imported under the old identity.
--
-- Every existing row's fileDigest was SHA-256 of `await file.text()`
-- re-encoded as UTF-8. That decode strips a leading UTF-8 BOM and replaces
-- each invalid byte sequence with U+FFFD, so the old digest identifies the
-- decoded content: a file with a BOM and the same file without one share
-- it, and so do files that differ only in invalid bytes. New imports hash
-- the raw bytes (digestKind RAW_BYTES) and ALSO record that text digest
-- (textDigest), so a re-upload of a historical file can still be caught.
--
-- Hand-written: Prisma cannot generate the CHECK constraints.
--
-- Preflight: the backfill copies fileDigest into textDigest for existing
-- rows, and the new unique (siteId, textDigest) replaces the old unique
-- (siteId, fileDigest) over exactly those values, so existing rows cannot
-- violate it. The CHECKs hold by construction for backfilled rows.

ALTER TABLE "BankStatementImport" ADD COLUMN "digestKind" TEXT NOT NULL DEFAULT 'TEXT_UTF8';
-- The default only labels rows that already exist; the application always
-- names the kind for a new row.
ALTER TABLE "BankStatementImport" ALTER COLUMN "digestKind" DROP DEFAULT;

ALTER TABLE "BankStatementImport" ADD COLUMN "textDigest" TEXT;
UPDATE "BankStatementImport" SET "textDigest" = "fileDigest";
ALTER TABLE "BankStatementImport" ALTER COLUMN "textDigest" SET NOT NULL;

ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_digestKind_check"
    CHECK ("digestKind" IN ('TEXT_UTF8', 'RAW_BYTES'));
-- A TEXT_UTF8 row's only digest IS its text digest.
ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_text_digest_check"
    CHECK ("digestKind" <> 'TEXT_UTF8' OR "textDigest" = "fileDigest");

DROP INDEX "BankStatementImport_siteId_fileDigest_key";
-- Kind is part of the key so a RAW_BYTES digest is never compared with a
-- TEXT_UTF8 one: for a valid UTF-8 file without a BOM the two algorithms
-- produce the same value, yet a TEXT_UTF8 row cannot prove what bytes it
-- came from.
CREATE UNIQUE INDEX "BankStatementImport_siteId_digestKind_fileDigest_key" ON "BankStatementImport"("siteId", "digestKind", "fileDigest");
CREATE UNIQUE INDEX "BankStatementImport_siteId_textDigest_key" ON "BankStatementImport"("siteId", "textDigest");
