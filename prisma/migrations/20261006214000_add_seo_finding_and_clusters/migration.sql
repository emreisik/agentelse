-- CreateTable
CREATE TABLE "SeoEngineState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastWeek" TEXT,
    "lastRunStats" JSONB,
    "curves" JSONB,
    "curvesWeek" TEXT,
    "classifiedAt" TIMESTAMP(3),
    "intentBrandHash" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "clustersWeek" TEXT,
    "explainedWeek" TEXT,
    "brandSuggestions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoEngineState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoFinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "periodKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "shadow" BOOLEAN NOT NULL DEFAULT false,
    "effort" TEXT NOT NULL,
    "actionKind" TEXT NOT NULL,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "impact" JSONB,
    "explanation" TEXT,
    "explainedAt" TIMESTAMP(3),
    "keyword" TEXT,
    "ideaWorthy" BOOLEAN NOT NULL DEFAULT false,
    "signalWorthy" BOOLEAN NOT NULL DEFAULT false,
    "fingerprint" TEXT NOT NULL,
    "signalId" TEXT,
    "ideaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pageId" TEXT,
    "queryId" TEXT,
    "clusterId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "dismissReason" TEXT,
    "review" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "evaluateAfter" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoCluster" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameSource" TEXT NOT NULL,
    "pillarPageId" TEXT,
    "queryCount" INTEGER NOT NULL DEFAULT 0,
    "impressions28d" INTEGER NOT NULL DEFAULT 0,
    "clicks28d" INTEGER NOT NULL DEFAULT 0,
    "topQueryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "week" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoQueryEmbedding" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "vector" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoQueryEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoEngineState_linkId_key" ON "SeoEngineState"("linkId");

-- CreateIndex
CREATE INDEX "SeoEngineState_isMock_nextRunAt_idx" ON "SeoEngineState"("isMock", "nextRunAt");

-- CreateIndex
CREATE INDEX "SeoEngineState_projectId_idx" ON "SeoEngineState"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SeoFinding_fingerprint_key" ON "SeoFinding"("fingerprint");

-- CreateIndex
CREATE INDEX "SeoFinding_projectId_status_idx" ON "SeoFinding"("projectId", "status");

-- CreateIndex
CREATE INDEX "SeoFinding_linkId_status_idx" ON "SeoFinding"("linkId", "status");

-- CreateIndex
CREATE INDEX "SeoFinding_linkId_ruleKey_subject_idx" ON "SeoFinding"("linkId", "ruleKey", "subject");

-- CreateIndex
CREATE INDEX "SeoFinding_shadow_createdAt_idx" ON "SeoFinding"("shadow", "createdAt");

-- CreateIndex
CREATE INDEX "SeoFinding_createdAt_idx" ON "SeoFinding"("createdAt");

-- CreateIndex
CREATE INDEX "SeoCluster_linkId_status_idx" ON "SeoCluster"("linkId", "status");

-- CreateIndex
CREATE INDEX "SeoCluster_projectId_idx" ON "SeoCluster"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SeoQueryEmbedding_queryId_key" ON "SeoQueryEmbedding"("queryId");

-- CreateIndex
CREATE INDEX "SeoQueryEmbedding_linkId_idx" ON "SeoQueryEmbedding"("linkId");

-- CreateIndex
CREATE INDEX "SeoQueryEmbedding_projectId_idx" ON "SeoQueryEmbedding"("projectId");

-- CreateIndex
CREATE INDEX "GscQuery_linkId_clusterId_idx" ON "GscQuery"("linkId", "clusterId");

-- AddForeignKey
ALTER TABLE "SeoEngineState" ADD CONSTRAINT "SeoEngineState_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoFinding" ADD CONSTRAINT "SeoFinding_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoCluster" ADD CONSTRAINT "SeoCluster_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeoQueryEmbedding" ADD CONSTRAINT "SeoQueryEmbedding_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

