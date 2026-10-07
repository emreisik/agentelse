import type { GscRow } from "@/lib/seo/response";
import type {
  BqCell,
  BqQueryResult,
} from "@/server/integrations/google/bigquery/types";

import type { BqPeriodKind } from "./sql";

// BigQuery sonuçlarını Search Analytics satırlarına çeviren saf yardımcılar
// (docs/search-agency.md). Sonuç sütunları konuma göre okunur:
// [anahtar..., tıklama, gösterim, sıfır tabanlı konum toplamı].

// Dışa aktarım konumları sıfır tabanlıdır: ortalama = toplam / gösterim + 1.
export function positionFromSum(
  sumZeroBased: number,
  impressions: number,
): number {
  return impressions > 0 ? sumZeroBased / impressions + 1 : 0;
}

function num(cell: BqCell | undefined): number {
  const value = typeof cell === "number" ? cell : Number(cell);
  return Number.isFinite(value) ? value : 0;
}

function str(cell: BqCell | undefined): string | null {
  return typeof cell === "string" && cell.length > 0 ? cell : null;
}

const KEY_COUNT: Record<BqPeriodKind, number> = {
  query: 1,
  page: 1,
  query_page: 2,
};

// Dönem satırları. İstek cap + 1 satır ister: cap'ten fazla satır geldiyse
// dönem kırpılmıştır ve fazladan satır atılır. Anahtarı boş ya da gösterimi
// sıfır olan satır atlanır.
export function periodRowsFromResult(
  key: BqPeriodKind,
  result: BqQueryResult,
  cap: number,
): { rows: GscRow[]; truncated: boolean } {
  const keyCount = KEY_COUNT[key];
  const truncated = result.truncated || result.rows.length > cap;
  const rows: GscRow[] = [];
  for (const cells of result.rows.slice(0, cap)) {
    const keys: string[] = [];
    for (let at = 0; at < keyCount; at += 1) {
      const part = str(cells[at]);
      if (part === null) break;
      keys.push(part);
    }
    if (keys.length !== keyCount) continue;
    const clicks = num(cells[keyCount]);
    const impressions = num(cells[keyCount + 1]);
    if (impressions <= 0) continue;
    rows.push({
      keys,
      clicks,
      impressions,
      ctr: clicks / impressions,
      position: positionFromSum(num(cells[keyCount + 2]), impressions),
    });
  }
  return { rows, truncated };
}

// Mutabakat günleri: [gün, tıklama, gösterim].
export function dayRowsFromResult(
  result: BqQueryResult,
): { day: string; clicks: number; impressions: number }[] {
  const out: { day: string; clicks: number; impressions: number }[] = [];
  for (const cells of result.rows) {
    const day = str(cells[0])?.slice(0, 10);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push({ day, clicks: num(cells[1]), impressions: num(cells[2]) });
  }
  return out;
}

// Mülk adı karşılaştırması: küçük harf, sondaki "/" yok sayılır.
export function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.trim().toLowerCase().replace(/\/+$/, "");
}

// Bağın mülküne eşleşen dışa aktarım değeri (tam BigQuery yazımı); yoksa null.
// "sc-domain:x" yalnız "sc-domain:x" ile eşleşir, URL öneki kendi türüyle.
export function matchSiteUrl(
  rows: readonly { siteUrl: string; clicks: number }[],
  linkSiteUrl: string,
): string | null {
  const wanted = normalizeSiteUrl(linkSiteUrl);
  let best: { siteUrl: string; clicks: number } | null = null;
  for (const row of rows) {
    if (normalizeSiteUrl(row.siteUrl) !== wanted) continue;
    if (!best || row.clicks > best.clicks) best = row;
  }
  return best?.siteUrl ?? null;
}

export type BqCoverage = {
  exportStart: string | null;
  exportedThrough: string | null;
  days: number;
};

type DayRange = { first: string; last: string; days: number };

function dayText(cell: BqCell | undefined): string | null {
  const value = str(cell)?.slice(0, 10);
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function rangeOf(
  first: BqCell | undefined,
  last: BqCell | undefined,
  days: BqCell | undefined,
): DayRange | null {
  const a = dayText(first);
  const b = dayText(last);
  const n = num(days);
  return a && b && n > 0 ? { first: a, last: b, days: n } : null;
}

function combine(site: DayRange, url: DayRange): BqCoverage | null {
  const exportStart = site.first > url.first ? site.first : url.first;
  const exportedThrough = site.last < url.last ? site.last : url.last;
  if (exportStart > exportedThrough) return null;
  return {
    exportStart,
    exportedThrough,
    days: Math.min(site.days, url.days),
  };
}

// Kapsam: ExportLog tercih edilir; yoksa iki tablonun yoklaması. İki tabloda
// da veri olmalıdır; başlangıç iki ilk günün geç olanı, bitiş iki son günün
// erken olanıdır.
export function coverageFromResults(
  log: BqQueryResult | null,
  tables: { site: BqQueryResult | null; url: BqQueryResult | null },
): BqCoverage | null {
  if (log) {
    let site: DayRange | null = null;
    let url: DayRange | null = null;
    for (const cells of log.rows) {
      const agenda = str(cells[0])?.toUpperCase();
      const range = rangeOf(cells[1], cells[2], cells[3]);
      if (!range) continue;
      if (agenda === "SEARCHDATA_SITE_IMPRESSION") site = range;
      if (agenda === "SEARCHDATA_URL_IMPRESSION") url = range;
    }
    if (site && url) {
      const merged = combine(site, url);
      if (merged) return merged;
    }
  }
  const first = tables.site?.rows[0];
  const second = tables.url?.rows[0];
  if (!first || !second) return null;
  const site = rangeOf(first[0], first[1], first[2]);
  const url = rangeOf(second[0], second[1], second[2]);
  return site && url ? combine(site, url) : null;
}
