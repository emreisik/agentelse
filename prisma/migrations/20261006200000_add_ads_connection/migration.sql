-- Meta Ads F8 (docs/meta-ads-plan.md): workspace düzeyinde Meta bağlantısı
-- (FLfB + BISU, sürümlü anahtar), hesabın bağlantısı ve async insights durumu,
-- aynada hedefleme özeti (kitle çakışması), proje harcama onaylayıcıları.
-- Yalnız ekleme.

-- AlterTable
ALTER TABLE "AutonomyPolicy" ADD COLUMN     "adsSpendApproverIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "AdsAccount" ADD COLUMN     "asyncInsights" JSONB,
ADD COLUMN     "connectionId" TEXT;

-- AlterTable
ALTER TABLE "AdsObject" ADD COLUMN     "targeting" JSONB;

-- CreateTable
CREATE TABLE "AdsConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "clientBusinessId" TEXT,
    "encryptedSecret" TEXT NOT NULL,
    "keyId" TEXT NOT NULL DEFAULT 'legacy',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "dataAccessExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastCheckedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdsConnection_workspaceId_idx" ON "AdsConnection"("workspaceId");

-- CreateIndex
CREATE INDEX "AdsAccount_connectionId_idx" ON "AdsAccount"("connectionId");

