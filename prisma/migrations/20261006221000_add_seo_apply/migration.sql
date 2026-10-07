-- CreateTable
CREATE TABLE "CmsSite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "restMode" TEXT NOT NULL DEFAULT 'pretty',
    "siteName" TEXT,
    "scopeKey" TEXT,
    "seoPlugin" TEXT NOT NULL DEFAULT 'NONE',
    "seoFields" JSONB,
    "capabilities" JSONB,
    "health" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "healthReason" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmsSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoChange" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetUrl" TEXT,
    "wpType" TEXT,
    "wpId" INTEGER,
    "liveUrl" TEXT,
    "params" JSONB NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "openKey" TEXT,
    "noop" BOOLEAN NOT NULL DEFAULT false,
    "seoActionId" TEXT,
    "creativeId" TEXT,
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
    "indexNow" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoApplySetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "dailyLimit" INTEGER NOT NULL DEFAULT 10,
    "indexNowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "indexNowKey" TEXT,
    "indexNowHost" TEXT,
    "indexNowVerifiedAt" TIMESTAMP(3),
    "indexNowLastPingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoApplySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoGeoAudit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "siteId" TEXT NOT NULL,
    "scopeKey" TEXT,
    "score" INTEGER,
    "previousScore" INTEGER,
    "previousAt" TIMESTAMP(3),
    "result" JSONB NOT NULL,
    "acknowledged" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendations" JSONB,
    "auditedAt" TIMESTAMP(3) NOT NULL,
    "nextAuditAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoGeoAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmsSite_credentialId_idx" ON "CmsSite"("credentialId");

-- CreateIndex
CREATE INDEX "CmsSite_projectId_idx" ON "CmsSite"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CmsSite_projectId_kind_isMock_key" ON "CmsSite"("projectId", "kind", "isMock");

-- CreateIndex
CREATE INDEX "SeoChange_projectId_createdAt_idx" ON "SeoChange"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SeoChange_siteId_dedupeKey_idx" ON "SeoChange"("siteId", "dedupeKey");

-- CreateIndex
CREATE INDEX "SeoChange_status_nextAttemptAt_idx" ON "SeoChange"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SeoChange_taskId_idx" ON "SeoChange"("taskId");

-- CreateIndex
CREATE INDEX "SeoChange_approvalId_idx" ON "SeoChange"("approvalId");

-- CreateIndex
CREATE INDEX "SeoChange_seoActionId_idx" ON "SeoChange"("seoActionId");

-- CreateIndex
CREATE INDEX "SeoChange_creativeId_idx" ON "SeoChange"("creativeId");

-- CreateIndex
CREATE UNIQUE INDEX "SeoChange_siteId_openKey_key" ON "SeoChange"("siteId", "openKey");

-- CreateIndex
CREATE UNIQUE INDEX "SeoApplySetting_projectId_key" ON "SeoApplySetting"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SeoGeoAudit_siteId_key" ON "SeoGeoAudit"("siteId");

-- CreateIndex
CREATE INDEX "SeoGeoAudit_projectId_idx" ON "SeoGeoAudit"("projectId");

-- CreateIndex
CREATE INDEX "SeoGeoAudit_nextAuditAt_idx" ON "SeoGeoAudit"("nextAuditAt");

-- AddForeignKey
ALTER TABLE "SeoChange" ADD CONSTRAINT "SeoChange_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "CmsSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

