-- Second reconciliation pass (see 20260821130000_fix_missing_columns): a
-- full `prisma migrate diff --from-migrations ... --to-schema-datasource`
-- (against a throwaway shadow DB) turned up more of the same drift —
-- schema.prisma/live DB changes that were pushed with `prisma db push`
-- and never got a matching migration file. Every statement here was
-- verified against the live DB's actual information_schema/pg_catalog
-- state before writing: BoardCard/BoardList don't exist there at all
-- (the board/kanban feature was already fully removed), and every other
-- column/enum/default already matches schema.prisma exactly.

-- CreateEnum
CREATE TYPE "CreativeContentFormat" AS ENUM ('FEED_SQUARE', 'FEED_PORTRAIT', 'FEED_LANDSCAPE', 'STORY', 'REEL', 'COVER', 'THUMBNAIL', 'LINK_PREVIEW', 'HEADER', 'PIN', 'SHORTS');

-- DropForeignKey
ALTER TABLE "BoardCard" DROP CONSTRAINT "BoardCard_listId_fkey";

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "height" INTEGER,
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "CreativeVersion" ADD COLUMN     "contentFormat" "CreativeContentFormat";

-- AlterTable
ALTER TABLE "IntegrationCredential" DROP COLUMN "secretReference",
ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "Project" ALTER COLUMN "country" SET DEFAULT 'US',
ALTER COLUMN "language" SET DEFAULT 'en';

-- DropTable
DROP TABLE "BoardCard";

-- DropTable
DROP TABLE "BoardList";

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_projectId_provider_key" ON "IntegrationCredential"("projectId", "provider");
