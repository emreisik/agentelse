-- AlterTable
ALTER TABLE "Creative" ADD COLUMN     "scheduledFor" DATE;

-- CreateIndex
CREATE INDEX "Creative_projectId_scheduledFor_idx" ON "Creative"("projectId", "scheduledFor");
