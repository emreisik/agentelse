import "server-only";

import { prisma } from "@/lib/prisma";
import { gscToday } from "@/lib/seo/dates";
import { SeoFlags, cwvEnabled, seoMockMode } from "@/lib/seo/health-flags";

// /health operatör kartı (docs/search-health.md "Arayüz"): yalnız sayılar ve
// toplamlar; proje adı, adres ya da Google verisi yok. Her sayaç kendi
// hatasında 0 olur. SEO_HEALTH kapalıyken sorgu yok.

export type SeoOperatorCounters = {
  sitesTracked: number;
  inspectionsToday: number;
  inspectionSitesPaused: number;
  crawlsRunning: number;
  crawlsBlocked: number;
  crawlFailures24h: number;
  cwvKeyMissing: boolean;
  updatesLastSync: Date | null;
};

const DAY_MS = 24 * 3_600_000;

export async function loadSeoOperatorCounters(
  now: Date = new Date(),
): Promise<SeoOperatorCounters | null> {
  if (!SeoFlags.health()) return null;
  const isMock = seoMockMode();
  const [
    sitesTracked,
    inspectionsToday,
    inspectionSitesPaused,
    crawlsRunning,
    crawlsBlocked,
    crawlFailures24h,
    updatesLastSync,
  ] = await Promise.all([
    prisma.seoSite
      .count({ where: { isMock, scopeKey: { not: null } } })
      .catch(() => 0),
    prisma.seoSite
      .aggregate({
        where: { isMock, inspectDay: gscToday(now) },
        _sum: { inspectCount: true },
      })
      .then((result) => result._sum.inspectCount ?? 0)
      .catch(() => 0),
    prisma.seoSite
      .count({ where: { isMock, inspectPausedUntil: { gt: now } } })
      .catch(() => 0),
    prisma.seoCrawl
      .count({ where: { status: "RUNNING", site: { isMock } } })
      .catch(() => 0),
    prisma.seoSite
      .count({ where: { isMock, crawlBlocked: true } })
      .catch(() => 0),
    // Tarayıcı hatası SeoSite.lastCrawlError'a yazılır (bir sonraki başarılı
    // koşu temizler); yalnız bekçi kendi satırını FAILED kapatır. Site
    // başına bir kez sayılır.
    prisma.seoSite
      .count({
        where: {
          isMock,
          OR: [
            { lastCrawlError: { not: null } },
            {
              crawls: {
                some: {
                  status: "FAILED",
                  startedAt: { gte: new Date(now.getTime() - DAY_MS) },
                },
              },
            },
          ],
        },
      })
      .catch(() => 0),
    prisma.searchUpdate
      .findFirst({
        where: { source: "STATUS_DASHBOARD" },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      })
      .then((row) => row?.updatedAt ?? null)
      .catch(() => null),
  ]);
  return {
    sitesTracked,
    inspectionsToday,
    inspectionSitesPaused,
    crawlsRunning,
    crawlsBlocked,
    crawlFailures24h,
    cwvKeyMissing: SeoFlags.health() && !cwvEnabled(),
    updatesLastSync,
  };
}
