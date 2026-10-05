-- CreateIndex
CREATE INDEX IF NOT EXISTS "BrandLearning_sourceType_sourceRef_idx" ON "BrandLearning"("sourceType", "sourceRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Command_projectId_source_createdAt_idx" ON "Command"("projectId", "source", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_commandId_idx" ON "Task"("commandId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_projectId_capability_createdAt_idx" ON "Task"("projectId", "capability", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_parentTaskId_idx" ON "Task"("parentTaskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ExecutionJob_providerId_updatedAt_idx" ON "ExecutionJob"("providerId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HumanInterventionRequest_taskId_idx" ON "HumanInterventionRequest"("taskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HumanInterventionRequest_executionJobId_idx" ON "HumanInterventionRequest"("executionJobId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Approval_projectId_status_createdAt_idx" ON "Approval"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Approval_taskId_idx" ON "Approval"("taskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Asset_projectId_createdAt_idx" ON "Asset"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Creative_createdByTaskId_idx" ON "Creative"("createdByTaskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OutboxEvent_executionJobId_idx" ON "OutboxEvent"("executionJobId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_projectId_createdAt_idx" ON "AuditLog"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProjectSetupStageRecord_setupStateId_idx" ON "ProjectSetupStageRecord"("setupStateId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Signal_status_createdAt_idx" ON "Signal"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Insight_status_createdAt_idx" ON "Insight"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Idea_status_createdAt_idx" ON "Idea"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkHandoff_toTaskId_idx" ON "WorkHandoff"("toTaskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MeasurementCheck_resultTaskId_idx" ON "MeasurementCheck"("resultTaskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ReasoningCall_projectId_purpose_createdAt_idx" ON "ReasoningCall"("projectId", "purpose", "createdAt");


-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_projectId_updatedAt_idx" ON "Task"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Creative_projectId_updatedAt_idx" ON "Creative"("projectId", "updatedAt");

