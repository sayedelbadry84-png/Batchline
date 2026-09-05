-- AlterTable
ALTER TABLE "BatchTicket" ADD COLUMN     "reservationMixRevisionId" TEXT;

-- CreateTable
CREATE TABLE "ReservationMixRevision" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "mixId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ReservationMixRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationMixRevisionComponent" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "designMassKgPerM3" DECIMAL(12,4) NOT NULL,
    "note" TEXT,

    CONSTRAINT "ReservationMixRevisionComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReservationMixRevision_reservationId_status_idx" ON "ReservationMixRevision"("reservationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationMixRevision_reservationId_revisionNumber_key" ON "ReservationMixRevision"("reservationId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationMixRevisionComponent_revisionId_materialId_key" ON "ReservationMixRevisionComponent"("revisionId", "materialId");

-- AddForeignKey
ALTER TABLE "ReservationMixRevision" ADD CONSTRAINT "ReservationMixRevision_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationMixRevision" ADD CONSTRAINT "ReservationMixRevision_mixId_fkey" FOREIGN KEY ("mixId") REFERENCES "MixDesign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationMixRevision" ADD CONSTRAINT "ReservationMixRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationMixRevision" ADD CONSTRAINT "ReservationMixRevision_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationMixRevisionComponent" ADD CONSTRAINT "ReservationMixRevisionComponent_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ReservationMixRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationMixRevisionComponent" ADD CONSTRAINT "ReservationMixRevisionComponent_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchTicket" ADD CONSTRAINT "BatchTicket_reservationMixRevisionId_fkey" FOREIGN KEY ("reservationMixRevisionId") REFERENCES "ReservationMixRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

