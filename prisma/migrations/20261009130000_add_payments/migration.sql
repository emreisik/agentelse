-- Ödemeler (Faz 4): Stripe müşteri eşlemesi, geçerli Stripe aboneliği ve webhook
-- gelen kutusu. Yalnız EKLEME: mevcut satırlara dokunulmaz (yeni sütun boş başlar).

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "stripeSubscriptionId" TEXT,
ADD COLUMN "stripeLivemode" BOOLEAN;

-- CreateTable
CREATE TABLE "BillingCustomer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "objectId" TEXT,
    "livemode" BOOLEAN NOT NULL DEFAULT false,
    "workspaceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCustomer_workspaceId_livemode_key" ON "BillingCustomer"("workspaceId", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCustomer_stripeCustomerId_key" ON "BillingCustomer"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "BillingEvent_status_receivedAt_idx" ON "BillingEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "BillingEvent_workspaceId_receivedAt_idx" ON "BillingEvent"("workspaceId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_provider_eventId_key" ON "BillingEvent"("provider", "eventId");

-- Veritabanı düzeyi değişmezler (Prisma modelleyemez): yanlış yazım sessizce bozmaz,
-- hata verir (SQLSTATE 23514).
ALTER TABLE "BillingEvent"
  ADD CONSTRAINT "BillingEvent_provider_check"
    CHECK ("provider" IN ('stripe')),
  ADD CONSTRAINT "BillingEvent_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED'));
