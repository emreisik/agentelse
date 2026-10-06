import "server-only";

import type { Prisma, SeoSite } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gscPageKey, pathOf } from "@/lib/seo/crawl-url";
import { coverageDropped } from "@/lib/seo/coverage";
import { cwvWorsened, type CwvRating } from "@/lib/seo/cwv";
import {
  addDays,
  addWeeks,
  gscToday,
  lastCompleteWeekStart,
} from "@/lib/seo/dates";
import { SeoFlags, cwvEnabled, seoMockMode } from "@/lib/seo/health-flags";
import type { KeyPageCheck, SearchHealthInput } from "@/lib/seo/health/checks";
import type { DropDay } from "@/lib/seo/health/search-drop";
import { parseXRobotsTag } from "@/lib/seo/html-audit";
import { richResultErrorCount } from "@/lib/seo/inspection";
import type { TaCode } from "@/lib/seo/technical-audit";
import { readAuditSummary } from "@/server/seo/crawl/audit-summary";
import { brandSplitStatus } from "@/server/seo/brand-terms";
import { readCoverage } from "@/server/seo/health/coverage";
import { readLatestCwv } from "@/server/seo/health/cwv";
import {
  readGscSitemaps,
  readInspectionStats,
  readInspectionsFor,
} from "@/server/seo/health/google-reads";
import { SearchUpdates } from "@/server/seo/health/updates";
import { keyPagesFor } from "@/server/seo/site/key-pages";
import { SeoSites } from "@/server/seo/site/sites";
import { primaryGscLink, readGscDays, readTopPages } from "@/server/seo/store";

import { buildLostUrlReport } from "./lost-urls";

// Sağlık değerlendirmesinin girdisi (docs/search-health.md "Kontroller"):
// tek projenin site durumu, kilit sayfaları, tarama sorun sayıları, robots ve
// sitemap özetleri, GSC bağı, günlük tıklar, URL Inspection, kapsam, CrUX,
// Google güncellemeleri ve kaybolan URL raporu. Temel okumalar (proje, site,
// bağ) hata verirse snapshot da hata verir (koşucu projeyi atlar, uyarılar
// olduğu gibi kalır); diğer her parça ayrı sarılır: hata o girdiyi "eksik"
// yapar, eksik girdi hiçbir uyarıyı kapatmaz.

const DAYS_BACK = 70;
const UPDATES_DAYS = 120;
const ORPHAN_WEEKS = 4;
const ORPHAN_TOP = 200;
const ORPHAN_SCAN_LIMIT = 20_000;

export type HealthSnapshot = {
  projectId: string;
  workspaceId: string;
  projectStatus: string;
  siteId: string | null;
  hasScope: boolean;
  hasGscLink: boolean;
  input: SearchHealthInput;
};

type SiteRow = Pick<
  SeoSite,
  "id" | "projectId" | "origin" | "scope" | "gscSitemapsAt" | "cwvCheckedAt"
>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safe<T>(
  label: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[seo-health] ${label} could not be read:`, messageOf(error));
    return null;
  }
}

function jsonRecord(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberOf(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const RATING_RANK: Record<CwvRating, number> = {
  good: 0,
  "needs-improvement": 1,
  poor: 2,
};

function worstRating(
  ...ratings: (CwvRating | null | undefined)[]
): CwvRating | null {
  let worst: CwvRating | null = null;
  for (const rating of ratings) {
    if (!rating) continue;
    if (!worst || RATING_RANK[rating] > RATING_RANK[worst]) worst = rating;
  }
  return worst;
}

const META_NOINDEX = /(^|[\s,])(noindex|none)([\s,]|$)/i;

async function loadKeyPages(
  site: SiteRow,
  projectId: string,
  withInspections: boolean,
  now: Date,
): Promise<{ pages: KeyPageCheck[]; homepageAssets: string[] }> {
  const keys = await keyPagesFor(site, now);
  if (keys.length === 0) return { pages: [], homepageAssets: [] };
  const hashes = keys.map((key) => key.urlHash);
  const [rows, inspections] = await Promise.all([
    prisma.seoPage.findMany({
      where: { siteId: site.id, urlHash: { in: hashes } },
      select: {
        urlHash: true,
        status: true,
        fetchError: true,
        previous: true,
        noindex: true,
        robotsMeta: true,
        xRobotsTag: true,
        canonical: true,
        renderRisk: true,
        schemaErrors: true,
        lastCrawledAt: true,
        assets: true,
      },
    }),
    withInspections
      ? readInspectionsFor(projectId, hashes)
      : Promise.resolve(null),
  ]);
  const byHash = new Map(rows.map((row) => [row.urlHash, row]));
  let homepageAssets: string[] = [];
  const pages = keys.map((key): KeyPageCheck => {
    const row = byHash.get(key.urlHash);
    const inspection = inspections?.get(key.urlHash) ?? null;
    const header = row?.xRobotsTag
      ? parseXRobotsTag([row.xRobotsTag]).noindex
      : false;
    let meta = row?.robotsMeta ? META_NOINDEX.test(row.robotsMeta) : false;
    // noindex biliniyor ama kaynağı okunamıyorsa meta etiketi sayılır.
    if (row?.noindex && !header && !meta) meta = true;
    if (key.isHomepage && row) {
      const assets = jsonRecord(row.assets);
      homepageAssets = [
        ...stringArray(assets?.scripts),
        ...stringArray(assets?.styles),
      ];
    }
    const previous = jsonRecord(row?.previous ?? null);
    const previousFetchError = previous?.fetchError;
    return {
      url: key.url,
      path: key.path,
      isHomepage: key.isHomepage,
      status: row?.status ?? null,
      fetchError: row?.fetchError ?? null,
      previousFetchError:
        typeof previousFetchError === "string" ? previousFetchError : null,
      noindexMeta: meta,
      noindexHeader: header,
      canonical: row?.canonical ?? null,
      renderRisk: row?.renderRisk ?? false,
      schemaErrors: Array.isArray(row?.schemaErrors)
        ? row.schemaErrors.length
        : 0,
      checkedAt: row?.lastCrawledAt ?? null,
      inspection: inspection
        ? {
            verdict: inspection.verdict,
            previousVerdict: inspection.previousVerdict,
            googleCanonical: inspection.googleCanonical,
            userCanonical: inspection.userCanonical,
            lastCrawlTime: inspection.lastCrawlTime,
            richResultErrors: richResultErrorCount(inspection.richResults),
          }
        : null,
    };
  });
  return { pages, homepageAssets };
}

type CountRow = {
  redirectLinked: bigint | number | null;
  httpPages: bigint | number | null;
  sitemapCrawled: bigint | number | null;
  sitemapBad: bigint | number | null;
};

async function loadIssues(
  projectId: string,
  siteId: string,
): Promise<{
  issues: NonNullable<SearchHealthInput["issues"]>;
  cleanShare: number | null;
} | null> {
  const [summary, counted] = await Promise.all([
    readAuditSummary(projectId),
    prisma.$queryRaw<CountRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE p."inlinks" > 0
            AND p."issues" @> '[{"code":"TA11"}]'::jsonb
        ) AS "redirectLinked",
        COUNT(*) FILTER (
          WHERE p."status" = 200 AND p."url" LIKE 'http://%'
        ) AS "httpPages",
        COUNT(*) FILTER (
          WHERE p."inSitemap" AND p."lastCrawledAt" IS NOT NULL
        ) AS "sitemapCrawled",
        COUNT(*) FILTER (
          WHERE p."inSitemap" AND p."lastCrawledAt" IS NOT NULL
            AND p."indexable" = false
        ) AS "sitemapBad"
      FROM "SeoPage" p
      WHERE p."siteId" = ${siteId} AND p."goneAt" IS NULL
    `,
  ]);
  if (!summary) return null;
  const counts: Partial<Record<TaCode, number>> = {};
  const groups: readonly { code: TaCode; count: number }[] = summary.groups;
  for (const group of groups) {
    counts[group.code] = (counts[group.code] ?? 0) + group.count;
  }
  const row = counted[0];
  return {
    issues: {
      counts,
      redirectChainsLinked: Number(row?.redirectLinked ?? 0),
      httpPages: Number(row?.httpPages ?? 0),
      sitemapCrawled: Number(row?.sitemapCrawled ?? 0),
      sitemapBad: Number(row?.sitemapBad ?? 0),
    },
    cleanShare: summary.cleanShare,
  };
}

// Son 4 tam haftanın ilk 200 GSC sayfasından, taradığımız ve iç linki
// olmayan (ana sayfa dışı) sayfaların yolları.
async function loadOrphanPaths(
  linkId: string,
  finalThrough: string,
  siteId: string,
): Promise<string[]> {
  const lastWeek = lastCompleteWeekStart(finalThrough);
  const [top, pages] = await Promise.all([
    readTopPages(
      linkId,
      { from: addWeeks(lastWeek, -(ORPHAN_WEEKS - 1)), to: lastWeek },
      { limit: ORPHAN_TOP },
    ),
    prisma.seoPage.findMany({
      where: { siteId, goneAt: null, status: 200, indexable: true },
      select: { url: true, inlinks: true },
      take: ORPHAN_SCAN_LIMIT,
    }),
  ]);
  const inlinksByKey = new Map<string, number>();
  for (const page of pages) {
    const key = gscPageKey(page.url);
    if (!key) continue;
    inlinksByKey.set(key, Math.max(inlinksByKey.get(key) ?? 0, page.inlinks));
  }
  return top.flatMap((row) => {
    if (!row.url || row.url.includes("[")) return [];
    const path = pathOf(row.url);
    return path !== "/" && inlinksByKey.get(row.url) === 0 ? [path] : [];
  });
}

export async function loadHealthSnapshot(
  projectId: string,
  now: Date,
): Promise<HealthSnapshot | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true },
  });
  if (!project) return null;

  const [state, site, link] = await Promise.all([
    SeoSites.readState(projectId),
    prisma.seoSite.findUnique({
      where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
      select: {
        id: true,
        projectId: true,
        origin: true,
        scope: true,
        gscSitemapsAt: true,
        cwvCheckedAt: true,
      },
    }),
    primaryGscLink(projectId),
  ]);

  const scope = state?.scope ?? null;
  const crawlEnabled =
    SeoFlags.crawl() &&
    (state?.settings.crawlEnabled ?? false) &&
    scope !== null;
  const lastFull = state?.crawl.lastFull ?? null;
  const today = gscToday(now);
  const finalThrough = link?.lastFinalDate ?? null;
  const cwvOn = cwvEnabled() && scope !== null;

  const [
    keyPages,
    issues,
    days,
    updates,
    gscSitemaps,
    coverage,
    stats,
    cwv,
    lostUrls,
    orphanPaths,
  ] = await Promise.all([
    site && scope
      ? safe("key pages", () =>
          loadKeyPages(site, projectId, link !== null, now),
        )
      : Promise.resolve({ pages: [], homepageAssets: [] }),
    site && crawlEnabled
      ? safe("audit issues", () => loadIssues(projectId, site.id))
      : Promise.resolve(null),
    link && finalThrough
      ? safe("search days", async () => {
          const split = brandSplitStatus(link) === "ready";
          const rows = await readGscDays(
            link.id,
            addDays(today, -DAYS_BACK),
            finalThrough,
          );
          return rows
            .filter((row) => !row.fresh)
            .map((row): DropDay => ({
              day: row.day,
              clicks: row.clicks,
              nonBrandClicks:
                split && row.brandClicks !== null
                  ? Math.max(0, row.clicks - row.brandClicks)
                  : null,
            }));
        })
      : Promise.resolve(link ? [] : null),
    link
      ? safe("search updates", () => SearchUpdates.recent(now, UPDATES_DAYS))
      : Promise.resolve(null),
    link
      ? safe("gsc sitemaps", () => readGscSitemaps(projectId))
      : Promise.resolve(null),
    link && crawlEnabled
      ? safe("coverage", () => readCoverage(projectId))
      : Promise.resolve(null),
    link && crawlEnabled
      ? safe("inspection stats", () => readInspectionStats(projectId, now))
      : Promise.resolve(null),
    // Okuma hatası (null) ile "kayıt yok" ({ summary: null }) ayrı tutulur.
    cwvOn
      ? safe("cwv", async () => ({ summary: await readLatestCwv(projectId) }))
      : Promise.resolve(null),
    link && crawlEnabled
      ? safe("lost urls", () => buildLostUrlReport(projectId, now))
      : Promise.resolve(null),
    link && site && crawlEnabled && finalThrough && lastFull?.status === "DONE"
      ? safe("orphan pages", () =>
          loadOrphanPaths(link.id, finalThrough, site.id),
        )
      : Promise.resolve(null),
  ]);

  const stored = lastFull?.stats ?? null;
  const input: SearchHealthInput = {
    now,
    projectStatus: project.status,
    scope,
    crawlEnabled,
    crawlBlocked: state?.crawl.blocked ?? false,
    lastFullCrawlAt: state?.crawl.lastFullCrawlAt ?? null,
    lastRegressionAt: state?.crawl.lastRegressionAt ?? null,
    lastFull: lastFull
      ? {
          status: lastFull.status,
          pagesFetched: lastFull.pagesFetched,
          finishedAt: lastFull.finishedAt,
          newUrls: numberOf(stored, "newUrls"),
          knownNowRedirect: numberOf(stored, "knownNowRedirect"),
          knownRefetched: numberOf(stored, "knownRefetched"),
        }
      : null,
    keyPages: keyPages?.pages ?? null,
    robots: state
      ? {
          verdict: state.robots.verdict,
          failures: state.robots.failures,
          fetchedAt: state.robots.fetchedAt,
          body: state.robots.body,
        }
      : null,
    sitemaps: state
      ? {
          checkedAt: state.sitemapsCheckedAt,
          summaries: state.sitemaps.map((row) => ({
            url: row.url,
            status: row.status,
            kind: row.kind,
          })),
        }
      : null,
    homepageAssets: keyPages?.homepageAssets ?? [],
    httpRedirectsToHttps: state?.httpRedirectsToHttps ?? null,
    issues: issues?.issues ?? null,
    technicalCleanShare: issues?.cleanShare ?? null,
    cwv: !cwvOn
      ? {
          enabled: false,
          checkedAt: null,
          overall: null,
          worsened: false,
          hasOrigin: false,
        }
      : cwv === null
        ? null
        : {
            enabled: true,
            checkedAt: cwv.summary?.checkedAt ?? site?.cwvCheckedAt ?? null,
            overall: worstRating(
              cwv.summary?.phone?.overall,
              cwv.summary?.desktop?.overall,
            ),
            worsened:
              cwv.summary !== null &&
              (cwvWorsened(cwv.summary.history.phone) ||
                cwvWorsened(cwv.summary.history.desktop)),
            hasOrigin:
              cwv.summary !== null &&
              (cwv.summary.phone !== null || cwv.summary.desktop !== null),
          },
    gsc: link
      ? {
          link: {
            createdAt: link.createdAt,
            health: link.health,
            domainMatch: link.domainMatch,
            lastFinalDate: link.lastFinalDate,
            consecutiveFailures: link.consecutiveFailures,
            lastDailyAt: link.lastDailyAt,
          },
          today,
          days,
          updates: updates
            ? updates.map((row) => ({
                name: row.name,
                startedAt: row.startedAt,
                endedAt: row.endedAt,
              }))
            : null,
          coverage: coverage
            ? {
                current: coverage.current,
                earlier: coverage.fourWeeksAgo,
                dropped:
                  coverage.current !== null &&
                  coverage.fourWeeksAgo !== null &&
                  coverageDropped(coverage.fourWeeksAgo, coverage.current),
              }
            : null,
          newSitemapUrls: stats?.newSitemapUrls ?? null,
          sitemaps: gscSitemaps
            ? {
                checkedAt: site?.gscSitemapsAt ?? null,
                rows: gscSitemaps.map((row) => ({
                  path: row.path,
                  isPending: row.isPending,
                  lastSubmitted: row.lastSubmitted,
                  lastDownloaded: row.lastDownloaded,
                  errors: row.errors,
                })),
              }
            : null,
          lostUrls: lostUrls
            ? {
                rows: lostUrls.rows.map((row) => ({
                  fromPath: row.fromPath,
                  keyPage: row.keyPage,
                })),
                lostClicksShare: lostUrls.lostClicksShare,
              }
            : null,
          orphanPaths,
        }
      : null,
  };

  return {
    projectId,
    workspaceId: project.workspaceId,
    projectStatus: project.status,
    siteId: site?.id ?? state?.siteId ?? null,
    hasScope: scope !== null,
    hasGscLink: link !== null,
    input,
  };
}
