-- AlterTable
ALTER TABLE "Creative" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "formatKey" TEXT,
ADD COLUMN     "goal" TEXT,
ADD COLUMN     "planId" TEXT;

-- CreateIndex
CREATE INDEX "Creative_projectId_channel_idx" ON "Creative"("projectId", "channel");

-- CreateIndex
CREATE INDEX "Creative_planId_idx" ON "Creative"("planId");
