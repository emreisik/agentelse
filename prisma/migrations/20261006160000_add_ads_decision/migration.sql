-- Optimizasyon karar kaydı (docs/meta-ads-plan.md F4).

-- CreateEnum
CREATE TYPE "AdsDecisionStatus" AS ENUM ('SHADOW', 'PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'APPLYING', 'APPLIED', 'VERIFIED', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "AdsAutonomyLevel" AS ENUM ('SUGGEST', 'GUARDED', 'FULL');

-- CreateTable
CREATE TABLE "AdsDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "adsAccountId" TEXT NOT NULL,
    "level" "AdsLevel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "AdsSeverity" NOT NULL,
    "status" "AdsDecisionStatus" NOT NULL,
    "autonomy" "AdsAutonomyLevel" NOT NULL DEFAULT 'SUGGEST',
    "evidence" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "change" JSONB,
    "fingerprint" TEXT NOT NULL,
    "approvalId" TEXT,
    "taskId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "evaluateAfter" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "outcomeData" JSONB,
    "rollbackOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdsDecision_fingerprint_key" ON "AdsDecision"("fingerprint");

-- CreateIndex
CREATE INDEX "AdsDecision_projectId_status_idx" ON "AdsDecision"("projectId", "status");

-- CreateIndex
CREATE INDEX "AdsDecision_adsAccountId_externalId_ruleKey_idx" ON "AdsDecision"("adsAccountId", "externalId", "ruleKey");

-- CreateIndex
CREATE INDEX "AdsDecision_status_evaluateAfter_idx" ON "AdsDecision"("status", "evaluateAfter");

