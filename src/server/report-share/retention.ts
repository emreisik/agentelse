import "server-only";

import { prisma } from "@/lib/prisma";
import { reportShareOn } from "@/lib/report-share/flags";
import { gscGlobalWorkAllowedHere } from "@/lib/seo/flags";
import { claimPeriodic } from "@/server/observability/periodic";

// Paylaşım bağlantılarının saklaması (SC-F9 ve GA-F8 ortak, KENDİ tick adımı:
// "report-share-retention"). SeoReportRetention örneğini izler: yalnız global
// iş yapılabilen süreçte (yerel geliştirme canlı DB'yi paylaşırken hiç
// çalışmaz); bayraklar kapalıyken de koşar ki bayrak kapatıldıktan sonra kalan
// satırlar silinsin, ama süreç başına günde en çok bir findFirst ile. Süresi
// 7 günden fazla geçmiş, iptali 7 günden eski ve raporu silinmiş SEARCH
// bağlantıları silinir.

const RETENTION_KEY = "report-share.retention";
const EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
export const SHARE_GRACE_DAYS = 7;

let idleCheckedAt: number | null = null;

// Bayraklar kapalıyken satır kalmış mı (süreç içi günlük bellek).
async function leftoverData(now: Date): Promise<boolean> {
  if (idleCheckedAt !== null && now.getTime() - idleCheckedAt < EVERY_MS) {
    return false;
  }
  const row = await prisma.reportShare.findFirst({ select: { id: true } });
  idleCheckedAt = now.getTime();
  return row !== null;
}

export const ReportShareRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!gscGlobalWorkAllowedHere()) return 0;
    if (!reportShareOn() && !(await leftoverData(now))) return 0;
    if (!(await claimPeriodic(RETENTION_KEY, EVERY_MS, now))) return 0;

    const cutoff = new Date(now.getTime() - SHARE_GRACE_DAYS * DAY_MS);
    let total = 0;
    total += (
      await prisma.reportShare.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      })
    ).count;
    total += (
      await prisma.reportShare.deleteMany({
        where: { revokedAt: { lt: cutoff } },
      })
    ).count;
    // Raporu silinmiş (bağ cascade'i, saklama) SEARCH bağlantıları.
    total += await prisma.$executeRaw`DELETE FROM "ReportShare" s WHERE s."kind" = 'SEARCH' AND NOT EXISTS (SELECT 1 FROM "SeoReport" r WHERE r."id" = s."reportId")`;
    return total;
  },
};
