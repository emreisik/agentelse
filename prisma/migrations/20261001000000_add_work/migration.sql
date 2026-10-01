-- CreateEnum
CREATE TYPE "WorkStatus" AS ENUM ('ACTIVE', 'DONE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Work" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "status" "WorkStatus" NOT NULL DEFAULT 'ACTIVE',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "acknowledgedUnconnected" JSONB NOT NULL DEFAULT '[]',
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Work_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Command" ADD COLUMN     "workId" TEXT;

-- CreateIndex
CREATE INDEX "Work_projectId_status_lastActivityAt_idx" ON "Work"("projectId", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "Work_workspaceId_idx" ON "Work"("workspaceId");

-- CreateIndex
CREATE INDEX "Command_workId_createdAt_idx" ON "Command"("workId", "createdAt");

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE SET NULL ON UPDATE CASCADE;
