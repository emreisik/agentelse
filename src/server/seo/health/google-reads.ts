import "server-only";

import { gscToday } from "@/lib/seo/dates";
import { seoMockMode } from "@/lib/seo/health-flags";
import type { RichResultsSummary } from "@/lib/seo/inspection";
import { prisma } from "@/lib/prisma";
import { primaryGscLink } from "@/server/seo/store";
import { parseInspectQueue } from "@/server/seo/site/inspect-queue";

// Search health panelinin ve denetimlerin Google kökenli okumaları
// (URL Inspection sonuçları, bütçe kullanımı, GSC sitemap durumu). Google'a
// çağrı yapmaz; yalnız geçerli kipteki birincil bağın Gsc* satırları okunur.

const DAY_MS = 86_400_000;
const NEW_URL_FROM_MS = 45 * DAY_MS;
const NEW_URL_TO_MS = 14 * DAY_MS;

export type InspectionRow = {
  url: string;
  urlHash: string;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: Date | null;
  inspectedAt: Date;
  previousVerdict: string | null;
  verdictChangedAt: Date | null;
  richResults: RichResultsSummary | null;
  sampleWeek: string | null;
  reason: string;
};

export type GscSitemapRow = {
  path: string;
  type: string | null;
  isIndex: boolean;
  isPending: boolean;
  lastSubmitted: Date | null;
  lastDownloaded: Date | null;
  errors: number;
  warnings: number;
  submittedCount: number;
  checkedAt: Date;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Saklanan richResults Json'u (RichResultsSummary); tanınmayan biçim null.
function parseRichResults(value: unknown): RichResultsSummary | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.items)) return null;
  const items = raw.items.flatMap((entry) => {
    const item = record(entry);
    if (!item || typeof item.type !== "string") return [];
    const issues = (Array.isArray(item.issues) ? item.issues : []).flatMap(
      (value) => {
        const issue = record(value);
        if (!issue || typeof issue.message !== "string") return [];
        const severity: "ERROR" | "WARNING" =
          issue.severity === "ERROR" ? "ERROR" : "WARNING";
        return [{ severity, message: issue.message }];
      },
    );
    return [{ type: item.type, issues }];
  });
  return {
    verdict: typeof raw.verdict === "string" ? raw.verdict : null,
    items,
  };
}

function currentSite(projectId: string) {
  return prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
    select: {
      id: true,
      inspectDay: true,
      inspectCount: true,
      inspectBudget: true,
      inspectPausedUntil: true,
      inspectQueue: true,
    },
  });
}

export async function inspectionUsage(
  projectId: string,
  now: Date = new Date(),
): Promise<{
  used: number;
  budget: number;
  pausedUntil: Date | null;
  queued: number;
} | null> {
  const site = await currentSite(projectId);
  if (!site) return null;
  return {
    used: site.inspectDay === gscToday(now) ? site.inspectCount : 0,
    budget: site.inspectBudget,
    pausedUntil:
      site.inspectPausedUntil &&
      site.inspectPausedUntil.getTime() > now.getTime()
        ? site.inspectPausedUntil
        : null,
    queued: parseInspectQueue(site.inspectQueue).length,
  };
}

export async function readInspectionsFor(
  projectId: string,
  urlHashes: readonly string[],
): Promise<Map<string, InspectionRow>> {
  if (urlHashes.length === 0) return new Map();
  const link = await primaryGscLink(projectId);
  if (!link) return new Map();
  const rows = await prisma.gscUrlInspection.findMany({
    where: { linkId: link.id, urlHash: { in: [...new Set(urlHashes)] } },
  });
  return new Map(
    rows.map((row) => {
      const previous = record(row.previous);
      return [
        row.urlHash,
        {
          url: row.url,
          urlHash: row.urlHash,
          verdict: row.verdict,
          coverageState: row.coverageState,
          indexingState: row.indexingState,
          googleCanonical: row.googleCanonical,
          userCanonical: row.userCanonical,
          lastCrawlTime: row.lastCrawlTime,
          inspectedAt: row.inspectedAt,
          previousVerdict:
            typeof previous?.verdict === "string" ? previous.verdict : null,
          verdictChangedAt: row.verdictChangedAt,
          richResults: parseRichResults(row.richResults),
          sampleWeek: row.sampleWeek,
          reason: row.reason,
        },
      ];
    }),
  );
}

// Sitemap'e 14–45 gün önce giren (taban çizgisinden sonraki) ve incelenmiş
// URL'ler: kaçı hâlâ indekste değil (SH8).
export async function readInspectionStats(
  projectId: string,
  now: Date = new Date(),
): Promise<{
  newSitemapUrls: { inspected: number; notIndexed: number };
} | null> {
  const [link, site] = await Promise.all([
    primaryGscLink(projectId),
    currentSite(projectId),
  ]);
  if (!link || !site) return null;
  const pages = await prisma.seoPage.findMany({
    where: {
      siteId: site.id,
      sitemapFirstSeenAt: {
        not: null,
        gte: new Date(now.getTime() - NEW_URL_FROM_MS),
        lte: new Date(now.getTime() - NEW_URL_TO_MS),
      },
    },
    select: { urlHash: true },
  });
  if (pages.length === 0) {
    return { newSitemapUrls: { inspected: 0, notIndexed: 0 } };
  }
  const inspections = await prisma.gscUrlInspection.findMany({
    where: {
      linkId: link.id,
      urlHash: { in: pages.map((page) => page.urlHash) },
    },
    select: { verdict: true },
  });
  return {
    newSitemapUrls: {
      inspected: inspections.length,
      notIndexed: inspections.filter((row) => row.verdict !== "PASS").length,
    },
  };
}

export async function readGscSitemaps(
  projectId: string,
): Promise<GscSitemapRow[]> {
  const link = await primaryGscLink(projectId);
  if (!link) return [];
  const rows = await prisma.gscSitemap.findMany({
    where: { linkId: link.id },
    orderBy: { path: "asc" },
  });
  return rows.map((row) => ({
    path: row.path,
    type: row.type,
    isIndex: row.isIndex,
    isPending: row.isPending,
    lastSubmitted: row.lastSubmitted,
    lastDownloaded: row.lastDownloaded,
    errors: row.errors,
    warnings: row.warnings,
    submittedCount: row.submittedCount,
    checkedAt: row.checkedAt,
  }));
}
