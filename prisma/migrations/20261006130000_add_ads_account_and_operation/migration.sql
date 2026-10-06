-- CreateEnum
CREATE TYPE "AdsPlatform" AS ENUM ('META');

-- CreateEnum
CREATE TYPE "AdsOperationStatus" AS ENUM ('PENDING', 'SENT', 'SUCCEEDED', 'UNKNOWN', 'RECONCILED', 'FAILED', 'COMPENSATED');

-- CreateTable
CREATE TABLE "AdsAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "credentialId" TEXT,
    "platform" "AdsPlatform" NOT NULL DEFAULT 'META',
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT,
    "timezoneName" TEXT,
    "accountStatus" INTEGER,
    "disableReason" INTEGER,
    "hasFunding" BOOLEAN,
    "isPersonal" BOOLEAN,
    "spendCapMinor" BIGINT,
    "amountSpentMinor" BIGINT,
    "minDailyBudgetMinor" BIGINT,
    "minCampaignSpendCapMinor" BIGINT,
    "minimumBudgets" JSONB,
    "userTasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "businessId" TEXT,
    "pageId" TEXT,
    "instagramUserId" TEXT,
    "dsaBeneficiary" TEXT,
    "dsaPayor" TEXT,
    "accessTier" TEXT,
    "lastUsage" JSONB,
    "rateLimitedUntil" TIMESTAMP(3),
    "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "healthReason" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "lastStructureAt" TIMESTAMP(3),
    "lastInsightsAt" TIMESTAMP(3),
    "lastBackfillDate" TEXT,
    "syncLeaseUntil" TIMESTAMP(3),
    "syncLeaseOwner" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsAccountProject" (
    "id" TEXT NOT NULL,
    "adsAccountId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsAccountProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsOperation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "adsAccountId" TEXT,
    "adAccountExternalId" TEXT,
    "kind" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "launchId" TEXT,
    "decisionId" TEXT,
    "executionJobId" TEXT,
    "actorType" TEXT NOT NULL,
    "targetExternalId" TEXT,
    "parentExternalId" TEXT,
    "request" JSONB NOT NULL,
    "previousState" JSONB,
    "status" "AdsOperationStatus" NOT NULL DEFAULT 'PENDING',
    "resultExternalId" TEXT,
    "error" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsAccount_externalId_idx" ON "AdsAccount"("externalId");

-- CreateIndex
CREATE INDEX "AdsAccount_syncLeaseUntil_idx" ON "AdsAccount"("syncLeaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AdsAccount_workspaceId_platform_externalId_key" ON "AdsAccount"("workspaceId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "AdsAccountProject_projectId_selected_idx" ON "AdsAccountProject"("projectId", "selected");

-- CreateIndex
CREATE UNIQUE INDEX "AdsAccountProject_adsAccountId_projectId_key" ON "AdsAccountProject"("adsAccountId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AdsOperation_tag_key" ON "AdsOperation"("tag");

-- CreateIndex
CREATE INDEX "AdsOperation_projectId_createdAt_idx" ON "AdsOperation"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AdsOperation_status_sentAt_idx" ON "AdsOperation"("status", "sentAt");

-- CreateIndex
CREATE INDEX "AdsOperation_adAccountExternalId_createdAt_idx" ON "AdsOperation"("adAccountExternalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdsOperation_executionJobId_kind_key" ON "AdsOperation"("executionJobId", "kind");

-- AddForeignKey
ALTER TABLE "AdsAccountProject" ADD CONSTRAINT "AdsAccountProject_adsAccountId_fkey" FOREIGN KEY ("adsAccountId") REFERENCES "AdsAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

