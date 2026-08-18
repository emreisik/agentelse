-- DropForeignKey
ALTER TABLE "AgencyIdea" DROP CONSTRAINT "AgencyIdea_opportunityId_fkey";

-- DropForeignKey
ALTER TABLE "Opportunity" DROP CONSTRAINT "Opportunity_insightId_fkey";

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "level" "ApprovalLevel";

-- AlterTable
ALTER TABLE "BrandFact" ADD COLUMN     "classification" "FactClassification",
ADD COLUMN     "evidenceId" TEXT;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "category" "SignalCategory",
ADD COLUMN     "confidenceScore" DOUBLE PRECISION,
ADD COLUMN     "cooldownUntil" TIMESTAMP(3),
ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "evidenceStrength" DOUBLE PRECISION,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "goalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "isMock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nbaScore" DOUBLE PRECISION,
ADD COLUMN     "riskScore" DOUBLE PRECISION,
ADD COLUMN     "timeWindowEnd" TIMESTAMP(3),
ADD COLUMN     "timeWindowStart" TIMESTAMP(3),
ADD COLUMN     "urgencyScore" DOUBLE PRECISION,
ADD COLUMN     "valueScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "departmentKey" "DepartmentKey",
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "goalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sourceDecisionId" TEXT,
ADD COLUMN     "workPlanId" TEXT;

-- DropTable
DROP TABLE "AgencyIdea";

-- CreateTable
CREATE TABLE "ProjectSetupState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "currentStage" "SetupStage" NOT NULL DEFAULT 'INTAKE',
    "intake" JSONB NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSetupState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSetupStageRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "setupStateId" TEXT NOT NULL,
    "stage" "SetupStage" NOT NULL,
    "status" "SetupStageStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "output" JSONB,
    "error" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSetupStageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandConstitution" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BrandConstitutionStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "summary" TEXT,
    "sourceFindingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandConstitution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSignalProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "category" "SignalCategory" NOT NULL,
    "intensity" "SignalIntensity" NOT NULL DEFAULT 'MEDIUM',
    "config" JSONB,
    "lastScanAt" TIMESTAMP(3),
    "nextScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSignalProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" "SignalCategory" NOT NULL,
    "externalRef" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3),
    "freshness" DOUBLE PRECISION,
    "reliability" DOUBLE PRECISION,
    "relevanceScore" DOUBLE PRECISION,
    "status" "SignalStatus" NOT NULL DEFAULT 'NEW',
    "fingerprint" TEXT NOT NULL,
    "duplicateOfId" TEXT,
    "evidenceId" TEXT,
    "sourceTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "sourceType" "FindingSourceType" NOT NULL,
    "sourceTaskId" TEXT,
    "signalId" TEXT,
    "category" TEXT,
    "statement" TEXT NOT NULL,
    "details" JSONB,
    "classification" "FactClassification" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "evidenceId" TEXT,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "category" "SignalCategory",
    "findingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importance" DOUBLE PRECISION,
    "status" "InsightStatus" NOT NULL DEFAULT 'NEW',
    "fingerprint" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Idea" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "lens" "CreativeLens",
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "concept" JSONB,
    "status" "IdeaStatus" NOT NULL DEFAULT 'RAW',
    "fingerprint" TEXT,
    "scores" JSONB,
    "nbaScore" DOUBLE PRECISION,
    "workPlanId" TEXT,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Idea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouncilEvaluation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "councilType" "CouncilType" NOT NULL,
    "scores" JSONB NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "recommendation" "CouncilRecommendation" NOT NULL,
    "rationale" TEXT,
    "reasoningCallId" TEXT,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouncilEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "subjectType" "AgencyDecisionSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "decision" "AgencyDecisionType" NOT NULL,
    "rationale" TEXT NOT NULL,
    "scoreBreakdown" JSONB,
    "inputsSnapshot" JSONB,
    "workPlanId" TEXT,
    "taskIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalLevel" "ApprovalLevel",
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGoal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "metricKey" TEXT,
    "targetValue" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "status" "ProjectGoalStatus" NOT NULL DEFAULT 'PROPOSED',
    "sourceInsightIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvedByType" "ActorType",
    "approvedByUserId" TEXT,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectDepartment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "department" "DepartmentKey" NOT NULL,
    "mode" "DepartmentMode" NOT NULL DEFAULT 'LISTEN',
    "recommendedMode" "DepartmentMode",
    "recommendationRationale" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaselineAudit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "department" "DepartmentKey" NOT NULL,
    "score" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "strengths" JSONB NOT NULL,
    "weaknesses" JSONB NOT NULL,
    "risks" JSONB NOT NULL,
    "potentialOpportunities" JSONB NOT NULL,
    "findingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BaselineAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "ideaId" TEXT,
    "opportunityId" TEXT,
    "decisionId" TEXT,
    "title" TEXT NOT NULL,
    "planType" "WorkPlanType" NOT NULL,
    "status" "WorkPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "goalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "graph" JSONB NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkHandoff" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "workPlanId" TEXT,
    "fromDepartment" "DepartmentKey" NOT NULL,
    "toDepartment" "DepartmentKey" NOT NULL,
    "fromTaskId" TEXT,
    "toTaskId" TEXT,
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "status" "WorkHandoffStatus" NOT NULL DEFAULT 'PROPOSED',
    "decisionId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "taskId" TEXT,
    "workPlanId" TEXT,
    "ideaId" TEXT,
    "description" TEXT NOT NULL,
    "status" "MeasurementPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeasurementPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeasurementCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "capability" "CapabilityKey" NOT NULL DEFAULT 'MEASUREMENT_CHECK',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "MeasurementCheckStatus" NOT NULL DEFAULT 'PENDING',
    "resultTaskId" TEXT,
    "resultSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeasurementCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyTrigger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "type" "AgencyTriggerType" NOT NULL,
    "payload" JSONB,
    "dedupeKey" TEXT,
    "status" "AgencyTriggerStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutonomyPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "setupAutoApprove" BOOLEAN NOT NULL DEFAULT false,
    "maxTasksPerDay" INTEGER NOT NULL DEFAULT 25,
    "maxReasoningCallsPerDay" INTEGER NOT NULL DEFAULT 200,
    "maxConcurrentResearchTasks" INTEGER NOT NULL DEFAULT 5,
    "maxOpenOpportunities" INTEGER NOT NULL DEFAULT 30,
    "maxActiveIdeas" INTEGER NOT NULL DEFAULT 20,
    "dailyBudgetUsd" DOUBLE PRECISION,
    "taskCooldownHours" INTEGER NOT NULL DEFAULT 72,
    "scoringWeights" JSONB,
    "approvalOverrides" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutonomyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyDailyStat" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "tasksCreated" INTEGER NOT NULL DEFAULT 0,
    "reasoningCalls" INTEGER NOT NULL DEFAULT 0,
    "signalsIngested" INTEGER NOT NULL DEFAULT 0,
    "opportunitiesCreated" INTEGER NOT NULL DEFAULT 0,
    "ideasCreated" INTEGER NOT NULL DEFAULT 0,
    "reasoningCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReasoningCall" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "brandId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "durationMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReasoningCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSetupState_projectId_key" ON "ProjectSetupState"("projectId");

-- CreateIndex
CREATE INDEX "ProjectSetupState_workspaceId_idx" ON "ProjectSetupState"("workspaceId");

-- CreateIndex
CREATE INDEX "ProjectSetupStageRecord_projectId_idx" ON "ProjectSetupStageRecord"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSetupStageRecord_projectId_stage_key" ON "ProjectSetupStageRecord"("projectId", "stage");

-- CreateIndex
CREATE INDEX "BrandConstitution_projectId_idx" ON "BrandConstitution"("projectId");

-- CreateIndex
CREATE INDEX "BrandConstitution_brandId_status_idx" ON "BrandConstitution"("brandId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BrandConstitution_brandId_version_key" ON "BrandConstitution"("brandId", "version");

-- CreateIndex
CREATE INDEX "ProjectSignalProfile_projectId_idx" ON "ProjectSignalProfile"("projectId");

-- CreateIndex
CREATE INDEX "ProjectSignalProfile_nextScanAt_idx" ON "ProjectSignalProfile"("nextScanAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSignalProfile_projectId_category_key" ON "ProjectSignalProfile"("projectId", "category");

-- CreateIndex
CREATE INDEX "Signal_projectId_status_idx" ON "Signal"("projectId", "status");

-- CreateIndex
CREATE INDEX "Signal_projectId_category_idx" ON "Signal"("projectId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_projectId_fingerprint_key" ON "Signal"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "Finding_projectId_classification_idx" ON "Finding"("projectId", "classification");

-- CreateIndex
CREATE INDEX "Finding_projectId_sourceType_idx" ON "Finding"("projectId", "sourceType");

-- CreateIndex
CREATE INDEX "Finding_sourceTaskId_idx" ON "Finding"("sourceTaskId");

-- CreateIndex
CREATE INDEX "Insight_projectId_status_idx" ON "Insight"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Insight_projectId_fingerprint_key" ON "Insight"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "Idea_projectId_status_idx" ON "Idea"("projectId", "status");

-- CreateIndex
CREATE INDEX "Idea_projectId_fingerprint_idx" ON "Idea"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "Idea_opportunityId_idx" ON "Idea"("opportunityId");

-- CreateIndex
CREATE INDEX "CouncilEvaluation_ideaId_idx" ON "CouncilEvaluation"("ideaId");

-- CreateIndex
CREATE INDEX "CouncilEvaluation_projectId_idx" ON "CouncilEvaluation"("projectId");

-- CreateIndex
CREATE INDEX "AgencyDecision_projectId_idx" ON "AgencyDecision"("projectId");

-- CreateIndex
CREATE INDEX "AgencyDecision_subjectType_subjectId_idx" ON "AgencyDecision"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ProjectGoal_projectId_status_idx" ON "ProjectGoal"("projectId", "status");

-- CreateIndex
CREATE INDEX "ProjectDepartment_projectId_idx" ON "ProjectDepartment"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDepartment_projectId_department_key" ON "ProjectDepartment"("projectId", "department");

-- CreateIndex
CREATE INDEX "BaselineAudit_projectId_idx" ON "BaselineAudit"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BaselineAudit_projectId_department_key" ON "BaselineAudit"("projectId", "department");

-- CreateIndex
CREATE INDEX "WorkPlan_projectId_status_idx" ON "WorkPlan"("projectId", "status");

-- CreateIndex
CREATE INDEX "WorkHandoff_projectId_status_idx" ON "WorkHandoff"("projectId", "status");

-- CreateIndex
CREATE INDEX "WorkHandoff_workPlanId_idx" ON "WorkHandoff"("workPlanId");

-- CreateIndex
CREATE INDEX "MeasurementPlan_projectId_status_idx" ON "MeasurementPlan"("projectId", "status");

-- CreateIndex
CREATE INDEX "MeasurementPlan_taskId_idx" ON "MeasurementPlan"("taskId");

-- CreateIndex
CREATE INDEX "MeasurementCheck_status_dueAt_idx" ON "MeasurementCheck"("status", "dueAt");

-- CreateIndex
CREATE INDEX "MeasurementCheck_planId_idx" ON "MeasurementCheck"("planId");

-- CreateIndex
CREATE INDEX "AgencyTrigger_status_scheduledFor_idx" ON "AgencyTrigger"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "AgencyTrigger_projectId_type_idx" ON "AgencyTrigger"("projectId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyTrigger_projectId_dedupeKey_key" ON "AgencyTrigger"("projectId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "AutonomyPolicy_projectId_key" ON "AutonomyPolicy"("projectId");

-- CreateIndex
CREATE INDEX "AutonomyPolicy_workspaceId_idx" ON "AutonomyPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "AgencyDailyStat_projectId_idx" ON "AgencyDailyStat"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyDailyStat_projectId_date_key" ON "AgencyDailyStat"("projectId", "date");

-- CreateIndex
CREATE INDEX "ReasoningCall_projectId_createdAt_idx" ON "ReasoningCall"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ReasoningCall_purpose_idx" ON "ReasoningCall"("purpose");

-- CreateIndex
CREATE INDEX "Opportunity_projectId_status_idx" ON "Opportunity"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_projectId_fingerprint_key" ON "Opportunity"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "Task_projectId_fingerprint_createdAt_idx" ON "Task"("projectId", "fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "Task_workPlanId_idx" ON "Task"("workPlanId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workPlanId_fkey" FOREIGN KEY ("workPlanId") REFERENCES "WorkPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "Insight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSetupStageRecord" ADD CONSTRAINT "ProjectSetupStageRecord_setupStateId_fkey" FOREIGN KEY ("setupStateId") REFERENCES "ProjectSetupState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Idea" ADD CONSTRAINT "Idea_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouncilEvaluation" ADD CONSTRAINT "CouncilEvaluation_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkHandoff" ADD CONSTRAINT "WorkHandoff_workPlanId_fkey" FOREIGN KEY ("workPlanId") REFERENCES "WorkPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeasurementCheck" ADD CONSTRAINT "MeasurementCheck_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MeasurementPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;


