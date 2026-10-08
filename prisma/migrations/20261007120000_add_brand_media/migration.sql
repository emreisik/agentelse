-- CreateEnum
CREATE TYPE "BrandMediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "BrandMediaStatus" AS ENUM ('PENDING', 'OK', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "photoAssetIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "BrandMedia" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" "BrandMediaKind" NOT NULL DEFAULT 'IMAGE',
    "status" "BrandMediaStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "analyzedAt" TIMESTAMP(3),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "subjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "setting" TEXT,
    "mood" TEXT,
    "shotType" TEXT,
    "orientation" TEXT,
    "hasPeople" BOOLEAN NOT NULL DEFAULT false,
    "quality" INTEGER,
    "dominantColors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "focalX" DOUBLE PRECISION,
    "focalY" DOUBLE PRECISION,
    "tagsEdited" BOOLEAN NOT NULL DEFAULT false,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "posterAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandMedia_assetId_key" ON "BrandMedia"("assetId");

-- CreateIndex
CREATE INDEX "BrandMedia_projectId_status_idx" ON "BrandMedia"("projectId", "status");

-- CreateIndex
CREATE INDEX "BrandMedia_projectId_archivedAt_createdAt_idx" ON "BrandMedia"("projectId", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "BrandMedia_tags_idx" ON "BrandMedia" USING GIN ("tags");
