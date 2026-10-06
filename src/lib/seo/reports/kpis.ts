import { changePercent } from "@/lib/seo/periods";
import {
  averagePosition,
  ctrPercent,
  type GscSplit,
  type GscTotals,
} from "@/lib/seo/totals";

import { KPI_LABEL } from "./text";
import type { SeoKpiKey, SeoReportKpi } from "./types";

// Rapor KPI'ları (docs/search-reports.md "KPI'lar"). Sayılar GscSplit
// toplamlarından olduğu gibi gelir; yalnız CTR (yüzde, 2 ondalık) ve konum
// (1 ondalık) yuvarlanır. Saf ve izomorfik.

export function primaryMetric(split: GscSplit): "nonBrandClicks" | "clicks" {
  return split.nonBrand !== null ? "nonBrandClicks" : "clicks";
}

function round(value: number | null, decimals: number): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

type Pick = (split: GscSplit) => number | null;

function totalsPick(read: (totals: GscTotals) => number | null): Pick {
  return (split) => read(split.total);
}

// Dönemin değeri; marka ayrımı bölümü (`part`) eksikse null.
function partPick(
  part: "brand" | "nonBrand",
  read: (totals: GscTotals) => number | null,
): Pick {
  return (split) => (split[part] ? read(split[part]) : null);
}

export function buildKpis(input: {
  current: GscSplit;
  previous: GscSplit | null;
  yearAgo: GscSplit | null;
}): SeoReportKpi[] {
  const make = (
    key: SeoKpiKey,
    pick: Pick,
    format: SeoReportKpi["format"],
    decimals: number,
    lowerIsBetter = false,
  ): SeoReportKpi => ({
    key,
    label: KPI_LABEL[key],
    value: round(pick(input.current), decimals),
    previous: input.previous ? round(pick(input.previous), decimals) : null,
    yearAgo: input.yearAgo ? round(pick(input.yearAgo), decimals) : null,
    format,
    lowerIsBetter,
  });
  const clicks = (totals: GscTotals) => totals.clicks;
  const kpis: SeoReportKpi[] = [];
  // Marka ayrımı kurulamadıysa iki marka KPI'ı da hiç görünmez.
  if (input.current.nonBrand !== null) {
    kpis.push(make("nonBrandClicks", partPick("nonBrand", clicks), "count", 0));
    kpis.push(make("brandClicks", partPick("brand", clicks), "count", 0));
  }
  kpis.push(make("clicks", totalsPick(clicks), "count", 0));
  kpis.push(
    make("impressions", totalsPick((t) => t.impressions), "count", 0),
  );
  kpis.push(make("ctr", totalsPick(ctrPercent), "percent", 2));
  kpis.push(make("position", totalsPick(averagePosition), "position", 1, true));
  return kpis;
}

// Karşılaştırmaya göre değişim, YÜZDE biriminde, 1 ondalık.
export function kpiChangePct(
  kpi: SeoReportKpi,
  which: "previous" | "yearAgo",
): number | null {
  return round(changePercent(kpi.value, kpi[which]), 1);
}
