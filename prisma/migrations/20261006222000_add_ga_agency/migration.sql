-- AlterTable
ALTER TABLE "GaPropertyLink" ADD COLUMN     "isSecondary" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "GoogleRiscEvent" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "eventKeys" TEXT[],
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "matched" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleRiscEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaBigQuerySource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "gcpProjectId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastDay" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "usageMonth" TEXT,
    "usageBytes" BIGINT NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaBigQuerySource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaBigQueryDay" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "events" INTEGER NOT NULL,
    "users" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL,
    "keyEvents" INTEGER NOT NULL,
    "revenueMicros" BIGINT NOT NULL DEFAULT 0,
    "topEvents" JSONB,
    "topPages" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GaBigQueryDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GaFunnel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isOpen" BOOLEAN NOT NULL DEFAULT false,
    "steps" JSONB NOT NULL,
    "periodDays" INTEGER NOT NULL DEFAULT 28,
    "lastResult" JSONB,
    "lastRunAt" TIMESTAMP(3),
    "runDay" TEXT,
    "runsToday" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GaFunnel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleRiscEvent_jti_key" ON "GoogleRiscEvent"("jti");

-- CreateIndex
CREATE INDEX "GoogleRiscEvent_receivedAt_idx" ON "GoogleRiscEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GaBigQuerySource_linkId_key" ON "GaBigQuerySource"("linkId");

-- CreateIndex
CREATE INDEX "GaBigQuerySource_status_nextRunAt_idx" ON "GaBigQuerySource"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "GaBigQuerySource_projectId_idx" ON "GaBigQuerySource"("projectId");

-- CreateIndex
CREATE INDEX "GaBigQueryDay_projectId_idx" ON "GaBigQueryDay"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GaBigQueryDay_linkId_date_key" ON "GaBigQueryDay"("linkId", "date");

-- CreateIndex
CREATE INDEX "GaFunnel_linkId_idx" ON "GaFunnel"("linkId");

-- CreateIndex
CREATE INDEX "GaFunnel_projectId_idx" ON "GaFunnel"("projectId");

-- CreateIndex
CREATE INDEX "GaPropertyLink_isSecondary_syncLeaseUntil_idx" ON "GaPropertyLink"("isSecondary", "syncLeaseUntil");

-- AddForeignKey
ALTER TABLE "GaBigQuerySource" ADD CONSTRAINT "GaBigQuerySource_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaBigQueryDay" ADD CONSTRAINT "GaBigQueryDay_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GaFunnel" ADD CONSTRAINT "GaFunnel_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GaPropertyLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

