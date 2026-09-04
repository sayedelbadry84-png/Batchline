-- AlterTable
ALTER TABLE "Hopper" ADD COLUMN     "materialId" TEXT;

-- AlterTable
ALTER TABLE "Silo" ADD COLUMN     "materialId" TEXT;

-- AddForeignKey
ALTER TABLE "Silo" ADD CONSTRAINT "Silo_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hopper" ADD CONSTRAINT "Hopper_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

