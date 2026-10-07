import "server-only";

import {
  CRAWL_MAX_BYTES,
  CRAWL_MIN_INTERVAL_MS,
  SEO_CRAWLER_TOKEN,
} from "@/lib/seo/audit-constants";
import {
  crawlHostAllowed,
  crawlUrlHash,
  hostTwin,
  inScope,
  normalizeCrawlUrl,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import { extractPageFacts, parseXRobotsTag } from "@/lib/seo/html-audit";
import {
  groupFor,
  isAllowed,
  type ParsedRobots,
} from "@/lib/seo/robots-parser";
import type { PageSnapshot } from "@/lib/seo/actions/types";
import {
  observedFromFacts,
  sameText,
  type CrawledChange,
  type ObservedPage,
} from "@/lib/seo/actions/verify-checks";
import { prisma } from "@/lib/prisma";
import { htmlToText } from "@/server/research/page-text";
import { siteFetch, type SiteFetchDeps } from "@/server/seo/crawl/fetcher";
import { sharedHostPacer } from "@/server/seo/crawl/pacer";
import {
  isFailingVerdict,
  robotsGate,
  storedRobots,
} from "@/server/seo/crawl/robots";
import { siteTransport } from "@/server/seo/crawl/transport";
import { parseStoredScope } from "@/server/seo/site/scope";
import { SeoSites } from "@/server/seo/site/sites";

// Tek sayfa denetimi, KENDİ tarayıcı yığınımızla (docs/search-actions.md
// "Doğrulama"): siteFetch (güvenli adres, kapsam, yönlendirme adımları, alan
// adı başına aralık), saklı robots.txt ve eş alan adı için W2 robotsGate. SeoPage
// yazılmaz (tarayıcı sahibidir); gövde ve tam adres loglanmaz, yalnız alan adı.

const CRAWL_DELAY_MAX_MS = 10_000;

export type PageCheckSite = {
  siteId: string;
  projectId: string;
  scope: CrawlScope;
  origin: string;
  originHost: string;
  robots: ParsedRobots | null;
  robotsFailing: boolean;
  crawlDelayMs: number;
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function pageCheckSite(
  projectId: string,
): Promise<PageCheckSite | null> {
  const site = await SeoSites.forProject(projectId);
  if (!site || !site.origin) return null;
  const scope = parseStoredScope(site.scope);
  if (!scope) return null;
  const originHost = hostOf(site.origin);
  if (!originHost) return null;
  const robots = storedRobots(site);
  const group = robots ? groupFor(robots, SEO_CRAWLER_TOKEN) : null;
  return {
    siteId: site.id,
    projectId: site.projectId,
    scope,
    origin: site.origin,
    originHost,
    robots,
    robotsFailing: isFailingVerdict(site.robotsVerdict),
    crawlDelayMs: Math.max(
      CRAWL_MIN_INTERVAL_MS,
      Math.min(group?.crawlDelayMs ?? 0, CRAWL_DELAY_MAX_MS),
    ),
  };
}

type TwinRobots = Map<string, ParsedRobots | null | "deny">;

// robotsGate için hafif bağlam: tam bir tarama koşusu kurmadan aynı kapı.
function gateFor(
  site: PageCheckSite,
  deps: SiteFetchDeps,
  twinRobots: TwinRobots,
): (url: string) => Promise<boolean> {
  const light = {
    scope: site.scope,
    deps,
    originHost: site.originHost,
    robots: site.robots,
    twinRobots,
  };
  return robotsGate(light as Parameters<typeof robotsGate>[0]);
}

// Eş alan adındaki (www/apex) hedef köken alan adına çevrilir; geçersiz adres null.
function resolveTarget(site: PageCheckSite, url: string): string | null {
  const normalized = normalizeCrawlUrl(url);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (parsed.hostname.toLowerCase() === hostTwin(site.originHost)) {
    parsed.hostname = site.originHost;
    return normalizeCrawlUrl(parsed.toString());
  }
  return normalized;
}

export type PageCheckResult =
  | { ok: true; page: ObservedPage; text: string | null }
  | {
      ok: false;
      reason: "OUT_OF_SCOPE" | "ROBOTS" | "FETCH_FAILED";
      page: ObservedPage | null;
    };

function emptyObserved(input: {
  url: string;
  finalUrl: string;
  status: number | null;
  hops: number;
  fetchError: string | null;
  robotsBlocked: boolean;
  now: Date;
}): ObservedPage {
  return observedFromFacts({
    url: input.url,
    finalUrl: input.finalUrl,
    status: input.status,
    hops: input.hops,
    facts: null,
    headerNoindex: false,
    fetchError: input.fetchError,
    robotsBlocked: input.robotsBlocked,
    fetchedAt: input.now,
  });
}

export async function checkPage(
  site: PageCheckSite,
  url: string,
  options: {
    deps?: Partial<SiteFetchDeps>;
    textChars?: number;
    now?: Date;
    twinRobots?: TwinRobots;
  } = {},
): Promise<PageCheckResult> {
  const now = options.now ?? new Date();
  const blocked = (reason: "OUT_OF_SCOPE" | "ROBOTS"): PageCheckResult => ({
    ok: false,
    reason,
    page:
      reason === "ROBOTS"
        ? emptyObserved({
            url,
            finalUrl: url,
            status: null,
            hops: 0,
            fetchError: null,
            robotsBlocked: true,
            now,
          })
        : null,
  });

  // robots.txt okunamıyorsa (5xx/ulaşılamaz) hiçbir şey getirilmez.
  if (site.robotsFailing) return blocked("ROBOTS");

  const target = resolveTarget(site, url);
  if (
    !target ||
    !inScope(target, site.scope) ||
    !crawlHostAllowed(target, site.originHost)
  ) {
    return blocked("OUT_OF_SCOPE");
  }

  const deps: SiteFetchDeps = {
    transport: siteTransport(),
    pacer: sharedHostPacer,
    ...options.deps,
  };
  const gate = gateFor(site, deps, options.twinRobots ?? new Map());
  // İlk adres robots.txt'e takılıyorsa taşıyıcıya hiç gidilmez.
  if (!(await gate(target))) return blocked("ROBOTS");

  const result = await siteFetch(
    target,
    {
      scope: site.scope,
      originHost: site.originHost,
      accept: "html",
      maxBytes: CRAWL_MAX_BYTES,
      isAllowed: gate,
      intervalMs: site.crawlDelayMs,
    },
    deps,
  );

  const hops = Math.max(0, result.hops.length - 1);
  if (result.blockedByRobots || result.blockedHop) {
    return {
      ok: false,
      reason: "ROBOTS",
      page: emptyObserved({
        url: target,
        finalUrl: result.finalUrl,
        status: result.status,
        hops,
        fetchError: null,
        robotsBlocked: true,
        now,
      }),
    };
  }

  const fetchError =
    result.errorKind ??
    (result.redirectLoop
      ? "LOOP"
      : result.tooManyRedirects
        ? "TOO_MANY_REDIRECTS"
        : null);
  if (fetchError || result.status === null) {
    return {
      ok: false,
      reason: "FETCH_FAILED",
      page: emptyObserved({
        url: target,
        finalUrl: result.finalUrl,
        status: result.status,
        hops,
        fetchError: fetchError ?? "NETWORK",
        robotsBlocked: false,
        now,
      }),
    };
  }

  // Yalnız 200 yanıtın gövdesi sayfa olgusu sayılır (404 sayfasının başlığı değil).
  const html =
    result.status === 200 && result.body ? result.body.toString("utf8") : null;
  const facts = html
    ? extractPageFacts(html, result.finalUrl, { truncated: result.truncated })
    : null;
  const page = observedFromFacts({
    url: target,
    finalUrl: result.finalUrl,
    status: result.status,
    hops,
    facts,
    headerNoindex: parseXRobotsTag(result.xRobotsTag).noindex,
    fetchError: null,
    robotsBlocked: false,
    fetchedAt: now,
  });
  const text =
    html && options.textChars ? htmlToText(html, options.textChars) : null;
  return { ok: true, page, text };
}

// Robots kuralı bu adresi bizim belirtecimize açıyor mu (köken alan adı).
export async function robotsAllow(
  site: PageCheckSite,
  url: string,
): Promise<boolean> {
  if (site.robotsFailing) return false;
  const target = resolveTarget(site, url);
  if (!target) return false;
  return isAllowed(site.robots, SEO_CRAWLER_TOKEN, target).allowed;
}

// --- tarayıcının kendi kaydı ---------------------------------------------------

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export type CrawledPage = {
  snapshot: PageSnapshot;
  crawled: CrawledChange & { lastChangedAt: Date | null };
  firstSeenAt: Date;
};

// Haftalık tarayıcının kaydı (SeoPage); yalnız okunur. Başlık değişimi
// previous.title ile, içerik değişimi lastChangedAt > firstSeenAt ile anlaşılır
// (ilk görülme değişim sayılmaz). Çağıran appliedAt − 14 gün koşulunu ekler.
export async function readCrawledPage(
  siteId: string,
  url: string,
): Promise<CrawledPage | null> {
  const normalized = normalizeCrawlUrl(url);
  if (!normalized) return null;
  const row = await prisma.seoPage.findUnique({
    where: {
      siteId_urlHash: { siteId, urlHash: crawlUrlHash(normalized) },
    },
  });
  if (!row || row.goneAt !== null) return null;

  const headings =
    row.headings &&
    typeof row.headings === "object" &&
    !Array.isArray(row.headings)
      ? (row.headings as Record<string, unknown>)
      : {};
  const h1s = textList(headings.h1);
  const previous =
    row.previous &&
    typeof row.previous === "object" &&
    !Array.isArray(row.previous)
      ? (row.previous as Record<string, unknown>)
      : null;
  const previousTitle =
    typeof previous?.title === "string" ? previous.title : null;
  const changedAfterFirst =
    row.lastChangedAt !== null &&
    row.lastChangedAt.getTime() > row.firstSeenAt.getTime();

  return {
    snapshot: {
      url: row.url,
      status: row.status,
      title: row.title,
      metaDescription: row.metaDescription,
      h1: row.h1 ?? h1s[0] ?? null,
      h2: textList(headings.h2).slice(0, 20),
      canonical: row.canonical,
      noindex: row.noindex,
      indexable: row.indexable,
      wordCount: row.wordCount,
      textHash: row.textHash,
      schemaTypes: row.schemaTypes,
      schemaErrors: Array.isArray(row.schemaErrors)
        ? row.schemaErrors.length
        : 0,
      fetchedAt: (row.lastCrawledAt ?? row.firstSeenAt).toISOString(),
      source: "CRAWL",
    },
    crawled: {
      titleChanged:
        previousTitle !== null &&
        !sameText(previousTitle, row.title) &&
        changedAfterFirst,
      contentChanged: changedAfterFirst,
      lastChangedAt: row.lastChangedAt,
    },
    firstSeenAt: row.firstSeenAt,
  };
}
