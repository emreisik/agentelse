import "server-only";

import { prisma } from "@/lib/prisma";
import {
  SeoFlags,
  seoGlobalWorkAllowedHere,
  seoMockMode,
} from "@/lib/seo/health-flags";
import { claimPeriodic } from "@/server/observability/periodic";
import { purgeResolvedSearchAlerts } from "@/server/seo/health/alerts";

// Site denetiminin saklama temizliği (docs/search-health.md "Tablolar"):
// `seo-health-retention` tick adımı, günde bir (claimPeriodic). Yalnız
// global iş yapılabilen süreçte (yerel geliştirme süreci canlı veritabanını
// paylaşırken hiç çalışmaz). Sırayla:
// 1) 90 günden eski taramalar, 2) 90 günden uzun süredir kaybolan sayfalar,
// 3) 730 günden eski CWV satırları, 4) canlı süreçte mock siteler,
// 5) projesi silinmiş siteler (hemen), 6) alan adı ve birincil GSC bağı
// kalmamış projelerin 30 gündür dokunulmayan siteleri, 7) hiç GSC bağı
// kalmamış projelerin GSC uyarıları (yetimler), 8) 180 günden eski çözülmüş
// GSC/SEO uyarıları.

const EVERY_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const CRAWL_KEEP_DAYS = 90;
const GONE_PAGE_KEEP_DAYS = 90;
const CWV_KEEP_DAYS = 730;
const ORPHAN_SITE_DAYS = 30;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function step(
  label: string,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (error) {
    console.error(`[seo-audit-retention] ${label} failed:`, messageOf(error));
    return 0;
  }
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export const SeoAuditRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!SeoFlags.health() || !seoGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic("seo.audit-retention", EVERY_MS, now))) return 0;

    let deleted = 0;
    deleted += await step("crawls", async () => {
      const result = await prisma.seoCrawl.deleteMany({
        where: { startedAt: { lt: daysAgo(now, CRAWL_KEEP_DAYS) } },
      });
      return result.count;
    });
    deleted += await step("gone pages", async () => {
      const result = await prisma.seoPage.deleteMany({
        where: { goneAt: { lt: daysAgo(now, GONE_PAGE_KEEP_DAYS) } },
      });
      return result.count;
    });
    deleted += await step("cwv", async () => {
      const result = await prisma.seoCwv.deleteMany({
        where: { periodEnd: { lt: daysAgo(now, CWV_KEEP_DAYS) } },
      });
      return result.count;
    });
    if (!seoMockMode()) {
      // Canlı süreçte yerel denemeden kalan mock siteler (cascade).
      deleted += await step("mock sites", async () => {
        const result = await prisma.seoSite.deleteMany({
          where: { isMock: true },
        });
        return result.count;
      });
    }
    deleted += await step(
      "deleted projects",
      () =>
        prisma.$executeRaw`
        DELETE FROM "SeoSite" s
         WHERE NOT EXISTS (
           SELECT 1 FROM "Project" p WHERE p."id" = s."projectId"
         )
      `,
    );
    deleted += await step(
      "ownerless sites",
      () =>
        prisma.$executeRaw`
        DELETE FROM "SeoSite" s
         USING "Project" p
         WHERE p."id" = s."projectId"
           AND (p."domain" IS NULL OR btrim(p."domain") = '')
           AND NOT EXISTS (
             SELECT 1 FROM "GscSiteLink" l
              WHERE l."projectId" = s."projectId" AND l."isPrimary" = true
           )
           AND s."updatedAt" < ${daysAgo(now, ORPHAN_SITE_DAYS)}
      `,
    );
    // Disconnect bunları zaten siler; arada kalan yetim GSC uyarıları.
    deleted += await step(
      "orphan gsc alerts",
      () =>
        prisma.$executeRaw`
        DELETE FROM "AdsAlert" a
         WHERE a."source" = 'GSC'
           AND NOT EXISTS (
             SELECT 1 FROM "GscSiteLink" l WHERE l."projectId" = a."projectId"
           )
      `,
    );
    deleted += await step("resolved alerts", () =>
      purgeResolvedSearchAlerts(now),
    );
    return deleted;
  },
};
