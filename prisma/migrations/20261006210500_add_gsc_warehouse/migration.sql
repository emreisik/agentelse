-- CreateTable
CREATE TABLE "GscSiteLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "demotedAt" TIMESTAMP(3),
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "propertyType" TEXT,
    "permissionLevel" TEXT,
    "domainMatch" BOOLEAN,
    "searchTypes" JSONB,
    "brandTerms" JSONB,
    "brandSeriesHash" TEXT,
    "brandClassifiedHash" TEXT,
    "archive" BOOLEAN NOT NULL DEFAULT true,
    "health" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "healthReason" TEXT,
    "rateLimitedUntil" TIMESTAMP(3),
    "loadLimitedUntil" TIMESTAMP(3),
    "heavyLimitedUntil" TIMESTAMP(3),
    "loadErrors" JSONB,
    "syncLeaseUntil" TIMESTAMP(3),
    "syncLeaseOwner" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSyncError" TEXT,
    "lastMetadataAt" TIMESTAMP(3),
    "lastDailyAt" TIMESTAMP(3),
    "lastDailySlot" TEXT,
    "lastFinalDate" TEXT,
    "lastFreshAt" TIMESTAMP(3),
    "lastWeeklyWeek" TEXT,
    "lastMonthlyMonth" TEXT,
    "backfill" JSONB,
    "backfillDoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscSiteLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscDailyTotal" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "searchType" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "positionWeighted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "brandClicks" INTEGER,
    "brandImpressions" INTEGER,
    "brandPositionWeighted" DOUBLE PRECISION,
    "fresh" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscDailyTotal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscDailySlice" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "rows" JSONB NOT NULL,
    "other" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscDailySlice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscQuery" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "isBrand" BOOLEAN NOT NULL DEFAULT false,
    "intent" TEXT,
    "language" TEXT,
    "clusterId" TEXT,
    "firstSeenWeek" DATE NOT NULL,
    "lastSeenWeek" DATE NOT NULL,

    CONSTRAINT "GscQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscPage" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "pageGroup" TEXT,
    "firstSeenWeek" DATE NOT NULL,
    "lastSeenWeek" DATE NOT NULL,

    CONSTRAINT "GscPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscWeeklyQuery" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "queryId" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "positionWeighted" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GscWeeklyQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscWeeklyPage" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "pageId" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "positionWeighted" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GscWeeklyPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscWeeklyQueryPage" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "queryId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "positionWeighted" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GscWeeklyQueryPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscMonthlyQuery" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "queryId" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "positionWeighted" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GscMonthlyQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscMonthlyPage" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "pageId" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "positionWeighted" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GscMonthlyPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscPeriodFetch" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "grain" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "key" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "rowClicks" INTEGER NOT NULL DEFAULT 0,
    "rowImpressions" INTEGER NOT NULL DEFAULT 0,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscPeriodFetch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GscSiteLink_siteUrl_idx" ON "GscSiteLink"("siteUrl");

-- CreateIndex
CREATE INDEX "GscSiteLink_credentialId_idx" ON "GscSiteLink"("credentialId");

-- CreateIndex
CREATE INDEX "GscSiteLink_isPrimary_syncLeaseUntil_idx" ON "GscSiteLink"("isPrimary", "syncLeaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "GscSiteLink_projectId_siteUrl_key" ON "GscSiteLink"("projectId", "siteUrl");

-- CreateIndex
CREATE INDEX "GscDailyTotal_projectId_date_idx" ON "GscDailyTotal"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GscDailyTotal_linkId_date_searchType_key" ON "GscDailyTotal"("linkId", "date", "searchType");

-- CreateIndex
CREATE INDEX "GscDailySlice_projectId_date_idx" ON "GscDailySlice"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GscDailySlice_linkId_kind_date_key" ON "GscDailySlice"("linkId", "kind", "date");

-- CreateIndex
CREATE INDEX "GscQuery_linkId_lastSeenWeek_idx" ON "GscQuery"("linkId", "lastSeenWeek");

-- CreateIndex
CREATE INDEX "GscQuery_projectId_idx" ON "GscQuery"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GscQuery_linkId_textHash_key" ON "GscQuery"("linkId", "textHash");

-- CreateIndex
CREATE INDEX "GscPage_linkId_lastSeenWeek_idx" ON "GscPage"("linkId", "lastSeenWeek");

-- CreateIndex
CREATE INDEX "GscPage_projectId_idx" ON "GscPage"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GscPage_linkId_urlHash_key" ON "GscPage"("linkId", "urlHash");

-- CreateIndex
CREATE INDEX "GscWeeklyQuery_projectId_weekStart_idx" ON "GscWeeklyQuery"("projectId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "GscWeeklyQuery_linkId_weekStart_queryId_key" ON "GscWeeklyQuery"("linkId", "weekStart", "queryId");

-- CreateIndex
CREATE INDEX "GscWeeklyPage_projectId_weekStart_idx" ON "GscWeeklyPage"("projectId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "GscWeeklyPage_linkId_weekStart_pageId_key" ON "GscWeeklyPage"("linkId", "weekStart", "pageId");

-- CreateIndex
CREATE INDEX "GscWeeklyQueryPage_projectId_weekStart_idx" ON "GscWeeklyQueryPage"("projectId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "GscWeeklyQueryPage_linkId_weekStart_queryId_pageId_key" ON "GscWeeklyQueryPage"("linkId", "weekStart", "queryId", "pageId");

-- CreateIndex
CREATE INDEX "GscMonthlyQuery_projectId_month_idx" ON "GscMonthlyQuery"("projectId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "GscMonthlyQuery_linkId_month_queryId_key" ON "GscMonthlyQuery"("linkId", "month", "queryId");

-- CreateIndex
CREATE INDEX "GscMonthlyPage_projectId_month_idx" ON "GscMonthlyPage"("projectId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "GscMonthlyPage_linkId_month_pageId_key" ON "GscMonthlyPage"("linkId", "month", "pageId");

-- CreateIndex
CREATE INDEX "GscPeriodFetch_projectId_periodStart_idx" ON "GscPeriodFetch"("projectId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "GscPeriodFetch_linkId_grain_periodStart_key_key" ON "GscPeriodFetch"("linkId", "grain", "periodStart", "key");

-- AddForeignKey
ALTER TABLE "GscDailyTotal" ADD CONSTRAINT "GscDailyTotal_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscDailySlice" ADD CONSTRAINT "GscDailySlice_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscQuery" ADD CONSTRAINT "GscQuery_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscPage" ADD CONSTRAINT "GscPage_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscWeeklyQuery" ADD CONSTRAINT "GscWeeklyQuery_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscWeeklyQuery" ADD CONSTRAINT "GscWeeklyQuery_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "GscQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscWeeklyPage" ADD CONSTRAINT "GscWeeklyPage_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscWeeklyPage" ADD CONSTRAINT "GscWeeklyPage_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "GscPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscWeeklyQueryPage" ADD CONSTRAINT "GscWeeklyQueryPage_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscWeeklyQueryPage" ADD CONSTRAINT "GscWeeklyQueryPage_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "GscQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscWeeklyQueryPage" ADD CONSTRAINT "GscWeeklyQueryPage_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "GscPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscMonthlyQuery" ADD CONSTRAINT "GscMonthlyQuery_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscMonthlyQuery" ADD CONSTRAINT "GscMonthlyQuery_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "GscQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscMonthlyPage" ADD CONSTRAINT "GscMonthlyPage_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscMonthlyPage" ADD CONSTRAINT "GscMonthlyPage_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "GscPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscPeriodFetch" ADD CONSTRAINT "GscPeriodFetch_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

