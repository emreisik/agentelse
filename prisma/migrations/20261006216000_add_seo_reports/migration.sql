-- CreateTable
CREATE TABLE "SeoReport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "finalThrough" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "narrative" JSONB,
    "narrativeNote" TEXT,
    "commandId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoReportState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "pulseDay" TEXT,
    "pulseCheckedAt" TIMESTAMP(3),
    "weeklyWeek" TEXT,
    "monthlyMonth" TEXT,
    "roadmapMonth" TEXT,
    "goalsDay" TEXT,
    "weeklyWaitWeek" TEXT,
    "weeklyWaitUntil" TIMESTAMP(3),
    "monthlyWaitMonth" TEXT,
    "monthlyWaitUntil" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoReportState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoGoalProgress" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "measuredThrough" TEXT,
    "pace" TEXT NOT NULL DEFAULT 'unknown',
    "projected" DOUBLE PRECISION,
    "projectedLow" DOUBLE PRECISION,
    "projectedHigh" DOUBLE PRECISION,
    "series" JSONB,
    "reason" TEXT,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoGoalProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoReport_commandId_key" ON "SeoReport"("commandId");

-- CreateIndex
CREATE INDEX "SeoReport_projectId_isMock_createdAt_idx" ON "SeoReport"("projectId", "isMock", "createdAt");

-- CreateIndex
CREATE INDEX "SeoReport_kind_createdAt_idx" ON "SeoReport"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeoReport_linkId_kind_periodKey_key" ON "SeoReport"("linkId", "kind", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "SeoReportState_linkId_key" ON "SeoReportState"("linkId");

-- CreateIndex
CREATE INDEX "SeoReportState_projectId_idx" ON "SeoReportState"("projectId");

-- CreateIndex
CREATE INDEX "SeoReportState_isMock_nextRunAt_idx" ON "SeoReportState"("isMock", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeoGoalProgress_goalId_key" ON "SeoGoalProgress"("goalId");

-- CreateIndex
CREATE INDEX "SeoGoalProgress_projectId_isMock_idx" ON "SeoGoalProgress"("projectId", "isMock");

-- CreateIndex
CREATE INDEX "SeoGoalProgress_linkId_idx" ON "SeoGoalProgress"("linkId");

-- AddForeignKey
ALTER TABLE "SeoReport" ADD CONSTRAINT "SeoReport_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoReportState" ADD CONSTRAINT "SeoReportState_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoGoalProgress" ADD CONSTRAINT "SeoGoalProgress_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

