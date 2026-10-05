-- Faz 5 (docs/brand-brain-loop.md): a second, independent Autonomy switch.
-- Additive and off by default, so no existing project's behavior changes.

-- AlterTable
ALTER TABLE "AutonomyPolicy" ADD COLUMN     "weeklyAutoProduce" BOOLEAN NOT NULL DEFAULT false;
