import "server-only";

import type { SeoCrawl, SeoSite } from "@prisma/client";

import {
  CRAWL_FRONTIER_MAX,
  CRAWL_FRONTIER_URL_MAX,
  CRAWL_GSC_SEEDS,
  CRAWL_PAGES_PER_WEEK,
} from "@/lib/seo/audit-constants";
import {
  crawlUrlHash,
  inScope,
  normalizeCrawlUrl,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import { addWeeks, dayKeyToDate, gscToday, weekStartOf } from "@/lib/seo/dates";
import { prisma } from "@/lib/prisma";

// Tam taramanın bekleyen kuyruğu (SeoCrawl.frontier { v: 1, queue }).
// Tohum sırası: ana sayfa, kilit sayfalar, son 13 haftanın GSC sayfaları
// (en çok 200), sitemap envanteri (lastmod yeniden eskiye); sonra derinliğe
// göre BFS. Yalnız köken alan adının adresleri kuyruğa girer; eş ve diğer
// kapsam içi alan adları sayılır (otherHosts). 512 karakteri aşan adresler
// saklanmaz, sayılır. En çok 2.000 öğe; taşanlar droppedFrontier.

export type FrontierSource = "SEED" | "CRAWL" | "SITEMAP" | "GSC";
export type FrontierItem = { u: string; d: number; s: FrontierSource };
export type FrontierState = { v: 1; queue: FrontierItem[] };
export type FrontierStats = {
  otherHosts: number;
  longUrls: number;
  droppedFrontier: number;
  outOfScope: number;
};
export type FrontierAddResult =
  | "added"
  | "seen"
  | "invalid"
  | "out_of_scope"
  | "other_host"
  | "long"
  | "dropped";

const SOURCES = new Set<string>(["SEED", "CRAWL", "SITEMAP", "GSC"]);
const GSC_WINDOW_WEEKS = 13;

export function parseFrontier(value: unknown): FrontierItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const queue = (value as { queue?: unknown }).queue;
  if (!Array.isArray(queue)) return [];
  const items: FrontierItem[] = [];
  for (const item of queue) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.u !== "string" ||
      typeof record.d !== "number" ||
      typeof record.s !== "string" ||
      !SOURCES.has(record.s)
    ) {
      continue;
    }
    items.push({ u: record.u, d: record.d, s: record.s as FrontierSource });
  }
  return items;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export class Frontier {
  private buckets = new Map<number, FrontierItem[]>();
  private heads = new Map<number, number>();
  private seen = new Set<string>();
  private counted = new Set<string>();
  private pending = 0;
  readonly stats: FrontierStats = {
    otherHosts: 0,
    longUrls: 0,
    droppedFrontier: 0,
    outOfScope: 0,
  };

  constructor(
    private readonly scope: CrawlScope,
    private originHost: string,
    private readonly max: number = CRAWL_FRONTIER_MAX,
  ) {
    this.originHost = originHost.toLowerCase();
  }

  get size(): number {
    return this.pending;
  }

  setOriginHost(host: string): void {
    this.originHost = host.toLowerCase();
  }

  // Bu taramada getirilmiş ya da sıraya girmiş adres (urlHash).
  markSeen(urlHash: string): void {
    this.seen.add(urlHash);
  }

  has(urlHash: string): boolean {
    return this.seen.has(urlHash);
  }

  private countOnce(key: string, field: keyof FrontierStats): void {
    if (this.counted.has(`${field}:${key}`)) return;
    this.counted.add(`${field}:${key}`);
    this.stats[field] += 1;
  }

  private push(item: FrontierItem, front: boolean): void {
    const bucket = this.buckets.get(item.d) ?? [];
    if (!this.buckets.has(item.d)) {
      this.buckets.set(item.d, bucket);
      this.heads.set(item.d, 0);
    }
    if (front) {
      const head = this.heads.get(item.d) ?? 0;
      if (head > 0) {
        bucket[head - 1] = item;
        this.heads.set(item.d, head - 1);
      } else {
        bucket.unshift(item);
      }
    } else {
      bucket.push(item);
    }
    this.pending += 1;
  }

  add(url: string, depth: number, source: FrontierSource): FrontierAddResult {
    const normalized = normalizeCrawlUrl(url);
    if (!normalized) return "invalid";
    const urlHash = crawlUrlHash(normalized);
    if (this.seen.has(urlHash)) return "seen";
    if (!inScope(normalized, this.scope)) {
      this.countOnce(urlHash, "outOfScope");
      return "out_of_scope";
    }
    if (hostOf(normalized) !== this.originHost) {
      this.countOnce(urlHash, "otherHosts");
      return "other_host";
    }
    if (normalized.length > CRAWL_FRONTIER_URL_MAX) {
      this.countOnce(urlHash, "longUrls");
      return "long";
    }
    if (this.pending >= this.max) {
      this.countOnce(urlHash, "droppedFrontier");
      return "dropped";
    }
    this.seen.add(urlHash);
    this.push(
      { u: normalized, d: Math.max(0, Math.floor(depth)), s: source },
      false,
    );
    return "added";
  }

  // Duraklatılan (429/503) öğe sırasının başına döner.
  requeue(item: FrontierItem): void {
    this.push(item, true);
  }

  // En küçük derinlik, sonra ekleme sırası.
  pop(): FrontierItem | null {
    if (this.pending === 0) return null;
    const depths = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const depth of depths) {
      const bucket = this.buckets.get(depth) ?? [];
      const head = this.heads.get(depth) ?? 0;
      if (head < bucket.length) {
        const item = bucket[head] ?? null;
        this.heads.set(depth, head + 1);
        this.pending -= 1;
        if (head + 1 >= bucket.length) {
          this.buckets.delete(depth);
          this.heads.delete(depth);
        }
        return item;
      }
      this.buckets.delete(depth);
      this.heads.delete(depth);
    }
    return null;
  }

  toState(): FrontierState {
    const depths = [...this.buckets.keys()].sort((a, b) => a - b);
    const queue: FrontierItem[] = [];
    for (const depth of depths) {
      const bucket = this.buckets.get(depth) ?? [];
      queue.push(...bucket.slice(this.heads.get(depth) ?? 0));
    }
    return { v: 1, queue };
  }

  // Kaydedilmiş kuyruktan devam: sıra korunur, `fetched` bu taramada zaten
  // getirilenlerdir (yeniden kuyruğa girmezler).
  static restore(
    scope: CrawlScope,
    originHost: string,
    items: readonly FrontierItem[],
    fetched: Iterable<string>,
    max: number = CRAWL_FRONTIER_MAX,
  ): Frontier {
    const frontier = new Frontier(scope, originHost, max);
    for (const hash of fetched) frontier.markSeen(hash);
    for (const item of items) {
      const urlHash = crawlUrlHash(item.u);
      if (frontier.seen.has(urlHash) || frontier.pending >= max) continue;
      frontier.seen.add(urlHash);
      frontier.push(item, false);
    }
    return frontier;
  }
}

export type SeedSources = {
  homeUrl: string;
  keyPages: readonly string[];
  gscUrls: readonly string[];
  sitemapUrls: readonly string[];
};

// Tohumlar: ana sayfa derinlik 0, diğerleri 1 (linklerden bulunanlar 1+).
export function seedFrontier(frontier: Frontier, sources: SeedSources): void {
  frontier.add(sources.homeUrl, 0, "SEED");
  for (const url of sources.keyPages) frontier.add(url, 1, "SEED");
  let gsc = 0;
  for (const url of sources.gscUrls) {
    if (gsc >= CRAWL_GSC_SEEDS) break;
    if (url.includes("[")) continue;
    if (frontier.add(url, 1, "GSC") === "added") gsc += 1;
  }
  for (const url of sources.sitemapUrls) frontier.add(url, 1, "SITEMAP");
}

// Tohum kaynaklarını okur: GSC sayfaları (birincil bağ, son 13 hafta) ve
// sitemap envanteri (lastmod yeniden eskiye).
export async function loadSeedSources(
  site: Pick<SeoSite, "id">,
  linkId: string | null,
  now: Date,
): Promise<{ gscUrls: string[]; sitemapUrls: string[] }> {
  const since = addWeeks(weekStartOf(gscToday(now)), -GSC_WINDOW_WEEKS);
  const [gscRows, sitemapRows] = await Promise.all([
    linkId
      ? prisma.gscPage.findMany({
          where: { linkId, lastSeenWeek: { gte: dayKeyToDate(since) } },
          orderBy: [{ lastSeenWeek: "desc" }, { url: "asc" }],
          take: CRAWL_GSC_SEEDS * 2,
          select: { url: true },
        })
      : Promise.resolve([]),
    prisma.seoPage.findMany({
      where: { siteId: site.id, inSitemap: true },
      orderBy: [
        { sitemapLastmod: { sort: "desc", nulls: "last" } },
        { url: "asc" },
      ],
      take: CRAWL_PAGES_PER_WEEK,
      select: { url: true },
    }),
  ]);
  return {
    gscUrls: gscRows.map((row) => row.url),
    sitemapUrls: sitemapRows.map((row) => row.url),
  };
}

// Devam eden taramada bu taramada getirilmiş sayfaların urlHash'leri.
export async function fetchedInCrawl(
  crawl: Pick<SeoCrawl, "id" | "siteId">,
): Promise<string[]> {
  const rows = await prisma.seoPage.findMany({
    where: { siteId: crawl.siteId, lastCrawlId: crawl.id },
    select: { urlHash: true },
  });
  return rows.map((row) => row.urlHash);
}
