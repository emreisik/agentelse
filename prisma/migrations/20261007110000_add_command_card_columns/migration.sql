-- Read-only STORED generated copies of the card fields of Command.parsedIntent.
-- The database fills them (also for every existing row), no writer sets them.
-- Adding a stored generated column rewrites the table once.
ALTER TABLE "Command"
  ADD COLUMN "cardKind" TEXT GENERATED ALWAYS AS (("parsedIntent" -> 'card') ->> 'kind') STORED,
  ADD COLUMN "cardTaskId" TEXT GENERATED ALWAYS AS (("parsedIntent" -> 'card') ->> 'taskId') STORED,
  ADD COLUMN "cardCreativeId" TEXT GENERATED ALWAYS AS (("parsedIntent" -> 'card') ->> 'creativeId') STORED;

-- CreateIndex
CREATE INDEX "Command_projectId_cardTaskId_idx" ON "Command"("projectId", "cardTaskId");

-- CreateIndex
CREATE INDEX "Command_projectId_cardCreativeId_idx" ON "Command"("projectId", "cardCreativeId");

-- CreateIndex
CREATE INDEX "Command_projectId_cardKind_createdAt_idx" ON "Command"("projectId", "cardKind", "createdAt");
