-- AlterTable
ALTER TABLE "MeasurementPlan" ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "platform" "SocialPlatform",
ADD COLUMN     "platformPostId" TEXT,
ADD COLUMN     "postUrl" TEXT;
