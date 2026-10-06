import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gscGlobalWorkAllowedHere } from "@/lib/seo/flags";
import { SeoReportFlags } from "@/lib/seo/reports/flags";
import { SEO_GOAL_METRIC_KEYS } from "@/lib/seo/reports/types";
import { claimPeriodic } from "@/server/observability/periodic";

// SEO raporlarının saklaması (docs/search-reports.md "Saklama"): günde bir
// (claimPeriodic), yalnız canlıda; yerel geliştirme süreci canlı veritabanını
// paylaşırken hiç çalışmaz. Nabız satırları 90 gün, haftalık / aylık / yol
// haritası satırları 36 ay; "yalnız son 16 ayı sakla" (archive = false) seçen
// bağlarda 487 gün. Yetim hedef ilerlemesi silinir ve SEO hedeflerinin
// Google'dan gelen değeri, projenin o kipte hiç bağı kalmadıysa (W1 bağ
// silmeleri) boşaltılır. SEO_REPORTS kapalıyken yalnız rapor verisi
// kaldıysa iş yapılır; kalıp kalmadığına süreç başına günde en çok bir kez
// bakılır (her tick'te sorgu yok).

const RETENTION_KEY = "seo.reports-retention";
const EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

export const PULSE_RETENTION_DAYS = 90;
export const REPORT_RETENTION_DAYS = 1096;
export const ARCHIVE_OFF_RETENTION_DAYS = 487;

let idleCheckedAt: number | null = null;

// Bayrak kapalıyken rapor verisi kalmış mı (süreç içi günlük bellek).
async function leftoverData(now: Date): Promise<boolean> {
  if (idleCheckedAt !== null && now.getTime() - idleCheckedAt < EVERY_MS) {
    return false;
  }
  const report = await prisma.seoReport.findFirst({ select: { id: true } });
  const found =
    report !== null ||
    (await prisma.seoGoalProgress.findFirst({ select: { id: true } })) !==
      null;
  // Veri kalmış olsa da kontrol zamanı kaydedilir: günlük işi claimPeriodic
  // kapılar, her tick'te findFirst koşmaz.
  idleCheckedAt = now.getTime();
  return found;
}

function ago(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export const SeoReportRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!gscGlobalWorkAllowedHere()) return 0;
    if (!SeoReportFlags.on() && !(await leftoverData(now))) return 0;
    if (!(await claimPeriodic(RETENTION_KEY, EVERY_MS, now))) return 0;

    let total = 0;
    total += (
      await prisma.seoReport.deleteMany({
        where: {
          kind: "PULSE",
          createdAt: { lt: ago(now, PULSE_RETENTION_DAYS) },
        },
      })
    ).count;
    total += (
      await prisma.seoReport.deleteMany({
        where: {
          kind: { not: "PULSE" },
          createdAt: { lt: ago(now, REPORT_RETENTION_DAYS) },
        },
      })
    ).count;
    total += (
      await prisma.seoReport.deleteMany({
        where: {
          kind: { not: "PULSE" },
          createdAt: { lt: ago(now, ARCHIVE_OFF_RETENTION_DAYS) },
          link: { archive: false },
        },
      })
    ).count;

    // Etkin ya da onaylı hedefi kalmamış ilerleme satırları.
    total += await prisma.$executeRaw`
      DELETE FROM "SeoGoalProgress" p
       WHERE NOT EXISTS (
         SELECT 1 FROM "ProjectGoal" g
          WHERE g."id" = p."goalId"
            AND g."status" IN ('ACTIVE', 'APPROVED')
       )
    `;
    // Projenin o kipte hiç Search Console bağı kalmadıysa SEO hedeflerinin
    // eski Google değeri boşaltılır.
    total += await prisma.$executeRaw`
      UPDATE "ProjectGoal" g
         SET "currentValue" = NULL
       WHERE g."metricKey" IN (${Prisma.join([...SEO_GOAL_METRIC_KEYS])})
         AND g."currentValue" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "GscSiteLink" l
            WHERE l."projectId" = g."projectId"
              AND l."isMock" = g."isMock"
         )
    `;
    return total;
  },
};
