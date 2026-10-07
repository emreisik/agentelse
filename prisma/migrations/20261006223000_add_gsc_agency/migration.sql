-- AlterTable
ALTER TABLE "GscSiteLink" ADD COLUMN     "isSecondary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GscPeriodFetch" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'API';

-- CreateTable
CREATE TABLE "GscSiteSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "isExtra" BOOLEAN NOT NULL DEFAULT false,
    "pageGroupRules" JSONB,
    "rulesVersion" INTEGER NOT NULL DEFAULT 0,
    "groupsAppliedVersion" INTEGER NOT NULL DEFAULT 0,
    "groupsAppliedWeek" TEXT,
    "groupsCursor" TEXT,
    "groupsLeaseUntil" TIMESTAMP(3),
    "groupsLeaseOwner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscSiteSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscBqSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "bqProjectId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "location" TEXT,
    "bqSiteUrl" TEXT,
    "exportStart" TEXT,
    "exportedThrough" TEXT,
    "coverageCheckedAt" TIMESTAMP(3),
    "importAll" BOOLEAN NOT NULL DEFAULT false,
    "maxBytesPerQuery" BIGINT NOT NULL DEFAULT 10737418240,
    "monthlyBudgetBytes" BIGINT NOT NULL DEFAULT 322122547200,
    "usageMonth" TEXT,
    "bytesBilledMonth" BIGINT NOT NULL DEFAULT 0,
    "queriesMonth" INTEGER NOT NULL DEFAULT 0,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "reconcile" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscBqSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscSplitTest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "changeKind" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "population" JSONB NOT NULL,
    "seed" TEXT NOT NULL,
    "testPages" INTEGER NOT NULL DEFAULT 0,
    "controlPages" INTEGER NOT NULL DEFAULT 0,
    "balance" JSONB NOT NULL,
    "change" JSONB,
    "appliedVia" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedByUserId" TEXT,
    "cmsChanges" JSONB,
    "baseline" JSONB,
    "verification" JSONB,
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "askedAt" TIMESTAMP(3),
    "measureFrom" TIMESTAMP(3),
    "windowDays" INTEGER NOT NULL DEFAULT 28,
    "evaluateAfter" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "evaluation" JSONB,
    "outcome" TEXT,
    "confidence" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscSplitTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscSplitTestPage" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageGroup" TEXT NOT NULL DEFAULT '',
    "arm" TEXT NOT NULL,

    CONSTRAINT "GscSplitTestPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportBranding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "accent" TEXT NOT NULL DEFAULT 'slate',
    "footer" TEXT,
    "logoAssetId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportBranding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportShare" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "branding" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GscSiteSetting_workspaceId_idx" ON "GscSiteSetting"("workspaceId");

-- CreateIndex
CREATE INDEX "GscSiteSetting_isExtra_projectId_idx" ON "GscSiteSetting"("isExtra", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GscSiteSetting_projectId_siteUrl_key" ON "GscSiteSetting"("projectId", "siteUrl");

-- CreateIndex
CREATE INDEX "GscBqSource_status_nextRunAt_idx" ON "GscBqSource"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "GscBqSource_workspaceId_idx" ON "GscBqSource"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GscBqSource_projectId_siteUrl_key" ON "GscBqSource"("projectId", "siteUrl");

-- CreateIndex
CREATE INDEX "GscSplitTest_linkId_status_idx" ON "GscSplitTest"("linkId", "status");

-- CreateIndex
CREATE INDEX "GscSplitTest_projectId_isMock_status_idx" ON "GscSplitTest"("projectId", "isMock", "status");

-- CreateIndex
CREATE INDEX "GscSplitTest_status_nextCheckAt_idx" ON "GscSplitTest"("status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "GscSplitTestPage_linkId_pageId_idx" ON "GscSplitTestPage"("linkId", "pageId");

-- CreateIndex
CREATE INDEX "GscSplitTestPage_testId_arm_idx" ON "GscSplitTestPage"("testId", "arm");

-- CreateIndex
CREATE UNIQUE INDEX "GscSplitTestPage_testId_pageId_key" ON "GscSplitTestPage"("testId", "pageId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportBranding_workspaceId_key" ON "ReportBranding"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportShare_tokenHash_key" ON "ReportShare"("tokenHash");

-- CreateIndex
CREATE INDEX "ReportShare_projectId_kind_reportId_idx" ON "ReportShare"("projectId", "kind", "reportId");

-- CreateIndex
CREATE INDEX "ReportShare_expiresAt_idx" ON "ReportShare"("expiresAt");

-- CreateIndex
CREATE INDEX "ReportShare_workspaceId_revokedAt_idx" ON "ReportShare"("workspaceId", "revokedAt");

-- CreateIndex
CREATE INDEX "GscSiteLink_isSecondary_syncLeaseUntil_idx" ON "GscSiteLink"("isSecondary", "syncLeaseUntil");

-- AddForeignKey
ALTER TABLE "GscSplitTest" ADD CONSTRAINT "GscSplitTest_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscSplitTestPage" ADD CONSTRAINT "GscSplitTestPage_testId_fkey" FOREIGN KEY ("testId") REFERENCES "GscSplitTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

