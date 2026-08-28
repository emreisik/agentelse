-- CreateEnum
CREATE TYPE "ProductOfferStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOffer" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "status" "ProductOfferStatus" NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_workspaceId_idx" ON "Product"("workspaceId");

-- CreateIndex
CREATE INDEX "Product_projectId_idx" ON "Product"("projectId");

-- CreateIndex
CREATE INDEX "Product_brandId_idx" ON "Product"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_projectId_externalId_key" ON "Product"("projectId", "externalId");

-- CreateIndex
CREATE INDEX "ProductOffer_productId_idx" ON "ProductOffer"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOffer_productId_externalRef_key" ON "ProductOffer"("productId", "externalRef");

-- AddForeignKey
ALTER TABLE "ProductOffer" ADD CONSTRAINT "ProductOffer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
