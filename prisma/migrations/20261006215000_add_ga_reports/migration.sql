-- CreateTable
CREATE TABLE "GaReportSettings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weeklyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "weeklyWeekday" INTEGER NOT NULL DEFAULT 1,
    "monthlyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "monthlyDay" INTEGER NOT NULL DEFAULT 2,
    "pulse" TEXT NOT NULL DEFAULT 'notable',
    "alertChat" BOOLEAN NOT NULL DEFAULT true,
    "alertTelegram" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaReportSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaReportRun" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastPulseDay" TEXT,
    "lastPulseAt" TIMESTAMP(3),
    "pulsePendingDay" TEXT,
    "pulsePendingSince" TIMESTAMP(3),
    "lastWeek" TEXT,
    "lastMonth" TEXT,
    "lastPlanMonth" TEXT,
    "lastGoalsDay" TEXT,
    "lastAlertScanAt" TIMESTAMP(3),
    "attempts" JSONB,
    "lastError" TEXT,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaGoalProgress" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "through" TEXT NOT NULL,
    "dayOfMonth" INTEGER NOT NULL,
    "daysInMonth" INTEGER NOT NULL,
    "monthToDate" DOUBLE PRECISION NOT NULL,
    "expectedShare" DOUBLE PRECISION,
    "forecast" DOUBLE PRECISION,
    "forecastLow" DOUBLE PRECISION,
    "forecastHigh" DOUBLE PRECISION,
    "forecastBasis" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaGoalProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GaReportSettings_projectId_key" ON "GaReportSettings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GaReportRun_linkId_key" ON "GaReportRun"("linkId");

-- CreateIndex
CREATE INDEX "GaReportRun_projectId_idx" ON "GaReportRun"("projectId");

-- CreateIndex
CREATE INDEX "GaReportRun_lastCheckedAt_idx" ON "GaReportRun"("lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GaGoalProgress_goalId_key" ON "GaGoalProgress"("goalId");

-- CreateIndex
CREATE INDEX "GaGoalProgress_projectId_idx" ON "GaGoalProgress"("projectId");

-- CreateIndex
CREATE INDEX "GaGoalProgress_linkId_idx" ON "GaGoalProgress"("linkId");

-- AddForeignKey
ALTER TABLE "GaReportRun" ADD CONSTRAINT "GaReportRun_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaGoalProgress" ADD CONSTRAINT "GaGoalProgress_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

