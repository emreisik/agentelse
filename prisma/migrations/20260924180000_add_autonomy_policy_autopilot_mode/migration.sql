-- CreateEnum
CREATE TYPE "AutopilotMode" AS ENUM ('REVIEW_EVERYTHING', 'CREATE_AUTOMATICALLY', 'AUTOPILOT');

-- AlterTable
ALTER TABLE "AutonomyPolicy" ADD COLUMN     "autopilotMode" "AutopilotMode" NOT NULL DEFAULT 'AUTOPILOT';
