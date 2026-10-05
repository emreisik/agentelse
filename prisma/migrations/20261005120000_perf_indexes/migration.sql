-- CreateIndex
CREATE INDEX "BrandLearning_sourceType_sourceRef_idx" ON "BrandLearning"("sourceType", "sourceRef");

-- CreateIndex
CREATE INDEX "Command_projectId_source_createdAt_idx" ON "Command"("projectId", "source", "createdAt");

-- CreateIndex
CREATE INDEX "Task_commandId_idx" ON "Task"("commandId");

-- CreateIndex
CREATE INDEX "Task_projectId_capability_createdAt_idx" ON "Task"("projectId", "capability", "createdAt");

-- CreateIndex
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");

-- CreateIndex
CREATE INDEX "ExecutionJob_providerId_updatedAt_idx" ON "ExecutionJob"("providerId", "updatedAt");

-- CreateIndex
CREATE INDEX "HumanInterventionRequest_taskId_idx" ON "HumanInterventionRequest"("taskId");

-- CreateIndex
CREATE INDEX "HumanInterventionRequest_executionJobId_idx" ON "HumanInterventionRequest"("executionJobId");

-- CreateIndex
CREATE INDEX "Approval_projectId_status_createdAt_idx" ON "Approval"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_taskId_idx" ON "Approval"("taskId");

-- CreateIndex
CREATE INDEX "Asset_projectId_createdAt_idx" ON "Asset"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Creative_createdByTaskId_idx" ON "Creative"("createdByTaskId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_executionJobId_idx" ON "OutboxEvent"("executionJobId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_projectId_createdAt_idx" ON "AuditLog"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectSetupStageRecord_setupStateId_idx" ON "ProjectSetupStageRecord"("setupStateId");

-- CreateIndex
CREATE INDEX "Signal_status_createdAt_idx" ON "Signal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Insight_status_createdAt_idx" ON "Insight"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Idea_status_createdAt_idx" ON "Idea"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WorkHandoff_toTaskId_idx" ON "WorkHandoff"("toTaskId");

-- CreateIndex
CREATE INDEX "MeasurementCheck_resultTaskId_idx" ON "MeasurementCheck"("resultTaskId");

-- CreateIndex
CREATE INDEX "ReasoningCall_projectId_purpose_createdAt_idx" ON "ReasoningCall"("projectId", "purpose", "createdAt");


-- CreateIndex
CREATE INDEX "Task_projectId_updatedAt_idx" ON "Task"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "Creative_projectId_updatedAt_idx" ON "Creative"("projectId", "updatedAt");

