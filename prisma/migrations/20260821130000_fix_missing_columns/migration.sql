-- Backfills two columns that already exist on the shared dev/prod database
-- (added there via `prisma db push` at some point, never through a
-- committed migration) but were missing from migration history — meaning a
-- fresh database (CI, a new environment) never got them via
-- `prisma migrate deploy`. Matches the live schema exactly: same
-- nullability/no default as introspected from production.

-- AlterTable
ALTER TABLE "Command" ADD COLUMN     "ideaId" TEXT;

-- AlterTable
ALTER TABLE "IntegrationCredential" ADD COLUMN     "encryptedSecret" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Command_ideaId_idx" ON "Command"("ideaId");

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE SET NULL ON UPDATE CASCADE;
