import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type SeoCrawl } from "@prisma/client";

import {
  CRAWL_LEASE_MS,
  CRAWL_PAGES_PER_WEEK,
  CRAWL_PAUSE_MAX_MS,
  CRAWL_PAUSE_MIN_MS,
  CRAWL_TICK_BUDGET_MS,
  ROBOTS_CACHE_MS,
  SITEMAP_EVERY_MS,
} from "@/lib/seo/audit-constants";
import {
  crawlUrlHash,
  normalizeCrawlUrl,
  startUrlFor,
} from "@/lib/seo/crawl-url";
import {
  SeoFlags,
  seoGlobalWorkAllowedHere,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "@/lib/seo/health-flags";
import { safeTimezone } from "@/lib/website-analytics/days";
import { prisma } from "@/lib/prisma";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { Heartbeat } from "@/server/observability/heartbeat";
import { keyPagesFor, type KeyPage } from "@/server/seo/site/key-pages";
import { parseStoredScope, resolveSiteScope } from "@/server/seo/site/scope";
import { parseSeoSiteSettings, SeoSites } from "@/server/seo/site/sites";

import { siteFetch, type SiteFetchDeps } from "./fetcher";
import {
  finalizeFullCrawl,
  parseCrawlStats,
  type CrawlStats,
} from "./finalize";
import {
  Frontier,
  fetchedInCrawl,
  loadSeedSources,
  parseFrontier,
  seedFrontier,
} from "./frontier";
import { sharedHostPacer } from "./pacer";
import { writePageResult, writeRobotsBlocked } from "./pages";
import { runRegression } from "./regression";
import {
  crawlIntervalMs,
  isFailingVerdict,
  refreshRobots,
  robotsGate,
  storedRobots,
  type SiteRunContext,
} from "./robots";
import { inNightWindow, nextCrawlAt } from "./schedule";
import { refreshSitemaps } from "./sitemaps";
import { siteTransport } from "./transport";

export { nextCrawlAt } from "./schedule";

// Site tarayıcısı (docs/search-health.md "Tarayıcı", "Gerileme bekçisi"):
// `seo-crawl` tick adımı. Vadesi gelen en çok 3 site paralel; site başına
// 5 dakikalık CAS kilidi ve 45 sn'lik süre. Koşu sırası: robots.txt (önbellek
// 24 saat; bekçi vadesindeyse önbelleksiz) → kendi sitemap'lerimiz (günlük)
// → 6 saatlik bekçi (blocked iken de) → haftalık tam tarama (ilki hemen,
// sonrakiler proje saatiyle 01:00–06:00; devam eden tarama her saatte
// sürer). robots bu koşuda başarısızsa geri kalanı atlanır. Her yazım
// öncesi scopeKey yeniden okunur; kapsam değiştiyse koşu sessizce durur.
// Bırakış crawlNextAt'i her zaman ≥ now + 1 dk'ya kurar (schedule.ts).

export type CrawlTickResult = {
  fetched: number;
  regression: boolean;
  full: "started" | "continued" | "finished" | "idle";
  stopped:
    | null
    | "budget"
    | "throttled"
    | "robots"
    | "blocked"
    | "disabled"
    | "no_scope"
    | "scope_changed";
};

export type RunSiteOptions = {
  now?: Date;
  budgetMs?: number;
  deps?: Partial<SiteFetchDeps>;
  // robots.txt yeniden denemesinin 10 sn beklemesi (testler anında geçer)
  sleep?: (ms: number) => Promise<void>;
};

const CANDIDATES = 20;
const HEARTBEAT_KEY = "seo.crawl";
const INACTIVE_STATUSES = new Set(["PAUSED", "CLOSED"]);
const THROTTLES_TO_BLOCK = 3;
const DEFAULT_PAUSE_MS = 30 * 60_000;

// Kapsam değişti, satır silindi ya da kilit başkasına geçti: koşu durur.
class ScopeChangedError extends Error {}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof ScopeChangedError) return true;
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2003" || error.code === "P2025")
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function claim(
  siteId: string,
  owner: string,
  now: Date,
): Promise<boolean> {
  const claimed = await prisma.seoSite.updateMany({
    where: {
      id: siteId,
      OR: [{ crawlLeaseUntil: null }, { crawlLeaseUntil: { lt: now } }],
    },
    data: {
      crawlLeaseUntil: new Date(now.getTime() + CRAWL_LEASE_MS),
      crawlLeaseOwner: owner,
    },
  });
  return claimed.count === 1;
}

function clampPause(ms: number | null): number {
  return Math.min(
    CRAWL_PAUSE_MAX_MS,
    Math.max(CRAWL_PAUSE_MIN_MS, ms ?? DEFAULT_PAUSE_MS),
  );
}

type FullOutcome = {
  full: CrawlTickResult["full"];
  stopped: CrawlTickResult["stopped"];
  fetched: number;
  finished: boolean;
};

function addCount(stats: CrawlStats, key: string) {
  stats.statuses[key] = (stats.statuses[key] ?? 0) + 1;
}

async function blockCrawl(
  ctx: SiteRunContext,
  crawl: Pick<SeoCrawl, "id">,
  frontier: Frontier | null,
  stats: CrawlStats,
  counters: { pagesFetched: number; notModified: number; errors: number },
): Promise<void> {
  await ctx.guard();
  await prisma.seoCrawl.update({
    where: { id: crawl.id },
    data: {
      status: "BLOCKED",
      finishedAt: ctx.now,
      frontier: Prisma.DbNull,
      stats: { ...stats, ...(frontier ? frontierStats(stats, frontier) : {}) },
      ...counters,
    },
  });
}

function frontierStats(stats: CrawlStats, frontier: Frontier) {
  return {
    otherHosts: stats.otherHosts + frontier.stats.otherHosts,
    longUrls: stats.longUrls + frontier.stats.longUrls,
    droppedFrontier: stats.droppedFrontier + frontier.stats.droppedFrontier,
    outOfScope: stats.outOfScope + frontier.stats.outOfScope,
  };
}

// Haftalık tam tarama: başlat ya da kaydedilmiş kuyruktan devam et.
async function runFullCrawl(
  ctx: SiteRunContext,
  pageLimit: number,
  keyPages: readonly KeyPage[],
  homeUrl: string,
): Promise<FullOutcome> {
  const outcome: FullOutcome = {
    full: "idle",
    stopped: null,
    fetched: 0,
    finished: false,
  };
  const running = await prisma.seoCrawl.findFirst({
    where: { siteId: ctx.site.id, kind: "FULL", status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });
  if (ctx.site.crawlBlocked) {
    // Engelliyken tam tarama durur; bekçi engeli kaldırınca yeniden başlar.
    if (running) {
      await blockCrawl(ctx, running, null, parseCrawlStats(running.stats), {
        pagesFetched: running.pagesFetched,
        notModified: running.notModified,
        errors: running.errors,
      });
      outcome.finished = true;
    }
    outcome.stopped = "blocked";
    return outcome;
  }

  let crawl = running;
  let frontier: Frontier;
  const homeHash = crawlUrlHash(homeUrl);
  if (!crawl) {
    const due =
      !ctx.site.fullCrawlDueAt ||
      ctx.site.fullCrawlDueAt.getTime() <= ctx.now.getTime();
    if (!due) return outcome;
    if (ctx.site.lastFullCrawlAt && !inNightWindow(ctx.now, ctx.timezone)) {
      return outcome;
    }
    if (ctx.remaining() <= 0) {
      outcome.stopped = "budget";
      return outcome;
    }
    const seeds = await loadSeedSources(ctx.site, ctx.linkId, ctx.now);
    frontier = new Frontier(ctx.scope, ctx.originHost);
    seedFrontier(frontier, {
      homeUrl,
      keyPages: keyPages.map((page) => page.url),
      gscUrls: seeds.gscUrls,
      sitemapUrls: seeds.sitemapUrls,
    });
    await ctx.guard();
    crawl = await prisma.seoCrawl.create({
      data: {
        siteId: ctx.site.id,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        kind: "FULL",
        status: "RUNNING",
        startedAt: ctx.now,
        budget: Math.min(pageLimit, CRAWL_PAGES_PER_WEEK),
        robotsHash: ctx.site.robotsHash,
        frontier: frontier.toState(),
      },
    });
    outcome.full = "started";
  } else {
    frontier = Frontier.restore(
      ctx.scope,
      ctx.originHost,
      parseFrontier(crawl.frontier),
      await fetchedInCrawl(crawl),
    );
    outcome.full = "continued";
  }

  const stats = parseCrawlStats(crawl.stats);
  const counters = {
    pagesFetched: crawl.pagesFetched,
    notModified: crawl.notModified,
    errors: crawl.errors,
  };
  const keyHashes = new Set(keyPages.map((page) => page.urlHash));
  const gate = robotsGate(ctx);
  const intervalMs = crawlIntervalMs(ctx);
  let blocked = false;

  while (counters.pagesFetched < crawl.budget) {
    if (ctx.remaining() <= 0) {
      outcome.stopped = "budget";
      break;
    }
    const item = frontier.pop();
    if (!item) break;
    const urlHash = crawlUrlHash(item.u);
    const isHomepage = urlHash === homeHash;
    const existing = await prisma.seoPage.findUnique({
      where: { siteId_urlHash: { siteId: ctx.site.id, urlHash } },
    });
    const result = await siteFetch(
      item.u,
      {
        scope: ctx.scope,
        originHost: ctx.originHost,
        accept: "html",
        conditional:
          existing && existing.lastCrawledAt
            ? { etag: existing.etag, lastModified: existing.lastModified }
            : null,
        isAllowed: gate,
        intervalMs,
      },
      ctx.deps,
    );
    if (result.blockedByRobots) {
      // İstek yapılmadı; bütçeden düşmez.
      stats.blockedByRobots += 1;
      await writeRobotsBlocked(ctx, {
        crawlId: crawl.id,
        url: item.u,
        urlHash,
        source: item.s,
        existing,
      });
      continue;
    }
    counters.pagesFetched += 1;
    outcome.fetched += 1;
    if (result.notModified) counters.notModified += 1;
    if (result.errorKind) counters.errors += 1;
    addCount(
      stats,
      result.status === null
        ? (result.errorKind ?? "ERROR")
        : String(result.status),
    );

    if (result.status === 429 || result.status === 503) {
      // Site yavaşlamamızı istiyor: duraklat, art arda üçüncüde engelli say.
      stats.throttled += 1;
      frontier.requeue(item);
      const throttles = ctx.site.crawlThrottles + 1;
      const pausedUntil = new Date(
        ctx.now.getTime() + clampPause(result.retryAfterMs),
      );
      blocked = throttles >= THROTTLES_TO_BLOCK;
      await ctx.guard();
      await prisma.seoSite.update({
        where: { id: ctx.site.id },
        data: {
          crawlPausedUntil: pausedUntil,
          crawlThrottles: throttles,
          ...(blocked ? { crawlBlocked: true } : {}),
        },
      });
      ctx.site = {
        ...ctx.site,
        crawlPausedUntil: pausedUntil,
        crawlThrottles: throttles,
        crawlBlocked: ctx.site.crawlBlocked || blocked,
      };
      outcome.stopped = blocked ? "blocked" : "throttled";
      break;
    }
    if (result.status === 403 && isHomepage) {
      blocked = true;
      await ctx.guard();
      await prisma.seoSite.update({
        where: { id: ctx.site.id },
        data: { crawlBlocked: true },
      });
      ctx.site = { ...ctx.site, crawlBlocked: true };
      outcome.stopped = "blocked";
      break;
    }
    if (
      result.status !== null &&
      result.status >= 200 &&
      result.status < 300 &&
      ctx.site.crawlThrottles > 0
    ) {
      await prisma.seoSite.update({
        where: { id: ctx.site.id },
        data: { crawlThrottles: 0 },
      });
      ctx.site = { ...ctx.site, crawlThrottles: 0 };
    }

    const written = await writePageResult(ctx, {
      crawlId: crawl.id,
      url: item.u,
      urlHash,
      result,
      source: item.s,
      isKeyPage: keyHashes.has(urlHash),
      isHomepage,
      existing,
    });
    if (written.originChanged) frontier.setOriginHost(ctx.originHost);
    if (written.knownBefore) {
      stats.knownRefetched += 1;
      if (existing?.status === 200 && result.hops.length > 1) {
        stats.knownNowRedirect += 1;
      }
    } else {
      stats.newUrls += 1;
    }
    if (result.hops.length > 1) stats.redirected += 1;
    for (const link of written.links) frontier.add(link, item.d + 1, "CRAWL");
  }

  if (blocked) {
    await blockCrawl(ctx, crawl, frontier, stats, counters);
    outcome.finished = true;
    return outcome;
  }
  const merged: CrawlStats = { ...stats, ...frontierStats(stats, frontier) };
  const exhausted = frontier.size === 0;
  const spent = counters.pagesFetched >= crawl.budget;
  if (outcome.stopped === null && (exhausted || spent)) {
    await finalizeFullCrawl(ctx, {
      crawlId: crawl.id,
      startedAt: crawl.startedAt,
      status: exhausted ? "DONE" : "PARTIAL",
      stats: merged,
      counters,
      homeHash,
      keyHashes,
    });
    outcome.full = "finished";
    outcome.finished = true;
    return outcome;
  }
  // Devam edecek: kuyruk ve sayaçlar her koşunun sonunda saklanır.
  await ctx.guard();
  await prisma.seoCrawl.update({
    where: { id: crawl.id },
    data: { frontier: frontier.toState(), stats: merged, ...counters },
  });
  return outcome;
}

async function runSite(
  siteId: string,
  options: RunSiteOptions = {},
): Promise<CrawlTickResult> {
  const now = options.now ?? new Date();
  const result: CrawlTickResult = {
    fetched: 0,
    regression: false,
    full: "idle",
    stopped: null,
  };
  const owner = randomUUID();
  if (!(await claim(siteId, owner, now))) return result;

  // releaseOnly: kapsam sıfırlandı ya da koşu durduruldu; zamanlar
  // ensureForProject'in kurduğu gibi kalır.
  let mode: "schedule" | "disable" | "releaseOnly" = "schedule";
  let healthDue = false;
  let lastError: string | null = null;
  try {
    const site = await prisma.seoSite.findUnique({ where: { id: siteId } });
    if (!site) {
      mode = "releaseOnly";
      return result;
    }
    if (!seoWorkAllowedFor(site.projectId)) {
      mode = "releaseOnly";
      result.stopped = "disabled";
      return result;
    }
    const project = await prisma.project.findUnique({
      where: { id: site.projectId },
      select: { id: true, workspaceId: true, status: true, domain: true },
    });
    const storedScope = parseStoredScope(site.scope);
    const resolution =
      project && !INACTIVE_STATUSES.has(project.status)
        ? await resolveSiteScope({
            projectId: site.projectId,
            domain: project.domain,
            verifiedDomain: site.verifiedDomain,
          })
        : null;
    if (!project || !resolution) {
      await SeoSites.ensureForProject(site.projectId, now);
      mode = "releaseOnly";
      result.stopped = "no_scope";
      return result;
    }
    if (!storedScope || resolution.scope.key !== site.scopeKey) {
      await SeoSites.ensureForProject(site.projectId, now);
      mode = "releaseOnly";
      result.stopped = "scope_changed";
      return result;
    }

    const settings = parseSeoSiteSettings(site.settings);
    if (!settings.crawlEnabled) {
      mode = "disable";
      result.stopped = "disabled";
      return result;
    }
    if (
      site.crawlPausedUntil &&
      site.crawlPausedUntil.getTime() > now.getTime()
    ) {
      result.stopped = "blocked";
      return result;
    }

    const timezone = safeTimezone(await getProjectTimezone(site.projectId));
    const budgetMs = options.budgetMs ?? CRAWL_TICK_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    const startUrl = startUrlFor(storedScope, project.domain);
    const origin = site.origin ?? new URL(startUrl).origin;
    const scopeKey = site.scopeKey;
    const ctx: SiteRunContext = {
      site,
      scope: storedScope,
      projectId: site.projectId,
      workspaceId: site.workspaceId,
      domain: project.domain,
      linkId: resolution.linkId,
      timezone,
      now,
      remaining: () => deadline - Date.now(),
      sleep: options.sleep ?? defaultSleep,
      deps: {
        transport: options.deps?.transport ?? siteTransport(),
        pacer: options.deps?.pacer ?? sharedHostPacer,
      },
      origin,
      originHost: hostOf(origin),
      robots: storedRobots(site),
      twinRobots: new Map(),
      guard: async () => {
        const row = await prisma.seoSite.findUnique({
          where: { id: siteId },
          select: { scopeKey: true, crawlLeaseOwner: true },
        });
        if (
          !row ||
          row.scopeKey !== scopeKey ||
          row.crawlLeaseOwner !== owner
        ) {
          throw new ScopeChangedError("scope changed during the run");
        }
      },
    };

    // (1) robots.txt
    const nowMs = now.getTime();
    const regressionDue =
      !site.regressionDueAt || site.regressionDueAt.getTime() <= nowMs;
    const retryWaiting =
      site.robotsRetryAt !== null && site.robotsRetryAt.getTime() > nowMs;
    const robotsStale =
      !site.robotsFetchedAt ||
      nowMs - site.robotsFetchedAt.getTime() >= ROBOTS_CACHE_MS;
    let robotsFailing = retryWaiting;
    if (
      !retryWaiting &&
      (robotsStale || regressionDue || isFailingVerdict(site.robotsVerdict))
    ) {
      const robots = await refreshRobots(ctx);
      robotsFailing = robots.failing;
      if (robots.changed) healthDue = true;
    }
    if (robotsFailing) {
      result.stopped = "robots";
      return result;
    }

    // (2) kendi sitemap'lerimiz
    const sitemapsStale =
      !ctx.site.sitemapsCheckedAt ||
      nowMs - ctx.site.sitemapsCheckedAt.getTime() >= SITEMAP_EVERY_MS;
    if (sitemapsStale && ctx.remaining() > 0) {
      const sitemaps = await refreshSitemaps(ctx);
      if (sitemaps.changed) healthDue = true;
    }

    // (3) gerileme bekçisi (engelliyken de)
    const keyPages = await keyPagesFor(ctx.site, now);
    if (regressionDue && ctx.remaining() > 0) {
      const regression = await runRegression(ctx, keyPages);
      result.regression = true;
      result.fetched += regression.fetched;
      healthDue = true;
    }

    // (4) tam tarama
    const homeUrl =
      keyPages.find((page) => page.isHomepage)?.url ??
      normalizeCrawlUrl(`${ctx.origin}/`) ??
      startUrl;
    const full = await runFullCrawl(ctx, settings.pageLimit, keyPages, homeUrl);
    result.fetched += full.fetched;
    result.full = full.full;
    if (full.finished) healthDue = true;
    if (full.stopped) result.stopped = full.stopped;
    else if (ctx.remaining() <= 0 && result.full === "continued") {
      result.stopped = "budget";
    }
    return result;
  } catch (error) {
    if (isAbortError(error)) {
      mode = "releaseOnly";
      result.stopped = "scope_changed";
      return result;
    }
    lastError = messageOf(error).slice(0, 500);
    console.error(`[seo-crawl] site ${siteId} run failed:`, lastError);
    return result;
  } finally {
    await release(siteId, owner, now, mode, lastError).catch((error: unknown) =>
      console.error(
        `[seo-crawl] site ${siteId} could not be released:`,
        messageOf(error),
      ),
    );
    if (healthDue && mode !== "releaseOnly") {
      await SeoSites.markHealthDue(siteId, now).catch(() => undefined);
    }
  }
}

// Kilidi bırakır ve bir sonraki koşuyu kurar (schedule.ts).
async function release(
  siteId: string,
  owner: string,
  now: Date,
  mode: "schedule" | "disable" | "releaseOnly",
  lastError: string | null,
): Promise<void> {
  const clearLease = { crawlLeaseUntil: null, crawlLeaseOwner: null };
  if (mode === "releaseOnly") {
    await prisma.seoSite.updateMany({
      where: { id: siteId, crawlLeaseOwner: owner },
      data: clearLease,
    });
    return;
  }
  if (mode === "disable") {
    await prisma.seoSite.updateMany({
      where: { id: siteId, crawlLeaseOwner: owner },
      data: { ...clearLease, crawlNextAt: null },
    });
    return;
  }
  const site = await prisma.seoSite.findUnique({ where: { id: siteId } });
  if (!site) return;
  const [running, timezone] = await Promise.all([
    prisma.seoCrawl.findFirst({
      where: { siteId, kind: "FULL", status: "RUNNING" },
      select: { id: true },
    }),
    getProjectTimezone(site.projectId),
  ]);
  const next = nextCrawlAt({
    now,
    pausedUntil: site.crawlPausedUntil,
    robotsRetryAt: site.robotsRetryAt,
    regressionDueAt: site.regressionDueAt,
    robotsFetchedAt: site.robotsFetchedAt,
    sitemapsCheckedAt: site.sitemapsCheckedAt,
    fullCrawlDueAt: site.fullCrawlDueAt,
    fullRunning: running !== null,
    crawlBlocked: site.crawlBlocked,
    hasFullCrawl: site.lastFullCrawlAt !== null,
    timezone: safeTimezone(timezone),
  });
  await prisma.seoSite.updateMany({
    where: { id: siteId, crawlLeaseOwner: owner },
    data: { ...clearLease, crawlNextAt: next, lastCrawlError: lastError },
  });
}

async function runDue(limit = 3, now: Date = new Date()): Promise<number> {
  if (!SeoFlags.crawl()) return 0;
  const global = seoGlobalWorkAllowedHere();
  if (global) await Heartbeat.beat(HEARTBEAT_KEY, now);
  await SeoSites.reconcileDue(now).catch((error: unknown) =>
    console.error(
      "[seo-crawl] sites could not be reconciled:",
      messageOf(error),
    ),
  );
  const restricted = seoRestrictedProjects();
  if (restricted && restricted.length === 0) return 0;
  const candidates = await prisma.seoSite.findMany({
    where: {
      isMock: seoMockMode(),
      crawlNextAt: { not: null, lte: now },
      scopeKey: { not: null },
      OR: [{ crawlLeaseUntil: null }, { crawlLeaseUntil: { lt: now } }],
      ...(restricted ? { projectId: { in: restricted } } : {}),
    },
    orderBy: { crawlNextAt: "asc" },
    take: CANDIDATES,
    select: { id: true },
  });
  const chosen = candidates.slice(0, Math.max(0, limit));
  const settled = await Promise.allSettled(
    chosen.map((site) => runSite(site.id, { now })),
  );
  let firstError: string | null = null;
  let ran = 0;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") ran += 1;
    else firstError ??= messageOf(outcome.reason);
  }
  if (global) await Heartbeat.ok(HEARTBEAT_KEY, now, firstError);
  return ran;
}

export const SeoCrawler = { runDue, runSite };
