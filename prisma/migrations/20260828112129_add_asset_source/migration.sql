-- CreateEnum
CREATE TYPE "AssetSource" AS ENUM ('AI_GENERATED', 'CUSTOMER_UPLOAD');

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "source" "AssetSource" NOT NULL DEFAULT 'AI_GENERATED';
