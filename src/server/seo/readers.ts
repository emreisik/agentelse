import "server-only";

import type { GscSiteLink } from "@prisma/client";

import type { SearchQueryRow } from "@/lib/module-flows/seo/quick-wins";
import { addDays, addWeeks, lastCompleteWeekStart } from "@/lib/seo/dates";
import { GscFlags } from "@/lib/seo/flags";
import { weeksWithin } from "@/lib/seo/periods";
import {
  averagePosition,
  ctrPercent,
  sumGscDays,
  type GscSplit,
} from "@/lib/seo/totals";

import { brandSplitStatus } from "./brand-terms";
import {
  primaryGscLink,
  readGscDays,
  readPeriodCoverage,
  readTopQueries,
} from "./store";

// Eski canlı okuyucuların ambar karşılığı (docs/search-analytics.md
// "Okuyucular"): Analytics modülü, sohbetin ANALYTICS_ANALYSIS sağlayıcısı ve
// SEO Manager hızlı kazanımları kesinleşen son PT gününe kadarki pencereyi
// buradan okur. Ambar pencereyi eksiksiz kapsamıyorsa (bayrak kapalı, bağ
// yok ya da başka site, senkron yeni, hafta eksik) null döner ve çağıran
// bugünkü canlı yola düşer.

export type SearchConsoleWarehouseMetricKey =
  | "sc.clicks"
  | "sc.impressions"
  | "sc.ctr"
  | "sc.position"
  | "sc.nonBrandClicks"
  | "sc.brandClicks";

export type SearchConsoleWarehouseSection = {
  days: number;
  from: string;
  to: string;
  metrics: { key: SearchConsoleWarehouseMetricKey; value: number }[];
  queries: {
    query: string;
    clicks: number;
    impressions: number;
    // Yüzde.
    ctr: number;
    position: number;
  }[];
};

const TOP_QUERIES = 5;
const QUERY_MAX = 200;
const QUICK_WIN_WEEKS = 4;
const QUICK_WIN_ROWS = 1000;

type CoveredWindow = {
  link: GscSiteLink;
  from: string;
  to: string;
  split: GscSplit;
};

// Bayrak, bağ, site ve gün kapsamı: `days` kesin günün hepsi ambarda mı?
async function coveredWindow(input: {
  projectId: string;
  siteUrl: string;
  days: number;
}): Promise<CoveredWindow | null> {
  if (!GscFlags.sync()) return null;
  if (!Number.isInteger(input.days) || input.days <= 0) return null;
  const link = await primaryGscLink(input.projectId);
  if (!link || link.siteUrl !== input.siteUrl || !link.lastFinalDate) {
    return null;
  }
  const to = link.lastFinalDate;
  const from = addDays(to, -(input.days - 1));
  const rows = await readGscDays(link.id, from, to);
  if (rows.length !== input.days || rows.some((row) => row.fresh)) return null;
  return { link, from, to, split: sumGscDays(rows) };
}

export async function readSearchConsoleWarehouse(input: {
  projectId: string;
  siteUrl: string;
  days: number;
  now?: Date;
}): Promise<SearchConsoleWarehouseSection | null> {
  const window = await coveredWindow(input);
  if (!window) return null;
  const { link, from, to, split } = window;
  // Sorgular pencerenin içindeki tam haftalardan; biri bile eksikse canlı yol.
  const weeks = weeksWithin(from, to);
  const coverage = await readPeriodCoverage(
    link.id,
    "WEEK",
    "query",
    weeks.from,
    weeks.to,
  );
  if (coverage.periods.length < weeks.count) return null;

  const metrics: SearchConsoleWarehouseSection["metrics"] = [
    { key: "sc.clicks", value: split.total.clicks },
    { key: "sc.impressions", value: split.total.impressions },
  ];
  // Gösterim yoksa oran ve konum anlamsız (canlı yolla aynı kural).
  const ctr = ctrPercent(split.total);
  const position = averagePosition(split.total);
  if (split.total.impressions > 0 && ctr !== null && position !== null) {
    metrics.push(
      { key: "sc.ctr", value: ctr },
      { key: "sc.position", value: position },
    );
  }
  if (brandSplitStatus(link) === "ready" && split.brand && split.nonBrand) {
    metrics.push(
      { key: "sc.nonBrandClicks", value: split.nonBrand.clicks },
      { key: "sc.brandClicks", value: split.brand.clicks },
    );
  }

  const top = await readTopQueries(link.id, weeks, {
    limit: TOP_QUERIES,
    brand: "all",
  });
  const queries = top.flatMap((row) => {
    const query = row.label.replace(/\s+/g, " ").trim();
    if (!query) return [];
    return [
      {
        query: query.slice(0, QUERY_MAX),
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: ctrPercent(row) ?? 0,
        position: averagePosition(row) ?? 0,
      },
    ];
  });
  return { days: input.days, from, to, metrics, queries };
}

// fetchSearchConsoleReport ile aynı biçim (ctr kesir, 0-1).
export async function readSearchConsoleTotals(input: {
  projectId: string;
  siteUrl: string;
  days: number;
}): Promise<{
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
} | null> {
  const window = await coveredWindow(input);
  if (!window) return null;
  const { total } = window.split;
  return {
    clicks: total.clicks,
    impressions: total.impressions,
    ctr: total.impressions > 0 ? total.clicks / total.impressions : 0,
    position: averagePosition(total) ?? 0,
  };
}

// Son 4 tam haftanın markasız sorguları, gösterime göre ilk 1000 satır;
// pickQuickWins canlı satırlarla aynı biçimde işler.
export async function readQuickWinRows(input: {
  projectId: string;
  siteUrl: string;
  now?: Date;
}): Promise<SearchQueryRow[] | null> {
  if (!GscFlags.sync()) return null;
  const link = await primaryGscLink(input.projectId);
  if (!link || link.siteUrl !== input.siteUrl || !link.lastFinalDate) {
    return null;
  }
  const to = lastCompleteWeekStart(link.lastFinalDate);
  const from = addWeeks(to, -(QUICK_WIN_WEEKS - 1));
  const coverage = await readPeriodCoverage(link.id, "WEEK", "query", from, to);
  if (coverage.periods.length < QUICK_WIN_WEEKS) return null;
  const rows = await readTopQueries(
    link.id,
    { from, to },
    { limit: QUICK_WIN_ROWS, brand: "non-brand", orderBy: "impressions" },
  );
  return rows.map((row) => ({
    keys: [row.label],
    clicks: row.clicks,
    impressions: row.impressions,
    position: averagePosition(row) ?? 0,
  }));
}
