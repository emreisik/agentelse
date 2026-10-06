import "server-only";

import { Prisma, type SeoPage } from "@prisma/client";

import { CRAWL_LINKS_PER_PAGE } from "@/lib/seo/audit-constants";
import {
  crawlUrlHash,
  inScope,
  normalizeCrawlUrl,
  pathOf,
} from "@/lib/seo/crawl-url";
import {
  extractPageFacts,
  parseXRobotsTag,
  type PageFacts,
} from "@/lib/seo/html-audit";
import {
  SITE_LEVEL_CODES,
  TA_CATALOG,
  auditPage,
  isIndexable,
  type AuditPageInput,
  type PageIssue,
  type TaCode,
} from "@/lib/seo/technical-audit";
import { prisma } from "@/lib/prisma";

import type { SiteFetchResult } from "./fetcher";
import type { FrontierSource } from "./frontier";
import type { SiteRunContext } from "./robots";

// Bir getirmenin SeoPage'e yazımı (docs/search-health.md "Tarayıcı"). Sayfa
// metni saklanmaz: yalnız özet alanlar, parmak izleri, iç linkler ve
// sorunlar. fetchError yanıt gelmeyen durumları anlatır (TIMEOUT | NETWORK |
// UNSAFE | LOOP | TOO_MANY_REDIRECTS | LEFT_SCOPE | ROBOTS_HOP); status son
// adımın kodudur, redirectChain bütün adımlar. 304 yalnız getirme izini
// günceller; saklı bilgi ve linkler kalır.

export type PageWriteInput = {
  crawlId: string;
  url: string;
  urlHash: string;
  result: SiteFetchResult;
  source: FrontierSource;
  isKeyPage: boolean;
  isHomepage: boolean;
  existing: SeoPage | null;
  // Gerileme bekçisi: var olan satırın lastCrawlId'si (tam taramanın "bu
  // taramada getirildi" işareti) değiştirilmez; yalnız yeni satıra yazılır.
  keepCrawlMarker?: boolean;
};

export type PageWriteResult = {
  pageId: string;
  // Kuyruğa önerilen kapsam içi linkler (nofollow olmayanlar)
  links: string[];
  // status, fetchError, noindex, canonical ya da title önceki getirmeden farklı
  criticalChanged: boolean;
  // Satır bu getirmeden önce de getirilmişti
  knownBefore: boolean;
  // Ana sayfanın son adresi kökeni değiştirdi
  originChanged: boolean;
};

type StoredPrevious = {
  status: number | null;
  fetchError: string | null;
  noindex: boolean;
  canonical: string | null;
  title: string | null;
  finalUrl: string | null;
  at: string;
};

const TA_CODES = new Set<string>(Object.keys(TA_CATALOG));
const SEVERITIES = new Set(["INFO", "WARN", "CRITICAL"]);
const SITE_LEVEL = new Set<string>(SITE_LEVEL_CODES);
const ANCHOR_MAX = 200;
const ASSETS_MAX = 20;

export function parseIssues(value: unknown): PageIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: PageIssue[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.code !== "string" ||
      !TA_CODES.has(record.code) ||
      typeof record.severity !== "string" ||
      !SEVERITIES.has(record.severity)
    ) {
      continue;
    }
    issues.push({
      code: record.code as TaCode,
      severity: record.severity as PageIssue["severity"],
    });
  }
  return issues;
}

function json(
  value: Prisma.InputJsonValue | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : value;
}

export function fetchErrorOf(result: SiteFetchResult): string | null {
  if (result.errorKind) return result.errorKind;
  if (result.redirectLoop) return "LOOP";
  if (result.tooManyRedirects) return "TOO_MANY_REDIRECTS";
  if (result.leftScope) return "LEFT_SCOPE";
  if (result.blockedHop) return "ROBOTS_HOP";
  return null;
}

function isHtmlType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function redirectHops(result: SiteFetchResult): number {
  return result.hops.filter((hop) => hop.status >= 300 && hop.status < 400)
    .length;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function sameOriginAssets(
  urls: readonly string[],
  origin: string | null,
): string[] {
  if (!origin) return [];
  return urls.filter((url) => originOf(url) === origin).slice(0, ASSETS_MAX);
}

function wasFetched(page: SeoPage | null): page is SeoPage {
  return page !== null && page.lastCrawledAt !== null;
}

function changedFrom(
  page: SeoPage,
  next: {
    status: number | null;
    fetchError: string | null;
    noindex: boolean;
    canonical: string | null;
    title: string | null;
  },
): boolean {
  return (
    page.status !== next.status ||
    page.fetchError !== next.fetchError ||
    page.noindex !== next.noindex ||
    page.canonical !== next.canonical ||
    page.title !== next.title
  );
}

function previousOf(page: SeoPage): StoredPrevious {
  return {
    status: page.status,
    fetchError: page.fetchError,
    noindex: page.noindex,
    canonical: page.canonical,
    title: page.title,
    finalUrl: page.finalUrl,
    at: (page.lastCrawledAt ?? page.firstSeenAt).toISOString(),
  };
}

function baseCreate(
  ctx: SiteRunContext,
  input: Pick<PageWriteInput, "url" | "urlHash" | "source">,
) {
  return {
    siteId: ctx.site.id,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    url: input.url,
    urlHash: input.urlHash,
    path: pathOf(input.url),
    discoveredVia: input.source,
    firstSeenAt: ctx.now,
  };
}

// robots.txt'nin yasakladığı ilk adres: istek yapılmadan işaretlenir.
export async function writeRobotsBlocked(
  ctx: SiteRunContext,
  input: Pick<
    PageWriteInput,
    "crawlId" | "url" | "urlHash" | "source" | "existing"
  >,
): Promise<void> {
  await ctx.guard();
  const data = {
    robotsBlocked: true,
    indexable: false,
    lastCrawlId: input.crawlId,
    goneAt: null,
  };
  await prisma.seoPage.upsert({
    where: { siteId_urlHash: { siteId: ctx.site.id, urlHash: input.urlHash } },
    create: { ...baseCreate(ctx, input), ...data },
    update: data,
  });
}

async function storedLinks(pageId: string): Promise<string[]> {
  const rows = await prisma.seoLink.findMany({
    where: { fromPageId: pageId, nofollow: false },
    select: { toUrl: true },
  });
  return rows.map((row) => row.toUrl);
}

type LinkRow = {
  toUrl: string;
  toUrlHash: string;
  anchor: string | null;
  nofollow: boolean;
};

function pageLinks(
  ctx: SiteRunContext,
  facts: PageFacts,
  ownHash: string,
): LinkRow[] {
  const rows: LinkRow[] = [];
  const seen = new Set<string>([ownHash]);
  for (const link of facts.links) {
    if (rows.length >= CRAWL_LINKS_PER_PAGE) break;
    const toUrl = normalizeCrawlUrl(link.href);
    if (!toUrl || !inScope(toUrl, ctx.scope)) continue;
    const toUrlHash = crawlUrlHash(toUrl);
    if (seen.has(toUrlHash)) continue;
    seen.add(toUrlHash);
    const anchor = link.anchor.trim().slice(0, ANCHOR_MAX);
    rows.push({
      toUrl,
      toUrlHash,
      anchor: anchor || null,
      nofollow: link.nofollow || facts.nofollow,
    });
  }
  return rows;
}

// Ana sayfanın son adresi kapsamdaysa kökeni o belirler.
async function adoptOrigin(
  ctx: SiteRunContext,
  finalUrl: string,
): Promise<boolean> {
  if (!inScope(finalUrl, ctx.scope)) return false;
  const origin = originOf(finalUrl);
  if (!origin || origin === ctx.site.origin) return false;
  await prisma.seoSite.update({
    where: { id: ctx.site.id },
    data: { origin },
  });
  ctx.site = { ...ctx.site, origin };
  const changed = origin !== ctx.origin;
  ctx.origin = origin;
  ctx.originHost = new URL(origin).hostname.toLowerCase();
  if (changed) ctx.twinRobots.clear();
  return changed;
}

function crawlMarker(input: PageWriteInput): { lastCrawlId?: string } {
  return input.keepCrawlMarker ? {} : { lastCrawlId: input.crawlId };
}

export async function writePageResult(
  ctx: SiteRunContext,
  input: PageWriteInput,
): Promise<PageWriteResult> {
  const { result, existing } = input;
  const knownBefore = wasFetched(existing);
  const where = {
    siteId_urlHash: { siteId: ctx.site.id, urlHash: input.urlHash },
  };

  // 304: saklı bilgi ve linkler geçerli.
  if (result.notModified && existing) {
    await ctx.guard();
    await prisma.seoPage.update({
      where: { id: existing.id },
      data: {
        ...crawlMarker(input),
        lastCrawledAt: ctx.now,
        etag: result.etag ?? existing.etag,
        goneAt: null,
      },
    });
    return {
      pageId: existing.id,
      links: await storedLinks(existing.id),
      criticalChanged: false,
      knownBefore,
      originChanged: false,
    };
  }

  const fetchError = fetchErrorOf(result);
  const status = result.status;
  const redirectChain = result.hops.map((hop) => ({
    url: hop.url,
    status: hop.status,
  }));
  const previous = knownBefore ? previousOf(existing) : null;

  // Yanıt hiç gelmediyse (zaman aşımı, ağ) saklı sayfa bilgisi korunur.
  if (result.errorKind) {
    const next = {
      status,
      fetchError,
      noindex: existing?.noindex ?? false,
      canonical: existing?.canonical ?? null,
      title: existing?.title ?? null,
    };
    const criticalChanged = knownBefore && changedFrom(existing, next);
    const data = {
      status,
      fetchError,
      finalUrl: result.finalUrl,
      redirectChain,
      robotsBlocked: false,
      ttfbMs: result.firstByteMs,
      previous: json(previous ?? null),
      ...crawlMarker(input),
      lastCrawledAt: ctx.now,
      ...(criticalChanged ? { lastChangedAt: ctx.now } : {}),
      goneAt: null,
    };
    await ctx.guard();
    const page = await prisma.seoPage.upsert({
      where,
      create: {
        ...baseCreate(ctx, input),
        ...data,
        lastCrawlId: input.crawlId,
        lastChangedAt: ctx.now,
      },
      update: data,
    });
    return {
      pageId: page.id,
      links: [],
      criticalChanged,
      knownBefore,
      originChanged: false,
    };
  }

  const html = isHtmlType(result.contentType);
  const facts =
    status === 200 && html && result.body && !result.bodySkipped
      ? extractPageFacts(result.body.toString("utf8"), result.finalUrl, {
          truncated: result.truncated,
        })
      : null;
  const xRobots = parseXRobotsTag(result.xRobotsTag);
  const noindex = (facts?.noindex ?? false) || xRobots.noindex;
  const canonical = facts ? (facts.canonicalResolved ?? facts.canonical) : null;
  const title = facts?.title ?? null;
  const auditInput: AuditPageInput = {
    url: input.url,
    status,
    fetchError,
    contentType: result.contentType,
    redirectHops: redirectHops(result),
    redirectLoop: result.redirectLoop,
    facts,
    headerNoindex: xRobots.noindex,
    ttfbMs: result.firstByteMs,
    robotsBlocked: false,
    isKeyPage: input.isKeyPage,
    shouldBeIndexed: (existing?.inSitemap ?? false) || input.isKeyPage,
    isHomepage: input.isHomepage,
  };
  const indexable = isIndexable(auditInput);
  const pageIssues = auditPage(auditInput);
  // Site düzeyindeki sorunlar finalize'a kadar korunur.
  const kept = parseIssues(existing?.issues ?? null).filter(
    (issue) =>
      SITE_LEVEL.has(issue.code) &&
      !pageIssues.some((own) => own.code === issue.code),
  );
  const issues = [...pageIssues, ...kept];
  const textHash = facts?.textHash ?? null;
  const next = { status, fetchError, noindex, canonical, title };
  const criticalChanged = knownBefore && changedFrom(existing, next);
  const contentChanged =
    !knownBefore || criticalChanged || existing.textHash !== textHash;
  const finalOrigin = originOf(result.finalUrl);
  const assets =
    input.isHomepage && facts
      ? {
          scripts: sameOriginAssets(facts.scripts.srcs, finalOrigin),
          styles: sameOriginAssets(facts.stylesheets, finalOrigin),
        }
      : null;

  const data = {
    status,
    fetchError,
    contentType: result.contentType,
    finalUrl: result.finalUrl,
    redirectChain,
    robotsBlocked: false,
    canonical,
    robotsMeta: facts?.robotsMeta ?? null,
    xRobotsTag: xRobots.raw,
    noindex,
    indexable,
    title,
    metaDescription: facts?.metaDescription ?? null,
    h1: facts?.h1[0] ?? null,
    headings: json(facts ? { h1: facts.h1, h2: facts.h2 } : null),
    lang: facts?.lang ?? null,
    hreflang: json(facts ? facts.hreflang : null),
    schemaTypes: facts?.jsonLd.types ?? [],
    schemaErrors: json(facts ? facts.jsonLd.errors : null),
    openGraph: json(facts ? facts.openGraph : null),
    assets: json(assets),
    wordCount: facts?.wordCount ?? null,
    textHash,
    textSimhash: facts?.textSimhash ?? null,
    contentHash: textHash,
    imagesNoAlt: facts?.imagesNoAlt ?? 0,
    bytes: facts?.bytes ?? result.body?.length ?? null,
    ttfbMs: result.firstByteMs,
    renderRisk: facts?.renderRisk ?? false,
    mixedContent: facts?.mixedContent.length ?? 0,
    etag: result.etag,
    lastModified: result.lastModified,
    issues,
    previous: json(previous),
    ...(status === 200 && indexable
      ? {
          lastGood: {
            title,
            h1: facts?.h1[0] ?? null,
            at: ctx.now.toISOString(),
          },
        }
      : {}),
    ...crawlMarker(input),
    lastCrawledAt: ctx.now,
    ...(contentChanged ? { lastChangedAt: ctx.now } : {}),
    goneAt: null,
  };

  await ctx.guard();
  const page = await prisma.seoPage.upsert({
    where,
    create: {
      ...baseCreate(ctx, input),
      ...data,
      lastCrawlId: input.crawlId,
    },
    update: data,
  });

  let links: LinkRow[] = [];
  if (facts) {
    links = pageLinks(ctx, facts, input.urlHash);
    await prisma.$transaction([
      prisma.seoLink.deleteMany({ where: { fromPageId: page.id } }),
      prisma.seoLink.createMany({
        data: links.map((link) => ({
          siteId: ctx.site.id,
          projectId: ctx.projectId,
          fromPageId: page.id,
          ...link,
        })),
      }),
      prisma.seoPage.update({
        where: { id: page.id },
        data: { outlinks: links.length },
      }),
    ]);
  } else if (page.outlinks > 0 || knownBefore) {
    // Yanıt geldi ama artık HTML 200 değil: eski giden linkler geçersiz.
    await prisma.$transaction([
      prisma.seoLink.deleteMany({ where: { fromPageId: page.id } }),
      prisma.seoPage.update({ where: { id: page.id }, data: { outlinks: 0 } }),
    ]);
  }

  let originChanged = false;
  if (input.isHomepage && status !== null && status >= 200 && status < 300) {
    originChanged = await adoptOrigin(ctx, result.finalUrl);
  }

  return {
    pageId: page.id,
    links: links.filter((link) => !link.nofollow).map((link) => link.toUrl),
    criticalChanged,
    knownBefore,
    originChanged,
  };
}
