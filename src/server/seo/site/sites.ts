import "server-only";

import { Prisma, type SeoSite } from "@prisma/client";

import { normalizeDomain } from "@/lib/domain";
import {
  CRAWL_PAGE_LIMITS,
  RECRAWL_MIN_GAP_MS,
  VERIFY_RECHECK_MS,
} from "@/lib/seo/audit-constants";
import type { CrawlScope } from "@/lib/seo/crawl-url";
import {
  seoGlobalWorkAllowedHere,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "@/lib/seo/health-flags";
import type { ParsedSitemap } from "@/lib/seo/sitemap-parser";
import { prisma } from "@/lib/prisma";
import { claimPeriodic } from "@/server/observability/periodic";

import { parseStoredScope, resolveSiteScope } from "./scope";
import { checkSiteVerification } from "./verify";

// SeoSite yaşam döngüsü (docs/search-health.md "Kapsam ve doğrulama"). Satır
// projeyi izler: alan adı kalkınca, proje PAUSED/CLOSED olunca, GSC bağı
// doğrulamasız gidince ya da kapsam anahtarı değişince tarama verisi hemen
// silinir ve zamanlar null'a (boşta) iner; silinen projenin satırı silinir.
// Yalnız geçerli kipin (mock/canlı) satırlarına dokunur; tek istisna
// forgetSearchConsoleData (Google verisi iki kipte de silinir).

export type SeoSiteSettings = {
  v: 1;
  crawlEnabled: boolean;
  pageLimit: 100 | 250 | 500;
};

const DEFAULT_SETTINGS: SeoSiteSettings = {
  v: 1,
  crawlEnabled: true,
  pageLimit: 500,
};

export function parseSeoSiteSettings(value: unknown): SeoSiteSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  const limit = record.pageLimit;
  const pageLimit = (CRAWL_PAGE_LIMITS as readonly unknown[]).includes(limit)
    ? (limit as SeoSiteSettings["pageLimit"])
    : DEFAULT_SETTINGS.pageLimit;
  return {
    v: 1,
    crawlEnabled:
      typeof record.crawlEnabled === "boolean"
        ? record.crawlEnabled
        : DEFAULT_SETTINGS.crawlEnabled,
    pageLimit,
  };
}

export type SitemapSummary = {
  url: string;
  source: "ROBOTS" | "GSC" | "DEFAULT" | "INDEX";
  status: number | null;
  kind: ParsedSitemap["kind"] | "unreachable" | "blocked";
  urlCount: number;
  inScope: number;
  errors: string[];
  fetchedAt: string;
};

const SITEMAP_SOURCES = new Set(["ROBOTS", "GSC", "DEFAULT", "INDEX"]);
const SITEMAP_KINDS = new Set([
  "urlset",
  "sitemapindex",
  "text",
  "invalid",
  "unreachable",
  "blocked",
]);

export function parseSitemapSummaries(value: unknown): SitemapSummary[] {
  if (!Array.isArray(value)) return [];
  const rows: SitemapSummary[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.url !== "string" ||
      typeof record.source !== "string" ||
      !SITEMAP_SOURCES.has(record.source) ||
      typeof record.kind !== "string" ||
      !SITEMAP_KINDS.has(record.kind)
    ) {
      continue;
    }
    rows.push({
      url: record.url,
      source: record.source as SitemapSummary["source"],
      status: typeof record.status === "number" ? record.status : null,
      kind: record.kind as SitemapSummary["kind"],
      urlCount: typeof record.urlCount === "number" ? record.urlCount : 0,
      inScope: typeof record.inScope === "number" ? record.inScope : 0,
      errors: Array.isArray(record.errors)
        ? record.errors.filter(
            (error): error is string => typeof error === "string",
          )
        : [],
      fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : "",
    });
  }
  return rows;
}

export type SeoSiteState = {
  siteId: string;
  projectId: string;
  isMock: boolean;
  scope: CrawlScope | null;
  scopeVia: "GSC" | "VERIFIED" | null;
  origin: string | null;
  domain: string | null;
  verification: {
    token: string | null;
    verifiedDomain: string | null;
    method: string | null;
    verifiedAt: Date | null;
  };
  settings: SeoSiteSettings;
  robots: {
    verdict: string | null;
    status: number | null;
    failures: number;
    fetchedAt: Date | null;
    changedAt: Date | null;
    body: string | null;
    prevBody: string | null;
  };
  httpRedirectsToHttps: boolean | null;
  sitemaps: SitemapSummary[];
  sitemapsCheckedAt: Date | null;
  sitemapBaselineAt: Date | null;
  crawl: {
    blocked: boolean;
    pausedUntil: Date | null;
    lastFullCrawlAt: Date | null;
    fullCrawlDueAt: Date | null;
    lastRegressionAt: Date | null;
    running: boolean;
    lastError: string | null;
    lastFull: {
      status: string;
      pagesFetched: number;
      finishedAt: Date | null;
      stats: Record<string, unknown> | null;
    } | null;
  };
};

const SITES_EVERY_MS = 10 * 60_000;
const DEV_SITES_EVERY_MS = 2 * 60_000;
const VERIFY_RETRY_MS = 86_400_000;
const VERIFY_PER_RECONCILE = 10;
const INACTIVE_STATUSES = new Set(["PAUSED", "CLOSED"]);

// Geliştirme süreci (canlı veritabanı paylaşılırken) claimPeriodic anahtarı
// almaz; izinli projeleri süreç içi kısmayla kendisi uzlaştırır.
let lastDevReconcileAt = 0;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function report(scope: string, error: unknown) {
  console.error(
    `[seo-sites] ${scope}:`,
    error instanceof Error ? error.message : error,
  );
}

// Sıfırlamanın temizlediği alanlar: robots/sitemap/tarama/inceleme durumu ve
// puan. Doğrulama ve ayarlar burada yoktur (çağıran karar verir).
function resetFields(now: Date): Prisma.SeoSiteUpdateInput {
  return {
    origin: null,
    robotsStatus: null,
    robotsVerdict: null,
    robotsHash: null,
    robotsBody: null,
    robotsPrevBody: null,
    robotsFetchedAt: null,
    robotsChangedAt: null,
    robotsFailures: 0,
    robotsRetryAt: null,
    httpRedirectsToHttps: null,
    httpCheckedAt: null,
    sitemaps: Prisma.DbNull,
    sitemapsCheckedAt: null,
    sitemapBaselineAt: null,
    gscSitemapsAt: null,
    gscSitemapsNextAt: null,
    crawlLeaseUntil: null,
    crawlLeaseOwner: null,
    crawlNextAt: null,
    crawlPausedUntil: null,
    crawlThrottles: 0,
    crawlBlocked: false,
    fullCrawlDueAt: null,
    lastFullCrawlAt: null,
    regressionDueAt: null,
    lastRegressionAt: null,
    lastCrawlError: null,
    inspectNextAt: null,
    inspectQueue: Prisma.DbNull,
    inspectDay: null,
    inspectCount: 0,
    cwvCheckedAt: null,
    healthScore: null,
    healthParts: Prisma.DbNull,
    healthComputedAt: null,
    healthDueAt: now,
  };
}

const CLEARED_VERIFICATION: Prisma.SeoSiteUpdateInput = {
  verifiedDomain: null,
  verifyMethod: null,
  verifiedAt: null,
  verifyCheckedAt: null,
  verifyFailures: 0,
};

// Tek işlemde: alt satırlar silinir, durum temizlenir, `extra` yazılır.
// Doğrulama yalnız alan adı hâlâ aynıysa (keepVerification) kalır. Kilit
// alanları da temizlendiği için koşan tarayıcının bırakışı satırı ezemez.
async function resetSite(
  siteId: string,
  now: Date,
  options: { keepVerification: boolean; extra?: Prisma.SeoSiteUpdateInput },
): Promise<{ site: SeoSite; deleted: number }> {
  const where = { siteId };
  const [links, pages, crawls, cwv, site] = await prisma.$transaction([
    prisma.seoLink.deleteMany({ where }),
    prisma.seoPage.deleteMany({ where }),
    prisma.seoCrawl.deleteMany({ where }),
    prisma.seoCwv.deleteMany({ where }),
    prisma.seoSite.update({
      where: { id: siteId },
      data: {
        ...resetFields(now),
        ...(options.keepVerification ? {} : CLEARED_VERIFICATION),
        ...options.extra,
      },
    }),
  ]);
  return {
    site,
    deleted: links.count + pages.count + crawls.count + cwv.count,
  };
}

// Yeni ya da değişen kapsamın zamanları: tarama ve bekçi hemen; inceleme ve
// GSC sitemap okuması yalnız birincil bağ varken.
function armedSchedule(
  now: Date,
  crawlEnabled: boolean,
  hasLink: boolean,
): Prisma.SeoSiteUpdateInput {
  return {
    crawlNextAt: crawlEnabled ? now : null,
    fullCrawlDueAt: now,
    regressionDueAt: now,
    inspectNextAt: hasLink ? now : null,
    gscSitemapsNextAt: hasLink ? now : null,
    healthDueAt: now,
  };
}

function scopeJson(scope: CrawlScope): Prisma.InputJsonValue {
  return {
    kind: scope.kind,
    root: scope.root,
    prefix: scope.prefix,
    key: scope.key,
  };
}

function verificationMatches(site: SeoSite, domain: string | null): boolean {
  return (
    site.verifiedDomain !== null &&
    domain !== null &&
    site.verifiedDomain === normalizeDomain(domain)
  );
}

// Yeni satır (projectId, isMock) üzerinde upsert; yarışta P2002 yeniden okur.
async function createSite(
  projectId: string,
  workspaceId: string,
  isMock: boolean,
  data: Omit<
    Prisma.SeoSiteUncheckedCreateInput,
    "projectId" | "workspaceId" | "isMock"
  >,
): Promise<SeoSite | null> {
  try {
    return await prisma.seoSite.upsert({
      where: { projectId_isMock: { projectId, isMock } },
      create: { projectId, workspaceId, isMock, ...data },
      update: {},
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return prisma.seoSite.findUnique({
      where: { projectId_isMock: { projectId, isMock } },
    });
  }
}

function hasCrawlState(site: SeoSite): boolean {
  return (
    site.scopeKey !== null ||
    site.origin !== null ||
    site.crawlNextAt !== null ||
    site.inspectNextAt !== null ||
    site.gscSitemapsNextAt !== null ||
    site.robotsFetchedAt !== null ||
    site.sitemapsCheckedAt !== null
  );
}

async function ensureForProject(
  projectId: string,
  now: Date = new Date(),
  options: { reset?: boolean } = {},
): Promise<SeoSite | null> {
  if (!seoWorkAllowedFor(projectId)) return null;
  const reset = options.reset ?? true;
  const isMock = seoMockMode();
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true, status: true, domain: true },
  });
  if (!project) {
    await prisma.seoSite.deleteMany({ where: { projectId, isMock } });
    return null;
  }
  const existing = await prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock } },
  });
  const domain = project.domain?.trim() ? project.domain.trim() : null;
  const inactive = INACTIVE_STATUSES.has(project.status);
  const resolution = inactive
    ? null
    : await resolveSiteScope({
        projectId,
        domain,
        verifiedDomain: existing?.verifiedDomain ?? null,
      });

  if (!resolution) {
    if (!existing) {
      // Doğrulama kartı için satır yalnız alan adı varken açılır.
      if (!domain) return null;
      return createSite(projectId, project.workspaceId, isMock, {
        settings: { ...DEFAULT_SETTINGS },
      });
    }
    if (!reset) return existing;
    const verificationKept = verificationMatches(existing, domain);
    if (
      !hasCrawlState(existing) &&
      (verificationKept || !existing.verifiedDomain)
    ) {
      return existing;
    }
    const { site } = await resetSite(existing.id, now, {
      keepVerification: verificationKept,
      extra: { scope: Prisma.DbNull, scopeKey: null },
    });
    return site;
  }

  const hasLink = resolution.linkId !== null;
  if (!existing) {
    const settings = { ...DEFAULT_SETTINGS };
    return createSite(projectId, project.workspaceId, isMock, {
      settings,
      scope: scopeJson(resolution.scope),
      scopeKey: resolution.scope.key,
      crawlNextAt: now,
      fullCrawlDueAt: now,
      regressionDueAt: now,
      inspectNextAt: hasLink ? now : null,
      gscSitemapsNextAt: hasLink ? now : null,
      healthDueAt: now,
    });
  }
  if (!reset) return existing;

  const settings = parseSeoSiteSettings(existing.settings);
  if (existing.scopeKey !== resolution.scope.key) {
    const { site } = await resetSite(existing.id, now, {
      keepVerification: verificationMatches(existing, domain),
      extra: {
        scope: scopeJson(resolution.scope),
        scopeKey: resolution.scope.key,
        ...armedSchedule(now, settings.crawlEnabled, hasLink),
      },
    });
    return site;
  }

  // Aynı kapsam: boşta kalmış zamanları yeniden kurar.
  const data: Prisma.SeoSiteUpdateInput = {};
  if (existing.crawlNextAt === null && settings.crawlEnabled) {
    data.crawlNextAt = now;
  }
  if (hasLink) {
    if (existing.inspectNextAt === null) data.inspectNextAt = now;
    if (existing.gscSitemapsNextAt === null) data.gscSitemapsNextAt = now;
  } else {
    if (existing.inspectNextAt !== null) data.inspectNextAt = null;
    if (existing.gscSitemapsNextAt !== null) data.gscSitemapsNextAt = null;
  }
  if (Object.keys(data).length === 0) return existing;
  data.healthDueAt = now;
  return prisma.seoSite.update({ where: { id: existing.id }, data });
}

async function forProject(projectId: string): Promise<SeoSite | null> {
  return prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
  });
}

function statsRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function readState(projectId: string): Promise<SeoSiteState | null> {
  const site = await forProject(projectId);
  if (!site) return null;
  const [project, running, lastFull] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    }),
    prisma.seoCrawl.findFirst({
      where: { siteId: site.id, kind: "FULL", status: "RUNNING" },
      select: { id: true },
    }),
    prisma.seoCrawl.findFirst({
      where: { siteId: site.id, kind: "FULL", status: { not: "RUNNING" } },
      orderBy: { startedAt: "desc" },
      select: {
        status: true,
        pagesFetched: true,
        finishedAt: true,
        stats: true,
      },
    }),
  ]);
  const scope = parseStoredScope(site.scope);
  const domain = project?.domain?.trim()
    ? normalizeDomain(project.domain)
    : null;
  return {
    siteId: site.id,
    projectId: site.projectId,
    isMock: site.isMock,
    scope,
    scopeVia: scope
      ? scope.kind === "VERIFIED_DOMAIN"
        ? "VERIFIED"
        : "GSC"
      : null,
    origin: site.origin,
    domain,
    verification: {
      token: site.verifyToken,
      verifiedDomain: site.verifiedDomain,
      method: site.verifyMethod,
      verifiedAt: site.verifiedAt,
    },
    settings: parseSeoSiteSettings(site.settings),
    robots: {
      verdict: site.robotsVerdict,
      status: site.robotsStatus,
      failures: site.robotsFailures,
      fetchedAt: site.robotsFetchedAt,
      changedAt: site.robotsChangedAt,
      body: site.robotsBody,
      prevBody: site.robotsPrevBody,
    },
    httpRedirectsToHttps: site.httpRedirectsToHttps,
    sitemaps: parseSitemapSummaries(site.sitemaps),
    sitemapsCheckedAt: site.sitemapsCheckedAt,
    sitemapBaselineAt: site.sitemapBaselineAt,
    crawl: {
      blocked: site.crawlBlocked,
      pausedUntil: site.crawlPausedUntil,
      lastFullCrawlAt: site.lastFullCrawlAt,
      fullCrawlDueAt: site.fullCrawlDueAt,
      lastRegressionAt: site.lastRegressionAt,
      running: running !== null,
      lastError: site.lastCrawlError,
      lastFull: lastFull
        ? {
            status: lastFull.status,
            pagesFetched: lastFull.pagesFetched,
            finishedAt: lastFull.finishedAt,
            stats: statsRecord(lastFull.stats),
          }
        : null,
    },
  };
}

// Uzlaştırma adayları: alan adı olan projeler, geçerli kipte birincil GSC
// bağı olanlar ve geçerli kipte SeoSite satırı olanlar (izin listesi WHERE'de).
async function reconcileCandidates(
  restricted: string[] | null,
  isMock: boolean,
): Promise<{ projectIds: string[]; missing: string[] }> {
  const inList = restricted ? { in: restricted } : undefined;
  const [withDomain, withLink, withSite] = await Promise.all([
    prisma.project.findMany({
      where: {
        ...(inList ? { id: inList } : {}),
        domain: { not: null },
        NOT: { domain: "" },
      },
      select: { id: true },
    }),
    prisma.gscSiteLink.findMany({
      where: {
        isPrimary: true,
        isMock,
        ...(inList ? { projectId: inList } : {}),
      },
      select: { projectId: true },
    }),
    prisma.seoSite.findMany({
      where: { isMock, ...(inList ? { projectId: inList } : {}) },
      select: { projectId: true },
    }),
  ]);
  const siteProjects = [...new Set(withSite.map((row) => row.projectId))];
  const live = siteProjects.length
    ? await prisma.project.findMany({
        where: { id: { in: siteProjects } },
        select: { id: true },
      })
    : [];
  const liveIds = new Set(live.map((row) => row.id));
  const missing = siteProjects.filter((id) => !liveIds.has(id));
  const projectIds = [
    ...new Set([
      ...withDomain.map((row) => row.id),
      ...withLink.map((row) => row.projectId),
      ...siteProjects.filter((id) => liveIds.has(id)),
    ]),
  ];
  return { projectIds, missing };
}

// Doğrulanmış sitelerin 30 günde bir yeniden doğrulaması. Başarısız bir
// denetim bir gün sonra tekrarlanır; art arda iki başarısızlıkta doğrulama
// düşer ve kapsam yeniden hesaplanır.
async function recheckVerifications(
  restricted: string[] | null,
  isMock: boolean,
  now: Date,
): Promise<void> {
  const sites = await prisma.seoSite.findMany({
    where: {
      isMock,
      verifiedAt: { not: null },
      ...(restricted ? { projectId: { in: restricted } } : {}),
      OR: [
        { verifyCheckedAt: null },
        {
          verifyCheckedAt: { lt: new Date(now.getTime() - VERIFY_RECHECK_MS) },
        },
        {
          verifyFailures: { gt: 0 },
          verifyCheckedAt: { lt: new Date(now.getTime() - VERIFY_RETRY_MS) },
        },
      ],
    },
    orderBy: { verifyCheckedAt: { sort: "asc", nulls: "first" } },
    take: VERIFY_PER_RECONCILE,
    select: { id: true, projectId: true },
  });
  for (const site of sites) {
    try {
      const result = await checkSiteVerification(
        site.projectId,
        undefined,
        now,
      );
      if (result.ok) continue;
      const fresh = await prisma.seoSite.findUnique({
        where: { id: site.id },
        select: { verifyFailures: true },
      });
      if (!fresh || fresh.verifyFailures < 2) continue;
      await prisma.seoSite.update({
        where: { id: site.id },
        data: { verifiedAt: null, verifiedDomain: null, verifyMethod: null },
      });
      await ensureForProject(site.projectId, now);
    } catch (error) {
      report("verification could not be rechecked", error);
    }
  }
}

async function reconcileDue(now: Date = new Date()): Promise<number> {
  if (seoGlobalWorkAllowedHere()) {
    if (!(await claimPeriodic("seo.sites", SITES_EVERY_MS, now))) return 0;
  } else {
    if (Date.now() - lastDevReconcileAt < DEV_SITES_EVERY_MS) return 0;
    lastDevReconcileAt = Date.now();
  }
  const restricted = seoRestrictedProjects();
  if (restricted && restricted.length === 0) return 0;
  const isMock = seoMockMode();
  const { projectIds, missing } = await reconcileCandidates(restricted, isMock);
  if (missing.length > 0) {
    await prisma.seoSite.deleteMany({
      where: { projectId: { in: missing }, isMock },
    });
  }
  let touched = missing.length;
  for (const projectId of projectIds) {
    try {
      await ensureForProject(projectId, now);
      touched += 1;
    } catch (error) {
      report(`project ${projectId} could not be reconciled`, error);
    }
  }
  await recheckVerifications(restricted, isMock, now).catch((error: unknown) =>
    report("verification recheck failed", error),
  );
  return touched;
}

async function setCrawlSettings(
  projectId: string,
  settings: { crawlEnabled: boolean; pageLimit: 100 | 250 | 500 },
): Promise<void> {
  if (!seoWorkAllowedFor(projectId)) return;
  const now = new Date();
  const site =
    (await forProject(projectId)) ??
    (await ensureForProject(projectId, now, { reset: false }));
  if (!site) return;
  const next: SeoSiteSettings = {
    v: 1,
    crawlEnabled: settings.crawlEnabled,
    pageLimit: parseSeoSiteSettings({ pageLimit: settings.pageLimit })
      .pageLimit,
  };
  const data: Prisma.SeoSiteUpdateInput = { settings: next };
  if (next.crawlEnabled) {
    if (site.scopeKey !== null && site.crawlNextAt === null) {
      data.crawlNextAt = now;
    }
  } else {
    data.crawlNextAt = null;
    data.healthDueAt = now;
  }
  await prisma.seoSite.update({ where: { id: site.id }, data });
}

async function requestRecrawl(
  projectId: string,
  now: Date = new Date(),
): Promise<"queued" | "too_soon" | "unavailable"> {
  const site = await forProject(projectId);
  if (!site || site.scopeKey === null) return "unavailable";
  if (!parseSeoSiteSettings(site.settings).crawlEnabled) return "unavailable";
  if (
    !site.crawlBlocked &&
    site.lastFullCrawlAt &&
    now.getTime() - site.lastFullCrawlAt.getTime() < RECRAWL_MIN_GAP_MS
  ) {
    return "too_soon";
  }
  // Bekçi de hemen koşar: ana sayfadan 2xx gelirse engel kalkar.
  await prisma.seoSite.update({
    where: { id: site.id },
    data: {
      fullCrawlDueAt: now,
      regressionDueAt: now,
      crawlNextAt: now,
      crawlBlocked: false,
      crawlThrottles: 0,
    },
  });
  return "queued";
}

async function deleteAuditData(
  projectId: string,
  now: Date = new Date(),
): Promise<number> {
  const site = await forProject(projectId);
  if (!site) return 0;
  const scope = parseStoredScope(site.scope);
  const settings = parseSeoSiteSettings(site.settings);
  let hasLink = false;
  if (scope && scope.kind !== "VERIFIED_DOMAIN") {
    const link = await prisma.gscSiteLink.findFirst({
      where: { projectId, isPrimary: true, isMock: site.isMock },
      select: { id: true },
    });
    hasLink = link !== null;
  }
  const { deleted } = await resetSite(site.id, now, {
    keepVerification: true,
    extra: scope ? armedSchedule(now, settings.crawlEnabled, hasLink) : {},
  });
  return deleted;
}

async function markHealthDue(
  siteId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.seoSite.updateMany({
    where: {
      id: siteId,
      OR: [{ healthDueAt: null }, { healthDueAt: { gt: now } }],
    },
    data: { healthDueAt: now },
  });
}

type FrontierRow = { u: string; d: number; s: string };

function withoutGscSeeds(value: unknown): FrontierRow[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const queue = (value as { queue?: unknown }).queue;
  if (!Array.isArray(queue)) return null;
  return queue.filter(
    (item): item is FrontierRow =>
      !!item &&
      typeof item === "object" &&
      typeof (item as FrontierRow).u === "string" &&
      typeof (item as FrontierRow).d === "number" &&
      typeof (item as FrontierRow).s === "string" &&
      (item as FrontierRow).s !== "GSC",
  );
}

// Disconnect / "Delete stored data" / W1 yetim bağ temizliği: denetimdeki
// Google kökenli durum silinir (bayraktan bağımsız, iki kipte de).
async function forgetSearchConsoleData(
  projectIds: readonly string[],
  options: { resetScope: boolean },
  now: Date = new Date(),
): Promise<number> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return 0;
  const sites = await prisma.seoSite.findMany({
    where: { projectId: { in: ids } },
  });
  const rebuild = new Set<string>();
  for (const site of sites) {
    const scope = parseStoredScope(site.scope);
    if (options.resetScope && scope && scope.kind !== "VERIFIED_DOMAIN") {
      await resetSite(site.id, now, {
        keepVerification: true,
        extra: { scope: Prisma.DbNull, scopeKey: null },
      });
      if (site.isMock === seoMockMode()) rebuild.add(site.projectId);
      continue;
    }
    await prisma.seoSite.update({
      where: { id: site.id },
      data: {
        inspectQueue: Prisma.DbNull,
        inspectDay: null,
        inspectCount: 0,
        healthScore: null,
        healthParts: Prisma.DbNull,
        healthComputedAt: null,
        healthDueAt: now,
      },
    });
    const running = await prisma.seoCrawl.findMany({
      where: { siteId: site.id, status: "RUNNING" },
      select: { id: true, frontier: true },
    });
    for (const crawl of running) {
      const queue = withoutGscSeeds(crawl.frontier);
      if (!queue) continue;
      await prisma.seoCrawl.update({
        where: { id: crawl.id },
        data: { frontier: { v: 1, queue } },
      });
    }
    await prisma.seoPage.deleteMany({
      where: {
        siteId: site.id,
        discoveredVia: "GSC",
        inSitemap: false,
        inlinks: 0,
        path: { not: "/" },
      },
    });
  }
  // GSC kapsamı düşen site, doğrulanmış alan adı varsa ondan yeniden kurulur.
  for (const projectId of rebuild) {
    await ensureForProject(projectId, now).catch((error: unknown) =>
      report(`project ${projectId} could not be rebuilt`, error),
    );
  }
  return sites.length;
}

export const SeoSites = {
  reconcileDue,
  ensureForProject,
  forProject,
  readState,
  setCrawlSettings,
  requestRecrawl,
  deleteAuditData,
  markHealthDue,
  forgetSearchConsoleData,
};
