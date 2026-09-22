-- CreateEnum
CREATE TYPE "AgencyLoopStatus" AS ENUM ('RUNNING', 'WAITING', 'BLOCKED', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "AgencyCycleStatus" AS ENUM ('RUNNING', 'COMPLETED', 'NOOP', 'FAILED');

-- CreateTable
CREATE TABLE "AgencyLoopState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "status" "AgencyLoopStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTickAt" TIMESTAMP(3),
    "lastProgressAt" TIMESTAMP(3),
    "nextWakeAt" TIMESTAMP(3),
    "currentPhase" TEXT,
    "lastTriggerType" "AgencyTriggerType",
    "blockedReason" TEXT,
    "consecutiveNoProgressCycles" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyLoopState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyCycle" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "triggerType" "AgencyTriggerType",
    "triggerId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "AgencyCycleStatus" NOT NULL DEFAULT 'RUNNING',
    "signalsProcessed" INTEGER NOT NULL DEFAULT 0,
    "insightsCreated" INTEGER NOT NULL DEFAULT 0,
    "opportunitiesCreated" INTEGER NOT NULL DEFAULT 0,
    "ideasCreated" INTEGER NOT NULL DEFAULT 0,
    "decisionsCreated" INTEGER NOT NULL DEFAULT 0,
    "tasksCreated" INTEGER NOT NULL DEFAULT 0,
    "handoffsCreated" INTEGER NOT NULL DEFAULT 0,
    "measurementsCreated" INTEGER NOT NULL DEFAULT 0,
    "learningsCreated" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AgencyCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgencyLoopState_projectId_key" ON "AgencyLoopState"("projectId");

-- CreateIndex
CREATE INDEX "AgencyLoopState_workspaceId_idx" ON "AgencyLoopState"("workspaceId");

-- CreateIndex
CREATE INDEX "AgencyCycle_projectId_startedAt_idx" ON "AgencyCycle"("projectId", "startedAt");
