-- Posts (docs/works.md "Posts"): one idea and one picture, delivered to
-- channels. Each channel's piece stays a Creative (its delivery) and points at
-- its Post. Additive only: every new column is nullable, so rows written before
-- this migration keep working and old code ignores the new columns.
--
-- Emergency rollback (run by hand, after reverting the code):
--   ALTER TABLE "Creative" DROP CONSTRAINT "Creative_postId_fkey";
--   DROP INDEX "Creative_postId_idx";
--   ALTER TABLE "Creative" DROP COLUMN "postId", DROP COLUMN "excludedAt";
--   DROP TABLE "Post";
--   ALTER TABLE "Work" DROP COLUMN "module";

-- AlterTable
ALTER TABLE "Work" ADD COLUMN     "module" TEXT;

-- AlterTable
ALTER TABLE "Creative" ADD COLUMN     "excludedAt" TIMESTAMP(3),
ADD COLUMN     "postId" TEXT;

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "workId" TEXT,
    "planId" TEXT,
    "ideaId" TEXT,
    "topic" TEXT NOT NULL,
    "idea" TEXT,
    "goal" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "timezone" TEXT,
    "pictureAssetId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Post_projectId_scheduledFor_idx" ON "Post"("projectId", "scheduledFor");

-- CreateIndex
CREATE INDEX "Post_planId_idx" ON "Post"("planId");

-- CreateIndex
CREATE INDEX "Post_workId_idx" ON "Post"("workId");

-- CreateIndex
CREATE INDEX "Creative_postId_idx" ON "Creative"("postId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

