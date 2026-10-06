import "server-only";

import { prisma } from "@/lib/prisma";
import {
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
import { GOOGLE_PROVIDER } from "@/server/integrations/google-client";
import { claimPeriodic } from "@/server/observability/periodic";

// Ambar saklama temizliği (docs/google-analytics-plan.md §4 "Saklama", §5
// `ga-retention`): günde bir, yalnız süresi dolmuş satırlar silinir.
// Birincilliğini kaybetmiş bağlar (seçim değişti) 30 gün sonra, bağlantısı
// kalmamış bağlar (kopmuş, silinmiş) hemen verisiyle birlikte silinir.

const EVERY_MS = 24 * 3_600_000;
const MONTHLY_KEEP_DAYS = 3 * 366;
const STALE_LINK_DAYS = 30;

export const GaRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!GaFlags.sync() || !gaGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic("ga.retention", EVERY_MS, now))) return 0;
    const today = now.toISOString().slice(0, 10);
    const before = (days: number) => dayKeyToDate(addDays(today, -days));
    let deleted = 0;

    for (const spec of GA_REPORTS) {
      const result = await prisma.gaReportSlice.deleteMany({
        where: {
          reportKey: spec.key,
          grain: "DAY",
          periodStart: { lt: before(spec.retentionDays) },
        },
      });
      deleted += result.count;
    }
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
      select: { id: true, credentialId: true },
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
        deleted += (
          await prisma.gaPropertyLink.deleteMany({
            where: { id: { in: orphaned } },
          })
        ).count;
      }
    }
    return deleted;
  },
};
