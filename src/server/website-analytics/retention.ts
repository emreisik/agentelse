import "server-only";

import { prisma } from "@/lib/prisma";
import {
  GA_OPTIONAL_DAILY_REPORTS,
  GA_REPORTS,
  GA_TOTALS_SCHEDULE,
  ROLLING_USERS_KEY,
  ROLLING_USERS_RETENTION_DAYS,
} from "@/lib/website-analytics/catalog";
import { addDays, dayKeyToDate } from "@/lib/website-analytics/days";
import {
  GaFlags,
  gaGlobalWorkAllowedHere,
} from "@/lib/website-analytics/flags";
import {
  GA_WEEKLY_REPORTS,
  GA_WINDOW_REPORTS,
} from "@/lib/website-analytics/weekly";
import { GOOGLE_PROVIDER } from "@/server/integrations/google-client";
import { claimPeriodic } from "@/server/observability/periodic";

import { sweepOrphanGaInsightData } from "./analysis/cleanup";
import {
  deleteGaAttributionData,
  sweepOrphanGaAttributionData,
} from "./attribution/cleanup";
import {
  deleteGaReportData,
  sweepOrphanGaReportData,
} from "./reports/cleanup";
import { GaReportRetention } from "./reports/retention";

// Ambar saklama temizliği (docs/google-analytics-plan.md §4 "Saklama", §5
// `ga-retention`): günde bir, yalnız süresi dolmuş satırlar silinir.
// Birincilliğini kaybetmiş bağlar (seçim değişti) 30 gün sonra, bağlantısı
// kalmamış bağlar (kopmuş, silinmiş) hemen verisiyle birlikte silinir.
// Haftalık (WEEK) dilimler Pazar'ı saklama süresinden çıkınca silinir;
// GA_WEEKLY kapalıyken de (400 gün sözü bayraktan bağımsızdır).

const EVERY_MS = 24 * 3_600_000;
const MONTHLY_KEEP_DAYS = 3 * 366;
const STALE_LINK_DAYS = 30;

// WEEK dilimi, haftasının Pazar'ı saklama süresinin dışına düşünce silinir:
// periodStart < today-(retentionDays+6). today UTC günüdür (bir günlük kayma
// önemsiz).
export async function deleteExpiredWeekSlices(
  now: Date = new Date(),
): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  let deleted = 0;
  for (const spec of [...GA_WEEKLY_REPORTS, ...GA_WINDOW_REPORTS]) {
    const result = await prisma.gaReportSlice.deleteMany({
      where: {
        reportKey: spec.key,
        grain: "WEEK",
        periodStart: {
          lt: dayKeyToDate(addDays(today, -(spec.retentionDays + 6))),
        },
      },
    });
    deleted += result.count;
  }
  return deleted;
}

export const GaRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!GaFlags.sync() || !gaGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic("ga.retention", EVERY_MS, now))) return 0;
    const today = now.toISOString().slice(0, 10);
    const before = (days: number) => dayKeyToDate(addDays(today, -days));
    let deleted = 0;

    for (const spec of [...GA_REPORTS, ...GA_OPTIONAL_DAILY_REPORTS]) {
      const result = await prisma.gaReportSlice.deleteMany({
        where: {
          reportKey: spec.key,
          grain: "DAY",
          periodStart: { lt: before(spec.retentionDays) },
        },
      });
      deleted += result.count;
    }
    deleted += await deleteExpiredWeekSlices(now);
    deleted += (
      await prisma.gaReportSlice.deleteMany({
        where: {
          reportKey: ROLLING_USERS_KEY,
          periodStart: { lt: before(ROLLING_USERS_RETENTION_DAYS) },
        },
      })
    ).count;
    deleted += (
      await prisma.gaDailyTotal.deleteMany({
        where: { date: { lt: before(GA_TOTALS_SCHEDULE.retentionDays) } },
      })
    ).count;
    deleted += (
      await prisma.gaMonthlySummary.deleteMany({
        where: { month: { lt: before(MONTHLY_KEEP_DAYS) } },
      })
    ).count;

    deleted += (
      await prisma.gaPropertyLink.deleteMany({
        where: {
          isPrimary: false,
          updatedAt: {
            lt: new Date(now.getTime() - STALE_LINK_DAYS * 86_400_000),
          },
        },
      })
    ).count;

    // Bağlantısı kalmamış bağlar: Disconnect bunları zaten siler; arada
    // kalanlar (silinen bağlantı, eski satırlar) burada temizlenir.
    const links = await prisma.gaPropertyLink.findMany({
      select: { id: true, credentialId: true, projectId: true },
    });
    if (links.length > 0) {
      const live = new Set(
        (
          await prisma.integrationCredential.findMany({
            where: {
              id: { in: [...new Set(links.map((link) => link.credentialId))] },
              provider: GOOGLE_PROVIDER.analytics,
              status: { in: ["ACTIVE", "EXPIRED"] },
            },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      const orphaned = links
        .filter((link) => !live.has(link.credentialId))
        .map((link) => link.id);
      if (orphaned.length > 0) {
        // GA-F5: bağlantısı kalmamış projede rapor kartları ve hedeflerin GA değerleri de Disconnect'teki gibi silinir (bayraktan bağımsız).
        const liveProjects = new Set(
          links
            .filter((link) => live.has(link.credentialId))
            .map((link) => link.projectId),
        );
        const orphanProjects = new Set(
          links
            .filter((link) => !live.has(link.credentialId))
            .map((link) => link.projectId)
            .filter((projectId) => !liveProjects.has(projectId)),
        );
        for (const projectId of orphanProjects) {
          await deleteGaReportData(projectId).catch((error: unknown) => {
            console.error(
              "[ga-retention] website report leftovers could not be cleared:",
              error instanceof Error ? error.name : error,
            );
          });
        }
        // GA-F6: aynı projelerde "ga-utm:" öğrenmeleri ve karar kanıtındaki ga4_* sayıları da silinir (kendi parti döngüsü bütün kararları kapsar).
        for (const projectId of orphanProjects) {
          await deleteGaAttributionData(projectId).catch((error: unknown) => {
            console.error(
              "[ga-retention] attribution leftovers could not be cleared:",
              error instanceof Error ? error.name : error,
            );
          });
        }
        deleted += (
          await prisma.gaPropertyLink.deleteMany({
            where: { id: { in: orphaned } },
          })
        ).count;
      }
    }
    // GA-F4: Disconnect temizliği yarıda kaldıysa canlı GA bağlantısı
    // olmayan projelerin bulgu türevleri burada silinir.
    deleted += await sweepOrphanGaInsightData().catch((error: unknown) => {
      console.error(
        "[ga-retention] website insight leftovers could not be cleared:",
        error instanceof Error ? error.name : error,
      );
      return 0;
    });
    // GA-F5: Disconnect'ten sonra kalan rapor kartları / hedef değerleri.
    deleted += await sweepOrphanGaReportData().catch((error: unknown) => {
      console.error(
        "[ga-retention] website report leftovers could not be swept:",
        error instanceof Error ? error.name : error,
      );
      return 0;
    });
    // GA-F6: Disconnect'te atıf temizliği yarıda kaldıysa kalan "ga-utm:"
    // öğrenmeleri ve karar kanıtındaki ga4_* alanları.
    deleted += await sweepOrphanGaAttributionData().catch((error: unknown) => {
      console.error(
        "[ga-retention] attribution leftovers could not be swept:",
        error instanceof Error ? error.name : error,
      );
      return 0;
    });
    // GA-F5: rapor kartlarının 95/400 gün sözü GA_REPORTS bayrağına bağlı
    // değildir; bayrak kapalı kalsa da (geri alma) kartlar burada budanır.
    deleted += await GaReportRetention.runDue(now).catch(() => 0);
    return deleted;
  },
};
