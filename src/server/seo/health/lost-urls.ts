import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  crawlUrlHash,
  gscPageKey,
  normalizeCrawlUrl,
  pathOf,
} from "@/lib/seo/crawl-url";
import { addWeeks, lastCompleteWeekStart, weekEndOf } from "@/lib/seo/dates";
import { seoMockMode } from "@/lib/seo/health-flags";
import {
  buildRedirectMap,
  isUnrelatedRedirect,
  redirectMapText,
  type LostReason,
  type LostUrl,
  type RedirectTarget,
} from "@/lib/seo/redirect-map";
import { keyPagesFor } from "@/server/seo/site/key-pages";
import {
  gscDataThrough,
  primaryGscLink,
  readGscDays,
  readTopPages,
} from "@/server/seo/store";

// SH27 kaybolan URL'ler ve 301 haritası (docs/search-health.md "Kontroller"):
// son 13 tam haftada en az 3 tık alan GSC sayfaları (en çok 200) kendi
// taramamızın SeoPage satırlarıyla eşleşir (gscPageKey eşitliği, JS'te).
// 404/410/5xx, noindex ya da alakasız bir sayfaya yönlenen sayfa
// "kaybolmuş"tur; her biri için indekslenebilir 200 sayfalar (iç linke göre en
// çok 2.000) arasından en yakın hedef önerilir. Rapor istek anında hesaplanır
// ve hiç saklanmaz (Google verisi Gsc* tabloları ile GSC uyarılarında kalır).

const VALUABLE_WEEKS = 13;
const VALUABLE_LIMIT = 200;
const VALUABLE_MIN_CLICKS = 3;
const TARGET_LIMIT = 2_000;
const PAGE_SCAN_LIMIT = 20_000;
const CRITICAL_SHARE = 0.1;

export type LostUrlReport = {
  rows: {
    from: string;
    fromPath: string;
    to: string | null;
    reason: LostReason;
    score: number;
    keyPage: boolean;
  }[];
  text: string;
  lostClicksShare: number | null;
  critical: boolean;
  checkedThrough: string | null;
};

type PageRow = {
  url: string;
  status: number | null;
  noindex: boolean;
  finalUrl: string | null;
  title: string | null;
  redirectChain: Prisma.JsonValue;
  lastGood: Prisma.JsonValue;
};

function hopCount(value: Prisma.JsonValue): number {
  return Array.isArray(value) ? value.length : 0;
}

function lastGoodTitle(value: Prisma.JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = (value as Record<string, unknown>).title;
  return typeof title === "string" && title ? title : null;
}

function lostReason(
  page: PageRow,
  titleOf: (url: string) => string | null,
): LostReason | null {
  const status = page.status;
  if (status === 404) return "NOT_FOUND";
  if (status === 410) return "GONE";
  if (status !== null && status >= 500) return "SERVER_ERROR";
  const redirected =
    hopCount(page.redirectChain) > 1 ||
    (page.finalUrl !== null &&
      normalizeCrawlUrl(page.finalUrl) !== normalizeCrawlUrl(page.url));
  if (redirected && page.finalUrl) {
    return isUnrelatedRedirect({
      fromUrl: page.url,
      fromTitle: lastGoodTitle(page.lastGood) ?? page.title,
      toUrl: page.finalUrl,
      toTitle: titleOf(page.finalUrl),
    });
  }
  if (status === 200 && page.noindex) return "NOINDEX";
  return null;
}

export async function buildLostUrlReport(
  projectId: string,
  now: Date = new Date(),
): Promise<LostUrlReport | null> {
  const site = await prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
    select: {
      id: true,
      projectId: true,
      origin: true,
      scope: true,
      lastFullCrawlAt: true,
    },
  });
  if (!site?.lastFullCrawlAt) return null;
  const link = await primaryGscLink(projectId);
  if (!link) return null;

  const through = await gscDataThrough(link.id);
  if (!through.finalThrough) {
    return {
      rows: [],
      text: "",
      lostClicksShare: null,
      critical: false,
      checkedThrough: null,
    };
  }
  const lastWeek = lastCompleteWeekStart(through.finalThrough);
  const firstWeek = addWeeks(lastWeek, -(VALUABLE_WEEKS - 1));
  const [top, days, pages, keyPages] = await Promise.all([
    readTopPages(
      link.id,
      { from: firstWeek, to: lastWeek },
      { limit: VALUABLE_LIMIT },
    ),
    readGscDays(link.id, firstWeek, weekEndOf(lastWeek)),
    prisma.seoPage.findMany({
      where: { siteId: site.id, goneAt: null },
      select: {
        url: true,
        status: true,
        noindex: true,
        indexable: true,
        finalUrl: true,
        title: true,
        h1: true,
        inlinks: true,
        redirectChain: true,
        lastGood: true,
      },
      orderBy: { inlinks: "desc" },
      take: PAGE_SCAN_LIMIT,
    }),
    keyPagesFor(site, now),
  ]);

  const byKey = new Map<string, (typeof pages)[number]>();
  const titleByUrl = new Map<string, string | null>();
  for (const page of pages) {
    const key = gscPageKey(page.url);
    if (key && !byKey.has(key)) byKey.set(key, page);
    const normalized = normalizeCrawlUrl(page.url);
    if (normalized) titleByUrl.set(normalized, page.title);
  }
  const titleOf = (url: string) => {
    const normalized = normalizeCrawlUrl(url);
    return normalized ? (titleByUrl.get(normalized) ?? null) : null;
  };
  const keyHashes = new Set(keyPages.map((page) => page.urlHash));

  const lost: LostUrl[] = [];
  const keyByUrl = new Map<string, boolean>();
  for (const row of top) {
    if (row.clicks < VALUABLE_MIN_CLICKS || !row.url || row.url.includes("[")) {
      continue;
    }
    const page = byKey.get(row.url);
    if (!page) continue;
    const reason = lostReason(page, titleOf);
    if (!reason) continue;
    lost.push({
      url: page.url,
      title: lastGoodTitle(page.lastGood) ?? page.title,
      clicks: row.clicks,
      reason,
    });
    const normalized = normalizeCrawlUrl(page.url);
    keyByUrl.set(
      page.url,
      normalized !== null && keyHashes.has(crawlUrlHash(normalized)),
    );
  }

  const targets: RedirectTarget[] = pages
    .filter((page) => page.status === 200 && page.indexable === true)
    .slice(0, TARGET_LIMIT)
    .map((page) => ({ url: page.url, title: page.title, h1: page.h1 }));
  const map = buildRedirectMap(lost, targets);
  const reasonByUrl = new Map(lost.map((row) => [row.url, row]));

  const totalClicks = days.reduce((sum, day) => sum + day.clicks, 0);
  const lostClicks = lost.reduce((sum, row) => sum + row.clicks, 0);
  const lostClicksShare = totalClicks > 0 ? lostClicks / totalClicks : null;
  const rows = map.flatMap((entry) => {
    const source = reasonByUrl.get(entry.from);
    if (!source) return [];
    return [
      {
        from: entry.from,
        fromPath: pathOf(entry.from),
        to: entry.to,
        reason: source.reason,
        score: entry.score,
        keyPage: keyByUrl.get(entry.from) ?? false,
      },
    ];
  });
  return {
    rows,
    text: redirectMapText(map),
    lostClicksShare,
    critical:
      rows.some((row) => row.keyPage) ||
      (lostClicksShare ?? 0) > CRITICAL_SHARE,
    checkedThrough: through.finalThrough,
  };
}
