-- DropIndex
DROP INDEX "Creative_projectId_gridGroupId_idx";

-- AlterTable
ALTER TABLE "Creative" DROP COLUMN "gridGroupId",
DROP COLUMN "gridPosition";
