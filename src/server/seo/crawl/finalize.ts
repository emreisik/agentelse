import "server-only";

import { Prisma } from "@prisma/client";

import { auditSite, type SiteAuditPage } from "@/lib/seo/technical-audit";
import { prisma } from "@/lib/prisma";
import { parseSitemapSummaries } from "@/server/seo/site/sites";

import { parseIssues } from "./pages";
import type { SiteRunContext } from "./robots";
import { nextLocalHour, NIGHT_START_HOUR } from "./schedule";
import { sitemapSummaryOk } from "./sitemaps";

// Tam taramanın kapanışı (docs/search-health.md "Tarayıcı"): kaybolan
// sayfalar (goneAt), iç link sayıları (inlinks, tek GROUP BY), ana sayfadan
// BFS derinliği, site düzeyi denetim (auditSite) ve bir sonraki haftalık
// taramanın zamanı. DONE değilse (PARTIAL) goneAt yazılmaz ve TA13
// (yetim sayfa) değerlendirilmez.

export type CrawlStats = {
  statuses: Record<string, number>;
  newUrls: number;
  redirected: number;
  blockedByRobots: number;
  outOfScope: number;
  otherHosts: number;
  throttled: number;
  knownNowRedirect: number;
  knownRefetched: number;
  droppedFrontier: number;
  longUrls: number;
};

const COUNTER_KEYS = [
  "newUrls",
  "redirected",
  "blockedByRobots",
  "outOfScope",
  "otherHosts",
  "throttled",
  "knownNowRedirect",
  "knownRefetched",
  "droppedFrontier",
  "longUrls",
] as const;

export function emptyCrawlStats(): CrawlStats {
  return {
    statuses: {},
    newUrls: 0,
    redirected: 0,
    blockedByRobots: 0,
    outOfScope: 0,
    otherHosts: 0,
    throttled: 0,
    knownNowRedirect: 0,
    knownRefetched: 0,
    droppedFrontier: 0,
    longUrls: 0,
  };
}

export function parseCrawlStats(value: unknown): CrawlStats {
  const stats = emptyCrawlStats();
  if (!value || typeof value !== "object" || Array.isArray(value)) return stats;
  const record = value as Record<string, unknown>;
  for (const key of COUNTER_KEYS) {
    const count = record[key];
    if (typeof count === "number" && Number.isFinite(count)) stats[key] = count;
  }
  const statuses = record.statuses;
  if (statuses && typeof statuses === "object" && !Array.isArray(statuses)) {
    for (const [code, count] of Object.entries(statuses)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        stats.statuses[code] = count;
      }
    }
  }
  return stats;
}

const VALUES_CHUNK = 500;
const ISSUE_CHUNK = 200;
const WEEK_MS = 7 * 86_400_000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    parts.push(items.slice(index, index + size));
  }
  return parts;
}

function timestamp(value: Date): Prisma.Sql {
  return Prisma.sql`(${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

// Bu DONE taramanın ne getirdiği, ne sitemap'te ne de getirilen bir sayfadan
// linkli bulduğu, daha önce getirilmiş sayfalar kayboldu sayılır; görülenler
// geri gelir.
async function markGone(ctx: SiteRunContext, crawlId: string): Promise<void> {
  const siteId = ctx.site.id;
  const at = timestamp(ctx.now);
  await ctx.guard();
  await prisma.$executeRaw`
    UPDATE "SeoPage" AS p
       SET "goneAt" = ${at}
     WHERE p."siteId" = ${siteId}
       AND p."goneAt" IS NULL
       AND p."lastCrawledAt" IS NOT NULL
       AND p."lastCrawlId" IS DISTINCT FROM ${crawlId}
       AND p."inSitemap" = false
       AND NOT EXISTS (
         SELECT 1 FROM "SeoLink" l
           JOIN "SeoPage" f ON f."id" = l."fromPageId"
          WHERE l."siteId" = ${siteId}
            AND l."toUrlHash" = p."urlHash"
            AND f."lastCrawlId" = ${crawlId}
       )
  `;
  await prisma.$executeRaw`
    UPDATE "SeoPage" AS p
       SET "goneAt" = NULL
     WHERE p."siteId" = ${siteId}
       AND p."goneAt" IS NOT NULL
       AND (
         p."lastCrawlId" = ${crawlId}
         OR p."inSitemap" = true
         OR EXISTS (
           SELECT 1 FROM "SeoLink" l
             JOIN "SeoPage" f ON f."id" = l."fromPageId"
            WHERE l."siteId" = ${siteId}
              AND l."toUrlHash" = p."urlHash"
              AND f."lastCrawlId" = ${crawlId}
         )
       )
  `;
}

// İç link sayısı: kaybolmamış sayfalardan gelen farklı kaynak sayfa sayısı
// (kendine link sayılmaz).
async function recomputeInlinks(ctx: SiteRunContext): Promise<void> {
  const siteId = ctx.site.id;
  const rows = await prisma.$queryRaw<{ hash: string; count: number }[]>`
    SELECT l."toUrlHash" AS "hash", COUNT(DISTINCT l."fromPageId")::int AS "count"
      FROM "SeoLink" l
      JOIN "SeoPage" f ON f."id" = l."fromPageId"
     WHERE l."siteId" = ${siteId}
       AND f."goneAt" IS NULL
       AND f."urlHash" <> l."toUrlHash"
     GROUP BY l."toUrlHash"
  `;
  await ctx.guard();
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE "SeoPage" SET "inlinks" = 0 WHERE "siteId" = ${siteId} AND "inlinks" <> 0`,
    ...chunks(rows, VALUES_CHUNK).map((part) => {
      const values = part.map(
        (row) => Prisma.sql`(${row.hash}::text, ${Number(row.count)}::int)`,
      );
      return prisma.$executeRaw`
        UPDATE "SeoPage" AS p
           SET "inlinks" = v."count"
          FROM (VALUES ${Prisma.join(values)}) AS v("hash", "count")
         WHERE p."siteId" = ${siteId}
           AND p."urlHash" = v."hash"
      `;
    }),
  ]);
}

// Ana sayfadan BFS (JS'te): ulaşılamayan sayfaların derinliği null.
async function recomputeDepth(
  ctx: SiteRunContext,
  homeHash: string,
): Promise<void> {
  const siteId = ctx.site.id;
  const [pages, links] = await Promise.all([
    prisma.seoPage.findMany({
      where: { siteId, goneAt: null },
      select: { id: true, urlHash: true },
    }),
    prisma.seoLink.findMany({
      where: { siteId },
      select: { fromPageId: true, toUrlHash: true },
    }),
  ]);
  const byHash = new Map(pages.map((page) => [page.urlHash, page.id]));
  const outgoing = new Map<string, string[]>();
  for (const link of links) {
    const list = outgoing.get(link.fromPageId);
    if (list) list.push(link.toUrlHash);
    else outgoing.set(link.fromPageId, [link.toUrlHash]);
  }
  const depth = new Map<string, number>();
  const home = byHash.get(homeHash);
  if (home) {
    depth.set(home, 0);
    const queue = [home];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]!;
      const level = depth.get(id) ?? 0;
      for (const hash of outgoing.get(id) ?? []) {
        const target = byHash.get(hash);
        if (!target || depth.has(target)) continue;
        depth.set(target, level + 1);
        queue.push(target);
      }
    }
  }
  const entries = [...depth.entries()];
  await ctx.guard();
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE "SeoPage" SET "depth" = NULL WHERE "siteId" = ${siteId} AND "depth" IS NOT NULL`,
    ...chunks(entries, VALUES_CHUNK).map((part) => {
      const values = part.map(
        ([id, level]) => Prisma.sql`(${id}::text, ${level}::int)`,
      );
      return prisma.$executeRaw`
        UPDATE "SeoPage" AS p
           SET "depth" = v."depth"
          FROM (VALUES ${Prisma.join(values)}) AS v("id", "depth")
         WHERE p."id" = v."id"
           AND p."siteId" = ${siteId}
      `;
    }),
  ]);
}

function hreflangOf(value: unknown): { lang: string; href: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is { lang: string; href: string } =>
      !!item &&
      typeof item === "object" &&
      typeof (item as { lang?: unknown }).lang === "string" &&
      typeof (item as { href?: unknown }).href === "string",
  );
}

// Site düzeyi sorunlar (TA2, TA5, TA12, TA13, TA14, TA16, TA20, TA23, TA24)
// sayfa sorunlarıyla birleşip yazılır; yalnız değişen satırlar.
async function auditCrawledPages(
  ctx: SiteRunContext,
  options: {
    crawlComplete: boolean;
    homeHash: string;
    keyHashes: ReadonlySet<string>;
  },
): Promise<void> {
  const siteId = ctx.site.id;
  const rows = await prisma.seoPage.findMany({
    where: { siteId, goneAt: null, lastCrawledAt: { not: null } },
    select: {
      id: true,
      url: true,
      urlHash: true,
      status: true,
      indexable: true,
      title: true,
      metaDescription: true,
      textHash: true,
      textSimhash: true,
      wordCount: true,
      inlinks: true,
      depth: true,
      inSitemap: true,
      hreflang: true,
      issues: true,
    },
  });
  if (rows.length === 0) return;
  const ids = new Set(rows.map((row) => row.id));
  const links = (
    await prisma.seoLink.findMany({
      where: { siteId },
      select: { fromPageId: true, toUrlHash: true },
    })
  )
    .filter((link) => ids.has(link.fromPageId))
    .map((link) => ({ fromId: link.fromPageId, toUrlHash: link.toUrlHash }));
  const pages: SiteAuditPage[] = rows.map((row) => ({
    id: row.id,
    url: row.url,
    urlHash: row.urlHash,
    status: row.status,
    indexable: row.indexable ?? false,
    isHomepage: row.urlHash === options.homeHash,
    isKeyPage: options.keyHashes.has(row.urlHash),
    title: row.title,
    metaDescription: row.metaDescription,
    textHash: row.textHash,
    textSimhash: row.textSimhash,
    wordCount: row.wordCount,
    inlinks: row.inlinks,
    depth: row.depth,
    inSitemap: row.inSitemap,
    hreflang: hreflangOf(row.hreflang),
    issues: parseIssues(row.issues),
  }));
  const sitemapKnown = parseSitemapSummaries(ctx.site.sitemaps).some(
    sitemapSummaryOk,
  );
  const merged = auditSite(pages, links, {
    sitemapKnown,
    crawlComplete: options.crawlComplete,
  });
  const changed: { id: string; issues: string }[] = [];
  for (const page of pages) {
    const next = merged.get(page.id);
    if (!next) continue;
    const text = JSON.stringify(next);
    if (text !== JSON.stringify(page.issues))
      changed.push({ id: page.id, issues: text });
  }
  for (const part of chunks(changed, ISSUE_CHUNK)) {
    const values = part.map(
      (row) => Prisma.sql`(${row.id}::text, ${row.issues}::jsonb)`,
    );
    await ctx.guard();
    await prisma.$executeRaw`
      UPDATE "SeoPage" AS p
         SET "issues" = v."issues"
        FROM (VALUES ${Prisma.join(values)}) AS v("id", "issues")
       WHERE p."id" = v."id"
         AND p."siteId" = ${siteId}
    `;
  }
}

export async function finalizeFullCrawl(
  ctx: SiteRunContext,
  input: {
    crawlId: string;
    startedAt: Date;
    status: "DONE" | "PARTIAL";
    stats: CrawlStats;
    counters: { pagesFetched: number; notModified: number; errors: number };
    homeHash: string;
    keyHashes: ReadonlySet<string>;
  },
): Promise<void> {
  if (input.status === "DONE") await markGone(ctx, input.crawlId);
  await recomputeInlinks(ctx);
  await recomputeDepth(ctx, input.homeHash);
  await auditCrawledPages(ctx, {
    crawlComplete: input.status === "DONE",
    homeHash: input.homeHash,
    keyHashes: input.keyHashes,
  });
  const nextDue = nextLocalHour(
    new Date(input.startedAt.getTime() + WEEK_MS - 1),
    ctx.timezone,
    NIGHT_START_HOUR,
  );
  await ctx.guard();
  await prisma.$transaction([
    prisma.seoCrawl.update({
      where: { id: input.crawlId },
      data: {
        status: input.status,
        finishedAt: ctx.now,
        frontier: Prisma.DbNull,
        stats: input.stats,
        ...input.counters,
      },
    }),
    prisma.seoSite.update({
      where: { id: ctx.site.id },
      data: { fullCrawlDueAt: nextDue, lastFullCrawlAt: ctx.now },
    }),
  ]);
  ctx.site = { ...ctx.site, fullCrawlDueAt: nextDue, lastFullCrawlAt: ctx.now };
}
