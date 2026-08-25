-- Hand-authored to match schema.prisma's BrandVisualIdentity addition,
-- which was already applied to production via `prisma db push` (see
-- reconcile_schema_drift for the established precedent of this pattern in
-- this repo) — this file exists so CI's `prisma migrate deploy` step
-- creates the same table on its disposable test database. Every
-- column/type/default/index below was verified against the live production
-- table's actual information_schema/pg_catalog state before writing.

-- CreateEnum
CREATE TYPE "PhotographyStyle" AS ENUM ('PHOTOGRAPHIC', 'ILLUSTRATED', 'THREE_D_RENDER', 'FLAT_DESIGN', 'MIXED');

-- CreateEnum
CREATE TYPE "BackgroundTonePreference" AS ENUM ('LIGHT', 'DARK', 'BRAND_COLORED', 'NO_PREFERENCE');

-- CreateEnum
CREATE TYPE "LogoPosition" AS ENUM ('TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT', 'CENTER_BOTTOM');

-- CreateEnum
CREATE TYPE "AccentBarPosition" AS ENUM ('TOP', 'BOTTOM');

-- CreateTable
CREATE TABLE "BrandVisualIdentity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "primaryColors" JSONB,
    "secondaryColors" JSONB,
    "accentColors" JSONB,
    "photographyStyle" "PhotographyStyle",
    "styleRefinement" TEXT,
    "moodTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "compositionNotes" TEXT,
    "backgroundTone" "BackgroundTonePreference",
    "alwaysInclude" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alwaysAvoid" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referenceImageAssetId" TEXT,
    "templateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "logoPosition" "LogoPosition" NOT NULL DEFAULT 'BOTTOM_RIGHT',
    "logoSizePercent" INTEGER NOT NULL DEFAULT 16,
    "logoMarginPercent" INTEGER NOT NULL DEFAULT 4,
    "accentBarEnabled" BOOLEAN NOT NULL DEFAULT true,
    "accentBarColorHex" TEXT,
    "accentBarHeightPercent" INTEGER NOT NULL DEFAULT 5,
    "accentBarPosition" "AccentBarPosition" NOT NULL DEFAULT 'BOTTOM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandVisualIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandVisualIdentity_brandId_key" ON "BrandVisualIdentity"("brandId");

-- CreateIndex
CREATE INDEX "BrandVisualIdentity_workspaceId_idx" ON "BrandVisualIdentity"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandVisualIdentity_projectId_idx" ON "BrandVisualIdentity"("projectId");
