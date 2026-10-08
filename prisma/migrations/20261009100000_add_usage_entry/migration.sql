-- CreateTable
CREATE TABLE "UsageEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectRef" TEXT,
    "userId" TEXT,
    "module" TEXT,
    "source" TEXT,
    "operationId" TEXT,
    "callId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedTokens" INTEGER,
    "webSearchCalls" INTEGER,
    "units" INTEGER,
    "costMicros" BIGINT NOT NULL,
    "costEstimated" BOOLEAN NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "priceTable" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageEntry_callId_key" ON "UsageEntry"("callId");

-- CreateIndex
CREATE INDEX "UsageEntry_workspaceId_createdAt_idx" ON "UsageEntry"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEntry_operationId_idx" ON "UsageEntry"("operationId");

-- CreateIndex
CREATE INDEX "UsageEntry_provider_createdAt_idx" ON "UsageEntry"("provider", "createdAt");
