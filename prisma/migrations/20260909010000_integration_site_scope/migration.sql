-- Existing keys remain unassigned and are denied until explicitly provisioned.
ALTER TABLE "ApiKey" ADD COLUMN "siteId" TEXT, ADD COLUMN "global" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_scope_ownership" CHECK (NOT ("global" AND "siteId" IS NOT NULL));
