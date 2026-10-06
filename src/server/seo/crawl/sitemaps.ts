import "server-only";

import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { Prisma } from "@prisma/client";

import {
  SITEMAP_EVERY_MS,
  SITEMAP_MAX_BYTES,
  SITEMAP_MAX_FILES,
  SITEMAP_MAX_STORED_URLS,
} from "@/lib/seo/audit-constants";
import {
  crawlHostAllowed,
  crawlUrlHash,
  inScope,
  normalizeCrawlUrl,
  pathOf,
} from "@/lib/seo/crawl-url";
import {
  isGzipBytes,
  parseSitemap,
  type ParsedSitemap,
} from "@/lib/seo/sitemap-parser";
import { prisma } from "@/lib/prisma";
import {
  parseSitemapSummaries,
  type SitemapSummary,
} from "@/server/seo/site/sites";

import { siteFetch } from "./fetcher";
import { hostScope, robotsGate, type SiteRunContext } from "./robots";

// Kendi sitemap okumamız (docs/search-health.md "Sitemap ve robots"):
// kaynaklar robots.txt Sitemap satırları, Search Console'a gönderilmiş
// sitemap'ler (GscSitemap.path), ikisi de yoksa /sitemap.xml. Dizinlerin
// çocukları bir kat derinliğe kadar okunur (en çok 20 dosya). Köken alan
// adındaki kapsam içi adresler SeoPage envanterine yazılır (en çok 10.000).
// İlk eksiksiz geçiş taban çizgisidir: o geçişteki adresler "yeni" sayılmaz
// (sitemapFirstSeenAt null), yalnız sonradan eklenenler tarih alır.

const UPSERT_CHUNK = 500;
const PARTIAL_RETRY_MS = 15 * 60_000;

type Source = SitemapSummary["source"];
type Collected = { url: string; urlHash: string; lastmod: Date | null };

function timestamp(value: Date | null): Prisma.Sql {
  return Prisma.sql`(${value ? value.toISOString() : null}::timestamptz AT TIME ZONE 'UTC')`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function lastmodDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function decodeBody(body: Buffer): {
  text: string | null;
  error: string | null;
} {
  if (!isGzipBytes(body)) return { text: body.toString("utf8"), error: null };
  try {
    return {
      text: gunzipSync(body, { maxOutputLength: SITEMAP_MAX_BYTES }).toString(
        "utf8",
      ),
      error: null,
    };
  } catch {
    return {
      text: null,
      error: "Compressed sitemap could not be read or is over 10 MB",
    };
  }
}

function isOk(summary: SitemapSummary): boolean {
  return (
    summary.status !== null &&
    summary.status >= 200 &&
    summary.status < 300 &&
    (summary.kind === "urlset" ||
      summary.kind === "sitemapindex" ||
      summary.kind === "text")
  );
}

export function sitemapSummaryOk(summary: SitemapSummary): boolean {
  return isOk(summary);
}

async function sourceUrls(
  ctx: SiteRunContext,
): Promise<{ url: string; source: Source }[]> {
  const list: { url: string; source: Source }[] = [];
  const seen = new Set<string>();
  const add = (raw: string, source: Source) => {
    const url = normalizeCrawlUrl(raw);
    if (!url || !crawlHostAllowed(url, ctx.originHost) || seen.has(url)) return;
    seen.add(url);
    list.push({ url, source });
  };
  for (const url of ctx.robots?.sitemaps ?? []) add(url, "ROBOTS");
  if (ctx.linkId) {
    const rows = await prisma.gscSitemap.findMany({
      where: { linkId: ctx.linkId },
      orderBy: { path: "asc" },
      select: { path: true },
    });
    for (const row of rows) add(row.path, "GSC");
  }
  if (list.length === 0) add(`${ctx.origin}/sitemap.xml`, "DEFAULT");
  return list;
}

type FetchedSitemap = { summary: SitemapSummary; parsed: ParsedSitemap | null };

async function fetchSitemap(
  ctx: SiteRunContext,
  url: string,
  source: Source,
): Promise<FetchedSitemap> {
  const result = await siteFetch(
    url,
    {
      scope: hostScope(ctx, hostOf(url) ?? ctx.originHost),
      originHost: ctx.originHost,
      accept: "any",
      maxBytes: SITEMAP_MAX_BYTES,
      isAllowed: robotsGate(ctx),
    },
    ctx.deps,
  );
  const summary: SitemapSummary = {
    url,
    source,
    status: result.status,
    kind: "invalid",
    urlCount: 0,
    inScope: 0,
    errors: [],
    fetchedAt: ctx.now.toISOString(),
  };
  if (result.blockedByRobots || result.blockedHop) {
    return { summary: { ...summary, kind: "blocked" }, parsed: null };
  }
  if (result.errorKind || result.status === null) {
    return { summary: { ...summary, kind: "unreachable" }, parsed: null };
  }
  if (result.status < 200 || result.status >= 300 || !result.body) {
    summary.errors.push(`The sitemap answered with HTTP ${result.status}`);
    return { summary, parsed: null };
  }
  if (result.truncated) {
    summary.errors.push("The sitemap is larger than 10 MB");
    return { summary, parsed: null };
  }
  const decoded = decodeBody(result.body);
  if (decoded.text === null) {
    summary.errors.push(decoded.error ?? "The sitemap could not be read");
    return { summary, parsed: null };
  }
  const parsed = parseSitemap(decoded.text);
  summary.kind = parsed.kind;
  summary.errors.push(...parsed.errors.slice(0, 10));
  summary.urlCount =
    parsed.kind === "sitemapindex"
      ? parsed.sitemaps.length
      : parsed.urls.length;
  return { summary, parsed };
}

async function upsertInventory(
  ctx: SiteRunContext,
  rows: readonly Collected[],
  baselineSet: boolean,
): Promise<void> {
  const at = timestamp(ctx.now);
  for (let index = 0; index < rows.length; index += UPSERT_CHUNK) {
    const part = rows.slice(index, index + UPSERT_CHUNK);
    const values = part.map(
      (row) =>
        Prisma.sql`(${randomUUID()}, ${ctx.site.id}, ${ctx.workspaceId}, ${ctx.projectId}, ${row.url}, ${row.urlHash}, ${pathOf(row.url)}, 'SITEMAP', true, ${timestamp(row.lastmod)}, ${baselineSet ? at : timestamp(null)}, ${at}, ${at})`,
    );
    await ctx.guard();
    await prisma.$executeRaw`
      INSERT INTO "SeoPage" ("id", "siteId", "workspaceId", "projectId", "url", "urlHash", "path", "discoveredVia", "inSitemap", "sitemapLastmod", "sitemapFirstSeenAt", "sitemapLastSeenAt", "firstSeenAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("siteId", "urlHash") DO UPDATE SET
        "sitemapFirstSeenAt" = CASE
          WHEN "SeoPage"."inSitemap" = false AND "SeoPage"."sitemapFirstSeenAt" IS NULL AND ${baselineSet}::boolean
          THEN EXCLUDED."sitemapLastSeenAt"
          ELSE "SeoPage"."sitemapFirstSeenAt"
        END,
        "inSitemap" = true,
        "sitemapLastSeenAt" = EXCLUDED."sitemapLastSeenAt",
        "sitemapLastmod" = EXCLUDED."sitemapLastmod"
    `;
  }
}

function summariesChanged(
  previous: readonly SitemapSummary[],
  next: readonly SitemapSummary[],
): boolean {
  if (previous.length !== next.length) return true;
  const key = (row: SitemapSummary) =>
    `${row.url}|${row.status}|${row.kind}|${row.urlCount}|${row.inScope}|${row.errors.length}`;
  const before = new Set(previous.map(key));
  return next.some((row) => !before.has(key(row)));
}

// Sitemap'leri okur, envanteri ve SeoSite.sitemaps özetini yazar.
export async function refreshSitemaps(
  ctx: SiteRunContext,
): Promise<{ changed: boolean; summaries: SitemapSummary[] }> {
  const sources = await sourceUrls(ctx);
  const summaries: SitemapSummary[] = [];
  const collected = new Map<string, Collected>();
  let overflow = 0;
  const visited = new Set<string>();

  const collect = (summary: SitemapSummary, parsed: ParsedSitemap) => {
    for (const entry of parsed.urls) {
      const url = normalizeCrawlUrl(entry.loc);
      if (!url || !inScope(url, ctx.scope) || hostOf(url) !== ctx.originHost)
        continue;
      summary.inScope += 1;
      const urlHash = crawlUrlHash(url);
      if (collected.has(urlHash)) continue;
      if (collected.size >= SITEMAP_MAX_STORED_URLS) {
        overflow += 1;
        continue;
      }
      collected.set(urlHash, {
        url,
        urlHash,
        lastmod: lastmodDate(entry.lastmod),
      });
    }
  };

  // Süre biterse geçiş yarım kalır (sonraki koşu yeniden okur); dosya
  // sınırına takılan geçiş eksik sayılır (envanterden adres düşürülmez).
  let outOfTime = false;
  let capped = false;
  const canFetch = () => {
    if (ctx.remaining() <= 0) {
      outOfTime = true;
      return false;
    }
    if (visited.size >= SITEMAP_MAX_FILES) {
      capped = true;
      return false;
    }
    return true;
  };

  for (const source of sources) {
    if (visited.has(source.url)) continue;
    if (!canFetch()) break;
    visited.add(source.url);
    const fetched = await fetchSitemap(ctx, source.url, source.source);
    summaries.push(fetched.summary);
    if (!fetched.parsed) continue;
    if (fetched.parsed.kind !== "sitemapindex") {
      collect(fetched.summary, fetched.parsed);
      continue;
    }
    // Dizin: çocuklar bir kat derinliğe kadar (çocuk dizinler açılmaz).
    for (const child of fetched.parsed.sitemaps) {
      const url = normalizeCrawlUrl(child.loc);
      if (!url || !crawlHostAllowed(url, ctx.originHost) || visited.has(url))
        continue;
      if (!canFetch()) break;
      visited.add(url);
      const nested = await fetchSitemap(ctx, url, "INDEX");
      summaries.push(nested.summary);
      if (nested.parsed && nested.parsed.kind !== "sitemapindex") {
        collect(nested.summary, nested.parsed);
      }
    }
    if (outOfTime) break;
  }

  const baselineSet = ctx.site.sitemapBaselineAt !== null;
  const rows = [...collected.values()];
  if (rows.length > 0) await upsertInventory(ctx, rows, baselineSet);

  // Her dosya sorunsuz okunduysa: görülmeyenler sitemap dışı, ilk geçiş taban.
  const complete =
    summaries.length > 0 &&
    !outOfTime &&
    !capped &&
    summaries.every(isOk) &&
    overflow === 0;
  await ctx.guard();
  if (complete) {
    await prisma.seoPage.updateMany({
      where: {
        siteId: ctx.site.id,
        inSitemap: true,
        OR: [
          { sitemapLastSeenAt: null },
          { sitemapLastSeenAt: { lt: ctx.now } },
        ],
      },
      data: { inSitemap: false },
    });
  }
  if (outOfTime) {
    // Yarım geçiş özetin yerine geçmez; 15 dk sonra yeniden denenir (diğer
    // aşamalar bu arada sürebilsin diye hemen değil).
    const retryAt = new Date(
      ctx.now.getTime() - SITEMAP_EVERY_MS + PARTIAL_RETRY_MS,
    );
    await prisma.seoSite.update({
      where: { id: ctx.site.id },
      data: { sitemapsCheckedAt: retryAt },
    });
    ctx.site = { ...ctx.site, sitemapsCheckedAt: retryAt };
    return { changed: false, summaries };
  }
  const previous = parseSitemapSummaries(ctx.site.sitemaps);
  const changed = summariesChanged(previous, summaries);
  const updated = await prisma.seoSite.update({
    where: { id: ctx.site.id },
    data: {
      sitemaps: summaries,
      sitemapsCheckedAt: ctx.now,
      ...(complete && !baselineSet ? { sitemapBaselineAt: ctx.now } : {}),
    },
  });
  ctx.site = {
    ...ctx.site,
    sitemaps: updated.sitemaps,
    sitemapsCheckedAt: updated.sitemapsCheckedAt,
    sitemapBaselineAt: updated.sitemapBaselineAt,
  };
  return { changed, summaries };
}
