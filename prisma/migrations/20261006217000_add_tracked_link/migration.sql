-- CreateTable
CREATE TABLE "TrackedLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "taggedUrl" TEXT NOT NULL,
    "utmSource" TEXT NOT NULL,
    "utmMedium" TEXT NOT NULL,
    "utmCampaign" TEXT NOT NULL,
    "utmContent" TEXT NOT NULL,
    "label" TEXT,
    "campaignExternalId" TEXT,
    "adExternalId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkTrackingSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "utmEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkTrackingSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedLink_code_key" ON "TrackedLink"("code");

-- CreateIndex
CREATE INDEX "TrackedLink_projectId_utmCampaign_idx" ON "TrackedLink"("projectId", "utmCampaign");

-- CreateIndex
CREATE INDEX "TrackedLink_projectId_campaignExternalId_idx" ON "TrackedLink"("projectId", "campaignExternalId");

-- CreateIndex
CREATE INDEX "TrackedLink_projectId_adExternalId_idx" ON "TrackedLink"("projectId", "adExternalId");

-- CreateIndex
CREATE INDEX "TrackedLink_entityType_entityId_idx" ON "TrackedLink"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedLink_projectId_entityType_entityId_key" ON "TrackedLink"("projectId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkTrackingSetting_projectId_key" ON "LinkTrackingSetting"("projectId");

