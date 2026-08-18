-- CreateTable
CREATE TABLE "BoardList" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardCard" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoardList_workspaceId_idx" ON "BoardList"("workspaceId");

-- CreateIndex
CREATE INDEX "BoardList_projectId_idx" ON "BoardList"("projectId");

-- CreateIndex
CREATE INDEX "BoardList_projectId_position_idx" ON "BoardList"("projectId", "position");

-- CreateIndex
CREATE INDEX "BoardCard_workspaceId_idx" ON "BoardCard"("workspaceId");

-- CreateIndex
CREATE INDEX "BoardCard_projectId_idx" ON "BoardCard"("projectId");

-- CreateIndex
CREATE INDEX "BoardCard_listId_position_idx" ON "BoardCard"("listId", "position");

-- AddForeignKey
ALTER TABLE "BoardCard" ADD CONSTRAINT "BoardCard_listId_fkey" FOREIGN KEY ("listId") REFERENCES "BoardList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

