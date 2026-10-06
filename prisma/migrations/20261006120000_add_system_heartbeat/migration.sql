-- CreateTable
CREATE TABLE "SystemHeartbeat" (
    "key" TEXT NOT NULL,
    "lastBeatAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "data" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemHeartbeat_pkey" PRIMARY KEY ("key")
);

