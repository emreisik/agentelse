-- Güvenli lansman v2 (docs/meta-ads-plan.md F3). META_LAUNCH yeteneği ayrı
-- klasörde eklenir (20261006150100_add_meta_launch_capability).

-- CreateEnum
CREATE TYPE "AdsLaunchStatus" AS ENUM ('DRAFT', 'MEDIA_PROCESSING', 'VALIDATED', 'AWAITING_APPROVAL', 'CREATING', 'CREATED_PAUSED', 'ACTIVATING', 'ACTIVE', 'FAILED', 'EXPIRED', 'CANCELLED', 'DISCARDING', 'DISCARDED');

-- CreateTable
CREATE TABLE "AdsLaunch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workId" TEXT,
    "commandId" TEXT NOT NULL,
    "launchKey" TEXT NOT NULL,
    "adsAccountId" TEXT,
    "adAccountExternalId" TEXT NOT NULL,
    "status" "AdsLaunchStatus" NOT NULL DEFAULT 'DRAFT',
    "specVersion" INTEGER NOT NULL DEFAULT 1,
    "spec" JSONB NOT NULL,
    "specHash" TEXT NOT NULL,
    "validation" JSONB,
    "approvalId" TEXT,
    "activationApprovalId" TEXT,
    "currentTaskId" TEXT,
    "mode" TEXT,
    "campaignExternalId" TEXT,
    "progress" JSONB,
    "envelope" JSONB,
    "guards" JSONB,
    "error" JSONB,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "createdByUserId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsLaunch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsLaunch_projectId_status_idx" ON "AdsLaunch"("projectId", "status");

-- CreateIndex
CREATE INDEX "AdsLaunch_status_updatedAt_idx" ON "AdsLaunch"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdsLaunch_commandId_launchKey_key" ON "AdsLaunch"("commandId", "launchKey");
