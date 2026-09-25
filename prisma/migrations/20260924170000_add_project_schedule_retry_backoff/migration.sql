-- AlterTable
ALTER TABLE "ProjectSchedule" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT;
