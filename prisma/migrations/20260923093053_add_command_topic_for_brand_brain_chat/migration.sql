-- AlterTable
ALTER TABLE "Command" ADD COLUMN     "topic" TEXT;

-- CreateIndex
CREATE INDEX "Command_topic_idx" ON "Command"("topic");
