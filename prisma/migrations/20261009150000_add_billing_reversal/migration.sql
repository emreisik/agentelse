-- Ödemeler (Faz 4) inceleme düzeltmeleri: iade/itiraz mezar taşı ve satıra en son uygulanan
-- Stripe anlık görüntüsünün zamanı. Yalnız EKLEME: mevcut satırlara dokunulmaz.

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "stripeSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BillingReversal" (
    "id" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingReversal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingReversal_stripeInvoiceId_key" ON "BillingReversal"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "BillingReversal_workspaceId_idx" ON "BillingReversal"("workspaceId");

-- Veritabanı düzeyi değişmez (Prisma modelleyemez): yanlış yazım sessizce bozmaz.
ALTER TABLE "BillingReversal"
  ADD CONSTRAINT "BillingReversal_reason_check"
    CHECK ("reason" IN ('REFUNDED', 'CHARGEBACK'));
