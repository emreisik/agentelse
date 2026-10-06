import "server-only";

import { prisma } from "@/lib/prisma";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { reportCommandPrefix } from "@/lib/website-analytics/reports/ids";
import {
  WEBSITE_REPORT_VARIANTS,
  type WebsiteReportVariant,
} from "@/lib/website-analytics/reports/types";
import { claimPeriodic } from "@/server/observability/periodic";

// GA-F5 saklama (gizlilik metniyle hizalı): nabız ve uyarı kartları 95 gün,
// haftalık / aylık / plan kartları 400 gün (kartlar açılış sayfası, olay adı,
// maskeli kampanya satırı ve site içi arama terimi taşır; açıklanan saklama
// 400 gündür). Günde bir, yalnız canlıda; doğrudan id öneki + createdAt ile
// silinir (createdAt indeksli, Work taraması ve üst sınır yok). Bayraktan
// bağımsızdır: GA_REPORTS kapansa da kartlar saklama süresini aşamaz;
// GaRetention (günlük) ve GaReports.runDue aynı claim anahtarını paylaşır.

const RETENTION_KEY = "ga.reports.retention";
const EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

export const GA_REPORT_RETENTION_DAYS: Readonly<
  Record<WebsiteReportVariant, number>
> = {
  pulse: 95,
  alert: 95,
  weekly: 400,
  monthly: 400,
  plan: 400,
};

export const GaReportRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    // Saklama sözü bayraktan bağımsızdır (GA_REPORTS kapalıyken de budanır).
    if (!gaGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic(RETENTION_KEY, EVERY_MS, now))) return 0;
    let deleted = 0;
    for (const variant of WEBSITE_REPORT_VARIANTS) {
      const result = await prisma.command.deleteMany({
        where: {
          source: "SYSTEM",
          id: { startsWith: reportCommandPrefix(variant) },
          createdAt: {
            lt: new Date(
              now.getTime() - GA_REPORT_RETENTION_DAYS[variant] * DAY_MS,
            ),
          },
        },
      });
      deleted += result.count;
    }
    return deleted;
  },
};
