import "server-only";

import { prisma } from "@/lib/prisma";

// Süreçler arası "en çok N dakikada bir" kilidi: SystemHeartbeat satırının
// lastBeatAt'i CAS ile ilerletilir. Deploy örtüşmesindeki iki kopya ya da
// GitHub cron tetiği aynı periyodik işi iki kez koşturmaz. Hata olursa
// false (iş bir sonraki tick'e kalır).
export async function claimPeriodic(
  key: string,
  everyMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await prisma.$executeRaw`INSERT INTO "SystemHeartbeat" ("key", "updatedAt") VALUES (${key}, ${now}) ON CONFLICT ("key") DO NOTHING`;
    const claimed = await prisma.$executeRaw`UPDATE "SystemHeartbeat" SET "lastBeatAt" = ${now}, "updatedAt" = ${now} WHERE "key" = ${key} AND ("lastBeatAt" IS NULL OR "lastBeatAt" <= ${new Date(now.getTime() - everyMs)})`;
    return claimed === 1;
  } catch (error) {
    console.error(
      `[periodic] ${key} could not be claimed:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
