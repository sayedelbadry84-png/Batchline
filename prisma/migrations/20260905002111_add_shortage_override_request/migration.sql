-- CreateTable
CREATE TABLE "ShortageOverrideRequest" (
    "id" TEXT NOT NULL,
    "batchTicketId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionNote" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShortageOverrideRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShortageOverrideRequest_batchTicketId_status_idx" ON "ShortageOverrideRequest"("batchTicketId", "status");

-- AddForeignKey
ALTER TABLE "ShortageOverrideRequest" ADD CONSTRAINT "ShortageOverrideRequest_batchTicketId_fkey" FOREIGN KEY ("batchTicketId") REFERENCES "BatchTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortageOverrideRequest" ADD CONSTRAINT "ShortageOverrideRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortageOverrideRequest" ADD CONSTRAINT "ShortageOverrideRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

