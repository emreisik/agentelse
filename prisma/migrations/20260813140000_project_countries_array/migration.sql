-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "countries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: existing rows keep their current single `country` as their only
-- market, so `countries` is never inconsistent with the legacy scalar column.
UPDATE "Project" SET "countries" = ARRAY["country"] WHERE cardinality("countries") = 0;
