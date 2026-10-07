-- CreateTable
CREATE TABLE "SeoContentPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cap" INTEGER NOT NULL,
    "existingAtPlan" INTEGER NOT NULL DEFAULT 0,
    "basedOnWeek" TEXT NOT NULL,
    "wording" TEXT NOT NULL DEFAULT 'BASIC',
    "regenerations" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeoContentSetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "monthlyCap" INTEGER NOT NULL DEFAULT 4,
    "autoPlan" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoContentSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeoContentPlan_projectId_month_idx" ON "SeoContentPlan"("projectId", "month");

-- CreateIndex
CREATE INDEX "SeoContentPlan_isMock_month_idx" ON "SeoContentPlan"("isMock", "month");

-- CreateIndex
CREATE UNIQUE INDEX "SeoContentPlan_linkId_month_key" ON "SeoContentPlan"("linkId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "SeoContentSetting_projectId_key" ON "SeoContentSetting"("projectId");

-- AddForeignKey
ALTER TABLE "SeoContentPlan" ADD CONSTRAINT "SeoContentPlan_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GscSiteLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

