-- Faz 2: abonelik aynası, kullanım bakiyesi, rezervasyon ve hak defteri.
-- Yalnız yeni tablolar (additive); hiçbirinde `projectId` kolonu ve yabancı anahtar yok.

CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planKey" TEXT,
    "interval" TEXT,
    "status" TEXT NOT NULL,
    "quotaAnchor" TIMESTAMP(3),
    "paidThrough" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "legacyUntil" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "periodIndex" INTEGER NOT NULL DEFAULT 1,
    "introOffer" BOOLEAN NOT NULL DEFAULT false,
    "pendingPlanKey" TEXT,
    "pendingInterval" TEXT,
    "pendingEffectiveAt" TIMESTAMP(3),
    "exempt" BOOLEAN NOT NULL DEFAULT false,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageBalance" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "periodGranted" BIGINT NOT NULL DEFAULT 0,
    "periodUsed" BIGINT NOT NULL DEFAULT 0,
    "periodReserved" BIGINT NOT NULL DEFAULT 0,
    "extraGranted" BIGINT NOT NULL DEFAULT 0,
    "extraUsed" BIGINT NOT NULL DEFAULT 0,
    "extraReserved" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageBalance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageReservation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "reservationKey" TEXT NOT NULL,
    "operationId" TEXT,
    "amount" BIGINT NOT NULL,
    "fromPeriod" BIGINT NOT NULL DEFAULT 0,
    "fromExtra" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "settledAmount" BIGINT,
    "overdraft" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "UsageReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "reverses" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_workspaceId_key" ON "Subscription"("workspaceId");

CREATE INDEX "UsageBalance_periodEnd_idx" ON "UsageBalance"("periodEnd");

CREATE UNIQUE INDEX "UsageBalance_workspaceId_unit_key" ON "UsageBalance"("workspaceId", "unit");

CREATE INDEX "UsageReservation_status_expiresAt_idx" ON "UsageReservation"("status", "expiresAt");

CREATE INDEX "UsageReservation_workspaceId_operationId_idx" ON "UsageReservation"("workspaceId", "operationId");

CREATE UNIQUE INDEX "UsageReservation_workspaceId_unit_reservationKey_key" ON "UsageReservation"("workspaceId", "unit", "reservationKey");

CREATE INDEX "UsageGrant_workspaceId_createdAt_idx" ON "UsageGrant"("workspaceId", "createdAt");

CREATE UNIQUE INDEX "UsageGrant_workspaceId_idempotencyKey_unit_reason_key" ON "UsageGrant"("workspaceId", "idempotencyKey", "unit", "reason");

-- Veritabanı düzeyi değişmezler (Prisma modelleyemez): yanlış yazım sessizce bozmaz,
-- hata verir (SQLSTATE 23514).
ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_status_check"
    CHECK ("status" IN ('LEGACY', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED')),
  ADD CONSTRAINT "Subscription_interval_check"
    CHECK ("interval" IS NULL OR "interval" IN ('MONTH', 'YEAR'));

ALTER TABLE "UsageBalance"
  ADD CONSTRAINT "UsageBalance_unit_check"
    CHECK ("unit" IN ('IMAGE', 'VIDEO', 'AI_MICROS')),
  ADD CONSTRAINT "UsageBalance_nonnegative_check"
    CHECK ("periodGranted" >= 0 AND "periodUsed" >= 0 AND "periodReserved" >= 0
       AND "extraGranted" >= 0 AND "extraUsed" >= 0 AND "extraReserved" >= 0);

ALTER TABLE "UsageReservation"
  ADD CONSTRAINT "UsageReservation_unit_check"
    CHECK ("unit" IN ('IMAGE', 'VIDEO', 'AI_MICROS')),
  ADD CONSTRAINT "UsageReservation_status_check"
    CHECK ("status" IN ('RESERVED', 'SETTLED', 'RELEASED')),
  ADD CONSTRAINT "UsageReservation_amount_check"
    CHECK ("amount" > 0 AND "fromPeriod" >= 0 AND "fromExtra" >= 0
       AND ("settledAmount" IS NULL OR "settledAmount" >= 0));

ALTER TABLE "UsageGrant"
  ADD CONSTRAINT "UsageGrant_unit_check"
    CHECK ("unit" IN ('IMAGE', 'VIDEO', 'AI_MICROS')),
  ADD CONSTRAINT "UsageGrant_pool_check"
    CHECK ("pool" IN ('PERIOD', 'EXTRA')),
  ADD CONSTRAINT "UsageGrant_amount_check"
    CHECK ("amount" <> 0);
