-- AlterTable
ALTER TABLE "BatchTicket" ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AlterTable
ALTER TABLE "ShortageOverrideRequest" ADD COLUMN     "shortageSnapshot" JSONB;

-- AddForeignKey
ALTER TABLE "BatchTicket" ADD CONSTRAINT "BatchTicket_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

