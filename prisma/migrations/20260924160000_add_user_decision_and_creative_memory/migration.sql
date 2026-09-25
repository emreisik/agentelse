-- CreateEnum
CREATE TYPE "LearningPolarity" AS ENUM ('WORKS', 'AVOID');

-- CreateEnum
CREATE TYPE "UserDecisionType" AS ENUM ('CREATIVE_PREFERENCE', 'MARKET_PRIORITY', 'AUTOMATION_PREFERENCE', 'CONTENT_PREFERENCE', 'BRAND_RULE', 'GOAL_CHANGE', 'CLAIM_CONFIRMATION');

-- AlterTable
ALTER TABLE "BrandLearning" ADD COLUMN     "polarity" "LearningPolarity" NOT NULL DEFAULT 'WORKS',
ADD COLUMN     "evidenceCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "lastReinforcedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UserDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "type" "UserDecisionType" NOT NULL,
    "scope" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "rawMessage" TEXT,
    "sourceCommandId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDecision_projectId_idx" ON "UserDecision"("projectId");

-- CreateIndex
CREATE INDEX "UserDecision_brandId_type_idx" ON "UserDecision"("brandId", "type");
