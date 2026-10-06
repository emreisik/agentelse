-- CreateTable
CREATE TABLE "GaFinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "periodGrain" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "mode" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidence" JSONB NOT NULL,
    "impact" JSONB,
    "explanation" TEXT,
    "explainedAt" TIMESTAMP(3),
    "rank" INTEGER,
    "fingerprint" TEXT NOT NULL,
    "previousId" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "signalId" TEXT,
    "ideaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByUserId" TEXT,
    "doneAt" TIMESTAMP(3),
    "evaluateAfter" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "outcomeEvidence" JSONB,
    "closedReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "reviewVerdict" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaAnalysisRun" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastDailyDay" TEXT,
    "lastDailyAt" TIMESTAMP(3),
    "lastWeek" TEXT,
    "lastWeeklyAt" TIMESTAMP(3),
    "lastMonth" TEXT,
    "lastExplainedWeek" TEXT,
    "lastError" TEXT,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GaFinding_fingerprint_key" ON "GaFinding"("fingerprint");

-- CreateIndex
CREATE INDEX "GaFinding_projectId_status_idx" ON "GaFinding"("projectId", "status");

-- CreateIndex
CREATE INDEX "GaFinding_linkId_ruleKey_subjectKey_periodStart_idx" ON "GaFinding"("linkId", "ruleKey", "subjectKey", "periodStart");

-- CreateIndex
CREATE INDEX "GaFinding_status_evaluateAfter_idx" ON "GaFinding"("status", "evaluateAfter");

-- CreateIndex
CREATE INDEX "GaFinding_mode_createdAt_idx" ON "GaFinding"("mode", "createdAt");

-- CreateIndex
CREATE INDEX "GaFinding_createdAt_idx" ON "GaFinding"("createdAt");

-- CreateIndex
CREATE INDEX "GaFinding_closedAt_idx" ON "GaFinding"("closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GaAnalysisRun_linkId_key" ON "GaAnalysisRun"("linkId");

-- CreateIndex
CREATE INDEX "GaAnalysisRun_projectId_idx" ON "GaAnalysisRun"("projectId");

-- CreateIndex
CREATE INDEX "GaAnalysisRun_lastDailyAt_idx" ON "GaAnalysisRun"("lastDailyAt");

-- CreateIndex
CREATE INDEX "GaAnalysisRun_lastCheckedAt_idx" ON "GaAnalysisRun"("lastCheckedAt");

-- AddForeignKey
ALTER TABLE "GaFinding" ADD CONSTRAINT "GaFinding_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaAnalysisRun" ADD CONSTRAINT "GaAnalysisRun_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

