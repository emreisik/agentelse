import "server-only";

import { prisma } from "@/lib/prisma";
import type { SeoTarget } from "@/lib/module-flows/seo/state";
import type { SeoPromptQuery } from "@/lib/module-flows/seo/snippet";
import { GscFlags } from "@/lib/seo/flags";
import { addWeeks, dayKeyToDate, lastCompleteWeekStart } from "@/lib/seo/dates";
import { limitGoogleStrings } from "@/lib/seo/llm-budget";
import { normalizePageUrl } from "@/lib/seo/normalize";
import { pathOf } from "@/lib/seo/crawl-url";
import type { PageSnapshot } from "@/lib/seo/actions/types";
import {
  maskGooglePath,
  maskGoogleText,
} from "@/server/integrations/google/pii";
import {
  gscDataThrough,
  primaryGscLink,
  readTopPages,
} from "@/server/seo/store";
import {
  checkPage,
  pageCheckSite,
  readCrawledPage,
} from "@/server/seo/actions/page-check";
import type { ObservedPage } from "@/lib/seo/actions/verify-checks";

// SEO Manager'ın "Refresh a page" ve "Fix the snippet" kiplerinin hedef sayfası
// (docs/search-actions.md "SEO Manager"): hangi sayfalar seçilebilir, seçilen
// sayfanın kendi sitemizden okunan hali ve modele giden sorgu özeti. Sayfanın
// kendisi sitenin kendi verisidir; Google verisi yalnız sorgu özeti ve sayısıdır
// ve hiçbir yerde sorgu metni olarak saklanmaz.

const PAGE_LIMIT = 30;
// Hedef sayfa seçicisi için ambar penceresi: son dört tam hafta.
const WINDOW_WEEKS = 4;
// Sorgu özeti okuması: modele en çok 10 gider, sayı için biraz daha geniş okunur.
const QUERY_READ_LIMIT = 100;
const PROMPT_QUERY_LIMIT = 10;

export type SeoTargetPage = {
  url: string;
  path: string;
  clicks: number | null;
  impressions: number | null;
  source: "SEARCH" | "SITE";
};

// Maskelenmiş (kişisel veri ya da kimlik benzeri parça içeren) adresler
// seçiciye hiç girmez.
function isCleanUrl(url: string, path: string): boolean {
  if (url.includes("[") || path.includes("[")) return false;
  return maskGooglePath(path) === path;
}

// Ambarın son dört tam haftası; ambar boşsa null.
async function recentWeeks(
  linkId: string,
): Promise<{ from: string; to: string } | null> {
  const through = await gscDataThrough(linkId);
  if (!through.finalThrough) return null;
  const to = lastCompleteWeekStart(through.finalThrough);
  return { from: addWeeks(to, -(WINDOW_WEEKS - 1)), to };
}

async function searchPages(projectId: string): Promise<SeoTargetPage[]> {
  if (!GscFlags.sync()) return [];
  const link = await primaryGscLink(projectId);
  if (!link) return [];
  const weeks = await recentWeeks(link.id);
  if (!weeks) return [];
  const rows = await readTopPages(link.id, weeks, { limit: PAGE_LIMIT * 2 });
  const out: SeoTargetPage[] = [];
  for (const row of rows) {
    if (!row.url) continue;
    const path = pathOf(row.url);
    if (!isCleanUrl(row.url, path)) continue;
    out.push({
      url: row.url,
      path,
      clicks: row.clicks,
      impressions: row.impressions,
      source: "SEARCH",
    });
    if (out.length >= PAGE_LIMIT) break;
  }
  return out;
}

// Ambar yoksa ya da boşsa: kendi tarayıcımızın bildiği, yaşayan ve indekslenebilir
// sayfalar (kısa yol önce: ana sayfa ve üst sayfalar).
async function sitePages(projectId: string): Promise<SeoTargetPage[]> {
  const site = await pageCheckSite(projectId);
  if (!site) return [];
  const rows = await prisma.seoPage.findMany({
    where: {
      siteId: site.siteId,
      goneAt: null,
      status: 200,
      indexable: true,
    },
    orderBy: [{ depth: "asc" }, { inlinks: "desc" }, { path: "asc" }],
    take: PAGE_LIMIT * 2,
    select: { url: true, path: true },
  });
  const out: SeoTargetPage[] = [];
  for (const row of rows) {
    if (!isCleanUrl(row.url, row.path)) continue;
    out.push({
      url: row.url,
      path: row.path,
      clicks: null,
      impressions: null,
      source: "SITE",
    });
    if (out.length >= PAGE_LIMIT) break;
  }
  return out;
}

// `now` yalnız imza uyumu içindir: pencere ambarın kendi veri tarihinden gelir.
export async function listTargetPages(
  projectId: string,
  now: Date = new Date(),
): Promise<SeoTargetPage[]> {
  void now;
  const fromSearch = await searchPages(projectId).catch(() => []);
  if (fromSearch.length > 0) return fromSearch;
  return sitePages(projectId).catch(() => []);
}

// ---- hedef sayfanın okunması ----------------------------------------------------

export type ReadTargetResult =
  | {
      ok: true;
      target: SeoTarget;
      baseline: PageSnapshot;
      text: string | null;
    }
  | { ok: false; message: string };

const TARGET_COPY = {
  noSite: "Your website isn't set up yet. Verify it first, then pick a page.",
  outOfScope: "That address isn't on your verified site.",
  robots: "Your site's robots.txt doesn't let us read that page.",
  failed: "Couldn't read that page. Try again in a moment.",
  badUrl: "That isn't a page address.",
} as const;

function snapshotOf(page: PageSnapshot | ObservedPage): PageSnapshot {
  return {
    url: page.url,
    status: page.status,
    title: page.title,
    metaDescription: page.metaDescription,
    h1: page.h1,
    h2: page.h2.slice(0, 20),
    canonical: page.canonical,
    noindex: page.noindex,
    indexable: page.indexable,
    wordCount: page.wordCount,
    textHash: page.textHash,
    schemaTypes: page.schemaTypes,
    schemaErrors: page.schemaErrors,
    fetchedAt: page.fetchedAt,
    source: page.source,
  };
}

function targetOf(snapshot: PageSnapshot, queryCount: number): SeoTarget {
  return {
    url: snapshot.url,
    path: pathOf(snapshot.url),
    title: snapshot.title,
    metaDescription: snapshot.metaDescription,
    h1: snapshot.h1,
    h2: snapshot.h2,
    wordCount: snapshot.wordCount,
    textHash: snapshot.textHash,
    fetchedAt: snapshot.fetchedAt,
    queryCount,
  };
}

export async function readTarget(
  projectId: string,
  url: string,
  options: { textChars?: number; now?: Date } = {},
): Promise<ReadTargetResult> {
  if (!normalizePageUrl(url)) return { ok: false, message: TARGET_COPY.badUrl };
  const site = await pageCheckSite(projectId);
  if (!site) return { ok: false, message: TARGET_COPY.noSite };

  const checked = await checkPage(site, url, {
    ...(options.textChars !== undefined
      ? { textChars: options.textChars }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  if (checked.ok) {
    const baseline = snapshotOf(checked.page);
    const queries = await pageQueryRows(projectId, url, options.now);
    return {
      ok: true,
      target: targetOf(baseline, queries.length),
      baseline,
      text: checked.text,
    };
  }
  if (checked.reason === "OUT_OF_SCOPE") {
    return { ok: false, message: TARGET_COPY.outOfScope };
  }
  if (checked.reason === "ROBOTS") {
    return { ok: false, message: TARGET_COPY.robots };
  }

  // Getirme başarısız: haftalık tarayıcının son kaydı varsa onunla devam edilir
  // (metin yoktur; yazı modeli sayfa metnini görmez).
  const crawled = await readCrawledPage(site.siteId, url).catch(() => null);
  if (!crawled) return { ok: false, message: TARGET_COPY.failed };
  const queries = await pageQueryRows(projectId, url, options.now);
  return {
    ok: true,
    target: targetOf(crawled.snapshot, queries.length),
    baseline: crawled.snapshot,
    text: null,
  };
}

// ---- sayfanın sorguları -----------------------------------------------------------

type QueryRow = {
  text: string;
  impressions: number;
  clicks: number;
  position: number | null;
};

// Sayfanın son dört tam haftadaki sorguları, gösterim sırasıyla. Yalnız ambar
// (Google'a çağrı yok); bağ ya da sayfa yoksa boş.
async function pageQueryRows(
  projectId: string,
  url: string,
  now?: Date,
): Promise<QueryRow[]> {
  void now;
  const normalized = normalizePageUrl(url);
  if (!normalized) return [];
  const link = await primaryGscLink(projectId);
  if (!link) return [];
  const weeks = await recentWeeks(link.id);
  if (!weeks) return [];
  const page = await prisma.gscPage.findUnique({
    where: { linkId_urlHash: { linkId: link.id, urlHash: normalized.hash } },
    select: { id: true },
  });
  if (!page) return [];

  const grouped = await prisma.gscWeeklyQueryPage.groupBy({
    by: ["queryId"],
    where: {
      linkId: link.id,
      pageId: page.id,
      weekStart: {
        gte: dayKeyToDate(weeks.from),
        lte: dayKeyToDate(weeks.to),
      },
    },
    _sum: { clicks: true, impressions: true, positionWeighted: true },
    orderBy: { _sum: { impressions: "desc" } },
    take: QUERY_READ_LIMIT,
  });
  if (grouped.length === 0) return [];

  const queries = await prisma.gscQuery.findMany({
    where: { id: { in: grouped.map((row) => row.queryId) } },
    select: { id: true, text: true },
  });
  const textById = new Map(queries.map((query) => [query.id, query.text]));
  const out: QueryRow[] = [];
  for (const row of grouped) {
    const text = textById.get(row.queryId);
    if (!text) continue;
    const impressions = row._sum.impressions ?? 0;
    const weighted = row._sum.positionWeighted ?? 0;
    out.push({
      text,
      impressions,
      clicks: row._sum.clicks ?? 0,
      position: impressions > 0 ? weighted / impressions : null,
    });
  }
  return out;
}

// Modele giden sorgu özeti: maskelenmiş, en çok 10 farklı dizgi (llm-budget).
// Metinler hiçbir yere yazılmaz; çağıran onları yalnız istemde kullanır.
export async function pageQueriesForPrompt(
  projectId: string,
  url: string,
  now?: Date,
): Promise<SeoPromptQuery[]> {
  const rows = await pageQueryRows(projectId, url, now);
  const masked: SeoPromptQuery[] = [];
  for (const row of rows) {
    const text = maskGoogleText(row.text);
    if (!text) continue;
    masked.push({
      text,
      impressions: row.impressions,
      clicks: row.clicks,
      position: row.position,
    });
  }
  return limitGoogleStrings(masked, (row) => [row.text], {
    limit: PROMPT_QUERY_LIMIT,
  }).items;
}
