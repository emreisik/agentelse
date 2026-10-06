-- Meta Ads F7 (docs/meta-ads-plan.md): otomatik pilot seviyesi ve aylık tavan,
-- hesap başına webhook durumu, gelen webhook olay kutusu. Yalnız ekleme.

-- AlterTable
ALTER TABLE "AutonomyPolicy" ADD COLUMN     "adsAutonomy" "AdsAutonomyLevel" NOT NULL DEFAULT 'SUGGEST',
ADD COLUMN     "adsMonthlyCapMinor" BIGINT;

-- AlterTable
ALTER TABLE "AdsAccount" ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "rulesHistoryAt" TIMESTAMP(3),
ADD COLUMN     "webhookCheckedAt" TIMESTAMP(3),
ADD COLUMN     "webhookStatus" TEXT;

-- CreateTable
CREATE TABLE "AdsWebhookEvent" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adAccountExternalId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "objectExternalId" TEXT,
    "objectLevel" TEXT,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AdsWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdsWebhookEvent_dedupeKey_key" ON "AdsWebhookEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "AdsWebhookEvent_status_receivedAt_idx" ON "AdsWebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "AdsWebhookEvent_receivedAt_idx" ON "AdsWebhookEvent"("receivedAt");
