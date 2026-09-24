-- AlterTable
ALTER TABLE "Creative" ADD COLUMN     "gridGroupId" TEXT,
ADD COLUMN     "gridPosition" INTEGER;

-- CreateIndex
CREATE INDEX "Creative_projectId_gridGroupId_idx" ON "Creative"("projectId", "gridGroupId");
