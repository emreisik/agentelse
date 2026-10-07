-- CreateTable
CREATE TABLE "GaConfigChange" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "resourceName" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "openKey" TEXT,
    "noop" BOOLEAN NOT NULL DEFAULT false,
    "taskId" TEXT,
    "approvalId" TEXT,
    "proposedByType" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "undoneByUserId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaConfigChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaChangeWatch" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cursorAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastEventCount" INTEGER NOT NULL DEFAULT 0,
    "lastAlertCount" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaChangeWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GaConfigChange_projectId_createdAt_idx" ON "GaConfigChange"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "GaConfigChange_linkId_dedupeKey_idx" ON "GaConfigChange"("linkId", "dedupeKey");

-- CreateIndex
CREATE INDEX "GaConfigChange_status_nextAttemptAt_idx" ON "GaConfigChange"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "GaConfigChange_taskId_idx" ON "GaConfigChange"("taskId");

-- CreateIndex
CREATE INDEX "GaConfigChange_approvalId_idx" ON "GaConfigChange"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "GaConfigChange_linkId_openKey_key" ON "GaConfigChange"("linkId", "openKey");

-- CreateIndex
CREATE UNIQUE INDEX "GaChangeWatch_linkId_key" ON "GaChangeWatch"("linkId");

-- CreateIndex
CREATE INDEX "GaChangeWatch_projectId_idx" ON "GaChangeWatch"("projectId");

-- CreateIndex
CREATE INDEX "GaChangeWatch_lastRunAt_idx" ON "GaChangeWatch"("lastRunAt");

-- AddForeignKey
ALTER TABLE "GaConfigChange" ADD CONSTRAINT "GaConfigChange_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaChangeWatch" ADD CONSTRAINT "GaChangeWatch_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

