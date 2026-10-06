-- CreateEnum
CREATE TYPE "AdsLevel" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'ADSET', 'AD');

-- CreateEnum
CREATE TYPE "AdsAlertStatus" AS ENUM ('OPEN', 'ACKED', 'RESOLVED', 'MUTED');

-- CreateEnum
CREATE TYPE "AdsSeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateTable
CREATE TABLE "AdsObject" (
    "id" TEXT NOT NULL,
    "adsAccountId" TEXT NOT NULL,
    "projectId" TEXT,
    "level" "AdsLevel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "campaignExternalId" TEXT,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "optimizationGoal" TEXT,
    "billingEvent" TEXT,
    "bidStrategy" TEXT,
    "destinationType" TEXT,
    "configuredStatus" TEXT,
    "effectiveStatus" TEXT,
    "dailyBudgetMinor" BIGINT,
    "lifetimeBudgetMinor" BIGINT,
    "spendCapMinor" BIGINT,
    "budgetRemainingMinor" BIGINT,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "learningStatus" TEXT,
    "learningConversions" INTEGER,
    "lastSigEditAt" TIMESTAMP(3),
    "issues" JSONB,
    "reviewFeedback" JSONB,
    "failedDeliveryChecks" JSONB,
    "advantageState" TEXT,
    "resultActionType" TEXT,
    "creativeExternalId" TEXT,
    "thumbnailAssetId" TEXT,
    "thumbnailFetchedAt" TIMESTAMP(3),
    "windowStats" JSONB,
    "createdByAgentelse" BOOLEAN NOT NULL DEFAULT false,
    "launchId" TEXT,
    "fieldsHash" TEXT,
    "metaUpdatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastDeliveryAt" TIMESTAMP(3),
    "driftAt" TIMESTAMP(3),
    "goneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsInsightDaily" (
    "id" TEXT NOT NULL,
    "adsAccountId" TEXT NOT NULL,
    "projectId" TEXT,
    "level" "AdsLevel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spendMinor" BIGINT NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "frequency" DOUBLE PRECISION,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER NOT NULL DEFAULT 0,
    "landingPageViews" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER,
    "resultActionType" TEXT,
    "actionValuesMinor" BIGINT,
    "actions" JSONB,
    "video3s" INTEGER,
    "thruplays" INTEGER,
    "rankings" JSONB,
    "attributionSetting" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsInsightDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsAlert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "adsAccountId" TEXT,
    "externalId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" "AdsSeverity" NOT NULL,
    "status" "AdsAlertStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "data" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "notifiedAt" TIMESTAMP(3),
    "notifyChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mutedUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsObject_projectId_level_effectiveStatus_idx" ON "AdsObject"("projectId", "level", "effectiveStatus");

-- CreateIndex
CREATE INDEX "AdsObject_adsAccountId_level_idx" ON "AdsObject"("adsAccountId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "AdsObject_adsAccountId_externalId_key" ON "AdsObject"("adsAccountId", "externalId");

-- CreateIndex
CREATE INDEX "AdsInsightDaily_projectId_date_idx" ON "AdsInsightDaily"("projectId", "date");

-- CreateIndex
CREATE INDEX "AdsInsightDaily_adsAccountId_date_idx" ON "AdsInsightDaily"("adsAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AdsInsightDaily_adsAccountId_level_externalId_date_key" ON "AdsInsightDaily"("adsAccountId", "level", "externalId", "date");

-- CreateIndex
CREATE INDEX "AdsAlert_projectId_status_severity_idx" ON "AdsAlert"("projectId", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "AdsAlert_projectId_dedupeKey_key" ON "AdsAlert"("projectId", "dedupeKey");

