-- AlterTable
ALTER TABLE "AdsAlert" ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "GaHealthCheck" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "checkKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "evidence" JSONB,
    "guideId" TEXT NOT NULL,
    "firstFailedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "lastChangedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaHealthRun" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fingerprint" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "recheckRequestedAt" TIMESTAMP(3),
    "siteCheckedAt" TIMESTAMP(3),
    "siteTag" JSONB,
    "piiCheckedAt" TIMESTAMP(3),
    "piiProbe" JSONB,
    "realtime" JSONB,
    "suspectDays" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaHealthRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GaHealthCheck_projectId_status_idx" ON "GaHealthCheck"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GaHealthCheck_linkId_checkKey_key" ON "GaHealthCheck"("linkId", "checkKey");

-- CreateIndex
CREATE UNIQUE INDEX "GaHealthRun_linkId_key" ON "GaHealthRun"("linkId");

-- CreateIndex
CREATE INDEX "GaHealthRun_projectId_idx" ON "GaHealthRun"("projectId");

-- CreateIndex
CREATE INDEX "GaHealthRun_evaluatedAt_idx" ON "GaHealthRun"("evaluatedAt");

-- CreateIndex
CREATE INDEX "AdsAlert_projectId_source_status_idx" ON "AdsAlert"("projectId", "source", "status");

-- AddForeignKey
ALTER TABLE "GaHealthCheck" ADD CONSTRAINT "GaHealthCheck_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaHealthRun" ADD CONSTRAINT "GaHealthRun_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

