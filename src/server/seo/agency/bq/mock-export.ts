import "server-only";

import type { GscQueryRequest } from "@/lib/seo/catalog";
import { addDays, gscToday } from "@/lib/seo/dates";
import { normalizeSiteUrl } from "@/lib/seo/agency/bq/rows";
import { parseGscResponse } from "@/lib/seo/response";
import {
  registerBigQueryMockHandler,
  type BigQueryMockHandler,
  type BqCell,
  type BqQueryRequest,
  type BqQueryResult,
} from "@/server/integrations/google/bigquery";
import { mockSearchAnalytics } from "@/server/integrations/search-console/mock";

// Sahte Search Console dışa aktarımı (AGENTELSE_PROVIDER_MODE=mock): ağ yok,
// sonuçlar amaç + parametrelerden belirlenimci üretilir. Kapsam penceresi
// bugün(PT)−120 … bugün−3; mutabakat günleri API mock'unun (mockSearchAnalytics)
// toplamlarından türer, böylece sahte dışa aktarım API ile tutarlıdır. Sorgular
// yalnız bağın kendi site_url'ünü görür. Bu dosya içe aktarılınca "gsc."
// önekini kaydeder; işleyici yalnız sahte arka uçtan erişilir.

const EXPORT_DAYS_BACK = 120;
const EXPORT_LAG_DAYS = 3;
const DEFAULT_DRY_RUN_BYTES = 50_000_000;

type MockSizes = { query: number; page: number; pair: number };
const DEFAULT_SIZES: MockSizes = { query: 120, page: 80, pair: 150 };

let sizes: MockSizes = { ...DEFAULT_SIZES };
let dryRunBytes = DEFAULT_DRY_RUN_BYTES;
let onlySite: string | null = null;

// Testler: dönem başına satır sayısını değiştirir (62.000 haftalık sorgu gibi).
export function setMockExportSize(
  next: { query?: number; page?: number; pair?: number } | null,
): void {
  sizes = { ...DEFAULT_SIZES, ...(next ?? {}) };
}

// Testler: kuru çalıştırma tahmini (bayt); null varsayılana döner.
export function setMockExportDryRunBytes(bytes: number | null): void {
  dryRunBytes = bytes ?? DEFAULT_DRY_RUN_BYTES;
}

// Testler: veri kümesinde yalnız bu mülk varmış gibi davranır (başkasının
// mülkü: eşleşme boş döner). null: istenen her mülk vardır.
export function setMockExportSiteUrl(siteUrl: string | null): void {
  onlySite = siteUrl === null ? null : normalizeSiteUrl(siteUrl);
}

export function resetMockExport(): void {
  sizes = { ...DEFAULT_SIZES };
  dryRunBytes = DEFAULT_DRY_RUN_BYTES;
  onlySite = null;
}

// FNV-1a + mulberry32: aynı tohum aynı diziyi verir.
function fnv(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function param(request: BqQueryRequest, name: string): string {
  const found = request.params.find((entry) => entry.name === name);
  return found === undefined ? "" : String(found.value);
}

function result(rows: BqCell[][]): BqQueryResult {
  return {
    columns: [],
    rows,
    totalRows: rows.length,
    truncated: false,
    bytesProcessed: dryRunBytes,
    bytesBilled: dryRunBytes,
    cacheHit: false,
  };
}

function siteVisible(site: string): boolean {
  return onlySite === null || normalizeSiteUrl(site) === onlySite;
}

function originOf(site: string): string {
  if (site.startsWith("sc-domain:")) return `https://${site.slice(10)}`;
  try {
    return new URL(site).origin;
  } catch {
    return "https://example.com";
  }
}

function window(): { first: string; last: string; days: number } {
  const today = gscToday(new Date());
  const first = addDays(today, -EXPORT_DAYS_BACK);
  const last = addDays(today, -EXPORT_LAG_DAYS);
  return { first, last, days: EXPORT_DAYS_BACK - EXPORT_LAG_DAYS + 1 };
}

// Gün başına web toplamları: API mock'u ile aynı sayılar.
function reconcileRows(request: BqQueryRequest): BqCell[][] {
  const site = param(request, "site_url");
  if (!siteVisible(site)) return [];
  const body: GscQueryRequest = {
    startDate: param(request, "from"),
    endDate: param(request, "to"),
    dimensions: ["date"],
    type: "web",
    aggregationType: "byProperty",
    dataState: "final",
    rowLimit: 25_000,
    startRow: 0,
  };
  const parsed = parseGscResponse(mockSearchAnalytics(site, body));
  const win = window();
  return parsed.rows
    .filter((row) => {
      const day = row.keys[0] ?? "";
      return day >= win.first && day <= win.last;
    })
    .map((row) => [row.keys[0] ?? "", row.clicks, row.impressions]);
}

type Kind = "query" | "page" | "pair";

function periodRows(request: BqQueryRequest, kind: Kind): BqCell[][] {
  const site = param(request, "site_url");
  if (!siteVisible(site)) return [];
  const count = sizes[kind];
  const origin = originOf(site);
  const rng = mulberry(
    fnv(`${request.purpose}|${site}|${param(request, "from")}|${param(request, "to")}`),
  );
  type Raw = { keys: string[]; clicks: number; impressions: number; pos: number };
  const raw: Raw[] = [];
  for (let i = 0; i < count; i += 1) {
    // Uzun kuyruk: üstteki sorgular daha çok gösterim alır.
    const impressions = 3 + Math.floor(rng() * 400 * (1 / (1 + i / 40)));
    const clicks = Math.floor(impressions * rng() * 0.12);
    const position = 1 + rng() * 30;
    const keys =
      kind === "query"
        ? [`mock query ${i}`]
        : kind === "page"
          ? [`${origin}/p/item-${i}`]
          : [`mock query ${i}`, `${origin}/p/item-${i % 80}`];
    raw.push({ keys, clicks, impressions, pos: (position - 1) * impressions });
  }
  raw.sort(
    (a, b) =>
      b.clicks - a.clicks ||
      b.impressions - a.impressions ||
      a.keys.join("\u0000").localeCompare(b.keys.join("\u0000")),
  );
  const limit = Number(param(request, "limit")) || raw.length;
  return raw
    .slice(0, limit)
    .map((row) => [...row.keys, row.clicks, row.impressions, row.pos]);
}

function sitesRows(request: BqQueryRequest): BqCell[][] {
  const site = param(request, "site");
  if (!siteVisible(site)) return [];
  return [[site, 12_345, 456_789]];
}

function logRows(): BqCell[][] {
  const win = window();
  return [
    ["SEARCHDATA_SITE_IMPRESSION", win.first, win.last, win.days],
    ["SEARCHDATA_URL_IMPRESSION", win.first, win.last, win.days],
  ];
}

function tableCoverageRows(request: BqQueryRequest): BqCell[][] {
  const site = param(request, "site_url");
  const win = window();
  return siteVisible(site)
    ? [[win.first, win.last, win.days]]
    : [[null, null, 0]];
}

const handler: BigQueryMockHandler = {
  query(request) {
    switch (request.purpose) {
      case "gsc.coverage.log":
        return result(logRows());
      case "gsc.coverage.table":
        return result(tableCoverageRows(request));
      case "gsc.sites":
        return result(sitesRows(request));
      case "gsc.reconcile.days":
        return result(reconcileRows(request));
      case "gsc.period.query":
        return result(periodRows(request, "query"));
      case "gsc.period.page":
        return result(periodRows(request, "page"));
      case "gsc.period.pair":
        return result(periodRows(request, "pair"));
      default:
        return result([]);
    }
  },
  dryRun() {
    return { bytesProcessed: dryRunBytes };
  },
};

registerBigQueryMockHandler("gsc.", handler);
