-- CreateTable
CREATE TABLE "SeoAction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "linkId" TEXT,
    "findingId" TEXT,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "openKey" TEXT,
    "pageId" TEXT,
    "targetUrl" TEXT,
    "targetUrlHash" TEXT,
    "targetQueries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proposal" JSONB NOT NULL,
    "baseline" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "appliedVia" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verification" JSONB,
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "askedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "windowDays" INTEGER NOT NULL,
    "measureFrom" TIMESTAMP(3),
    "evaluateAfter" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "evaluation" JSONB,
    "outcome" TEXT,
    "confidence" TEXT,
    "learningId" TEXT,
    "creativeId" TEXT,
    "commandId" TEXT,
    "workId" TEXT,
    "approvalId" TEXT,
    "createdByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "dismissReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoAction_projectId_status_idx" ON "SeoAction"("projectId", "status");

-- CreateIndex
CREATE INDEX "SeoAction_status_evaluateAfter_idx" ON "SeoAction"("status", "evaluateAfter");

-- CreateIndex
CREATE INDEX "SeoAction_isMock_status_nextCheckAt_idx" ON "SeoAction"("isMock", "status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "SeoAction_linkId_idx" ON "SeoAction"("linkId");

-- CreateIndex
CREATE INDEX "SeoAction_findingId_idx" ON "SeoAction"("findingId");

-- CreateIndex
CREATE INDEX "SeoAction_commandId_idx" ON "SeoAction"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "SeoAction_projectId_isMock_openKey_key" ON "SeoAction"("projectId", "isMock", "openKey");

