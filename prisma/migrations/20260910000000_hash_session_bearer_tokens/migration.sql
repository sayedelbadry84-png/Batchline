-- BL-CR-P1-05, external-review validation (2026-09-10): the session and
-- pending-2FA cookies carried the row's own cuid() id as the bearer
-- credential. They now carry 32 CSPRNG bytes, and only SHA-256 of that
-- value is stored (see src/lib/sessionToken.ts).
--
-- Existing rows cannot be migrated: the plaintext token for an existing
-- session is the id itself, and hashing it would preserve exactly the
-- property being removed — a credential derived from a database
-- identifier. Every current session and every in-flight 2FA step is
-- therefore invalidated here, which is the documented rollout cost: all
-- users are signed out once, and anyone mid-2FA starts the login over.
-- This deletion is also what makes the NOT NULL column below addable
-- without a default.
--
-- Rollback: this migration is not reversible in any useful sense. Going
-- back means restoring the pre-deploy snapshot (see prisma/MIGRATIONS.md)
-- and accepting that every session created since is gone either way.
DELETE FROM "Session";
DELETE FROM "PendingTwoFactor";

ALTER TABLE "Session" ADD COLUMN "tokenHash" TEXT NOT NULL;
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

ALTER TABLE "PendingTwoFactor" ADD COLUMN "tokenHash" TEXT NOT NULL;
CREATE UNIQUE INDEX "PendingTwoFactor_tokenHash_key" ON "PendingTwoFactor"("tokenHash");
