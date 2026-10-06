-- CreateTable
CREATE TABLE "GaPropertyLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "propertyName" TEXT,
    "accountId" TEXT,
    "accountName" TEXT,
    "timeZone" TEXT,
    "currencyCode" TEXT,
    "industryCategory" TEXT,
    "serviceLevel" TEXT,
    "propertyCreatedAt" TIMESTAMP(3),
    "streamId" TEXT,
    "measurementId" TEXT,
    "streamUri" TEXT,
    "keyEvents" JSONB,
    "dataRetention" TEXT,
    "linkedProducts" JSONB,
    "catalog" JSONB,
    "health" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "healthReason" TEXT,
    "healthScore" INTEGER,
    "lastQuota" JSONB,
    "rateLimitedUntil" TIMESTAMP(3),
    "serverErrorsHour" JSONB,
    "syncLeaseUntil" TIMESTAMP(3),
    "syncLeaseOwner" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSyncError" TEXT,
    "lastMetadataAt" TIMESTAMP(3),
    "lastDailyAt" TIMESTAMP(3),
    "lastDailyDate" TEXT,
    "backfill" JSONB,
    "backfillDoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaPropertyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaDailyTotal" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "newUsers" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "engagedSessions" INTEGER NOT NULL DEFAULT 0,
    "engagementSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sessionDurationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "screenPageViews" INTEGER NOT NULL DEFAULT 0,
    "keyEvents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenueMicros" BIGINT NOT NULL DEFAULT 0,
    "transactions" INTEGER NOT NULL DEFAULT 0,
    "quality" JSONB,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaDailyTotal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaReportSlice" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "grain" TEXT NOT NULL DEFAULT 'DAY',
    "periodStart" DATE NOT NULL,
    "specVersion" INTEGER NOT NULL,
    "dimensionHeaders" TEXT[],
    "metricHeaders" TEXT[],
    "rows" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "otherRow" JSONB,
    "quality" JSONB,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaReportSlice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaMonthlySummary" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "totals" JSONB NOT NULL,
    "channels" JSONB NOT NULL,
    "topPages" JSONB NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaMonthlySummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GaPropertyLink_propertyId_idx" ON "GaPropertyLink"("propertyId");

-- CreateIndex
CREATE INDEX "GaPropertyLink_credentialId_idx" ON "GaPropertyLink"("credentialId");

-- CreateIndex
CREATE INDEX "GaPropertyLink_isPrimary_syncLeaseUntil_idx" ON "GaPropertyLink"("isPrimary", "syncLeaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "GaPropertyLink_projectId_propertyId_key" ON "GaPropertyLink"("projectId", "propertyId");

-- CreateIndex
CREATE INDEX "GaDailyTotal_projectId_date_idx" ON "GaDailyTotal"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GaDailyTotal_linkId_date_key" ON "GaDailyTotal"("linkId", "date");

-- CreateIndex
CREATE INDEX "GaReportSlice_projectId_reportKey_periodStart_idx" ON "GaReportSlice"("projectId", "reportKey", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "GaReportSlice_linkId_reportKey_grain_periodStart_key" ON "GaReportSlice"("linkId", "reportKey", "grain", "periodStart");

-- CreateIndex
CREATE INDEX "GaMonthlySummary_projectId_month_idx" ON "GaMonthlySummary"("projectId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "GaMonthlySummary_linkId_month_key" ON "GaMonthlySummary"("linkId", "month");

-- AddForeignKey
ALTER TABLE "GaDailyTotal" ADD CONSTRAINT "GaDailyTotal_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaReportSlice" ADD CONSTRAINT "GaReportSlice_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaMonthlySummary" ADD CONSTRAINT "GaMonthlySummary_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

