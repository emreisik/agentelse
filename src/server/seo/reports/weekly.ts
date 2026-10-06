import "server-only";

import { addDays, dayKeyToDate } from "@/lib/seo/dates";
import {
  DIAG_DROP,
  DIAG_MIN_PREVIOUS,
  changeRatio,
  diagnoseSearchDrop,
} from "@/lib/seo/reports/diagnose";
import { periodKeyOf } from "@/lib/seo/reports/ids";
import { buildKpis, primaryMetric } from "@/lib/seo/reports/kpis";
import { moverRows, risingRows } from "@/lib/seo/reports/movers";
import { isLowData, reportNotes } from "@/lib/seo/reports/snapshot";
import {
  SEO_REPORT_TITLE,
  TABLE_TITLE,
  periodLabel,
} from "@/lib/seo/reports/text";
import type {
  SeoRange,
  SeoReportRow,
  SeoReportSection,
  SeoTableKey,
} from "@/lib/seo/reports/types";
import type { GscSplit } from "@/lib/seo/totals";
import { gscDataThrough, readPeriodCoverage } from "@/server/seo/store";

import { loadDiagnoseInput, type DiagnoseOptions } from "./diagnose";
import {
  readActions,
  readAnonymousShare,
  readFinalWindow,
  readHealthSummary,
  readOpportunities,
  readRankedDeltas,
  readUpdates,
  type FinalWindow,
  type ReportLinkContext,
} from "./inputs";
import type { BuiltReport, ReportSkip } from "./pulse";

export type { BuiltReport, ReportSkip } from "./pulse";

// Haftalık SEO raporu (docs/search-reports.md "Haftalık rapor"). Yalnız
// okur: yazma ve LLM yok. Sayılar yalnız KESİN günlerden ve haftalık
// özetlerden gelir; hafta kesinleşmediyse ya da özetler henüz çekilmediyse
// rapor üretilmez (çağıran sonra yeniden dener).

const WEEKLY_TABLE_LIMIT = 200;
const WEEKLY_MIN_DELTA = 3;

// --- monthly.ts ile paylaşılan yardımcılar ---

// Birincil ölçü (markasız ya da toplam tıklama) önceki döneme göre düşüş
// eşiğini aştı mı? Önceki dönem yoksa ya da çok küçükse düşüş sayılmaz.
export function primaryMetricDropped(
  current: GscSplit,
  previous: GscSplit | null,
): boolean {
  if (!previous) return false;
  // loadDiagnoseInput ile aynı kural: markasız ölçü yalnız İKİ dönemde de
  // varsa; biri yoksa (ayrım dönem ortasında hazır oldu) toplam tıklama.
  const nonBrand =
    primaryMetric(current) === "nonBrandClicks" && previous.nonBrand !== null;
  const now = nonBrand ? current.nonBrand?.clicks : current.total.clicks;
  const before = nonBrand ? previous.nonBrand?.clicks : previous.total.clicks;
  if (now === undefined || before === undefined) return false;
  if (before < DIAG_MIN_PREVIOUS) return false;
  const ratio = changeRatio(now, before);
  return ratio !== null && ratio <= DIAG_DROP;
}

// Düşüş varsa teşhis bölümü; yeterli veri yoksa ya da düşüş teşhis ağacında
// doğrulanmazsa null.
export async function diagnosisSection(
  ctx: ReportLinkContext,
  current: GscSplit,
  previous: GscSplit | null,
  options: DiagnoseOptions,
): Promise<SeoReportSection | null> {
  if (!primaryMetricDropped(current, previous)) return null;
  const input = await loadDiagnoseInput(ctx, options);
  if (!input) return null;
  const diagnosis = diagnoseSearchDrop(input);
  return diagnosis.dropped ? { type: "diagnosis", diagnosis } : null;
}

export function tableSection(
  key: SeoTableKey,
  aggregation: "By property" | "By page",
  rows: SeoReportRow[],
): SeoReportSection | null {
  if (rows.length === 0) return null;
  return {
    type: "table",
    table: { key, title: TABLE_TITLE[key], aggregation, rows },
  };
}

// Özet tablosu iki dönem için de çekilmiş mi (yoksa her satır "yeni" görünür).
export async function summariesFetched(
  linkId: string,
  grain: "WEEK" | "MONTH",
  key: "query" | "page",
  periods: readonly string[],
): Promise<boolean> {
  const sorted = [...periods].sort();
  const coverage = await readPeriodCoverage(
    linkId,
    grain,
    key,
    sorted[0]!,
    sorted[sorted.length - 1]!,
  );
  return periods.every((period) => coverage.periods.includes(period));
}

export function compact(
  sections: readonly (SeoReportSection | null)[],
): SeoReportSection[] {
  return sections.filter(
    (section): section is SeoReportSection => section !== null,
  );
}

function usable(window: FinalWindow): GscSplit | null {
  return window.complete ? window.split : null;
}

export async function buildWeeklyReport(
  ctx: ReportLinkContext,
  week: string,
  now: Date,
): Promise<BuiltReport | ReportSkip> {
  const linkId = ctx.link.id;
  const period: SeoRange = { from: week, to: addDays(week, 6) };
  const compare: SeoRange = {
    from: addDays(week, -7),
    to: addDays(week, -1),
  };
  const yearAgoRange: SeoRange = {
    from: addDays(week, -364),
    to: addDays(week, -358),
  };

  // Geçen yıl yalnız ambar o tarihten önce başlıyorsa okunur.
  const through = await gscDataThrough(linkId);
  const hasYearAgo =
    through.earliest !== null && through.earliest <= yearAgoRange.from;
  const [curWindow, prevWindow, yearWindow] = await Promise.all([
    readFinalWindow(linkId, period),
    readFinalWindow(linkId, compare),
    hasYearAgo ? readFinalWindow(linkId, yearAgoRange) : Promise.resolve(null),
  ]);
  if (!curWindow.complete) return { skipped: "not_final" };
  const cur = curWindow.split;
  const prev = usable(prevWindow);
  const yearAgo = yearWindow ? usable(yearWindow) : null;
  if (cur.total.impressions === 0 && (prev?.total.impressions ?? 0) === 0) {
    return { skipped: "no_data" };
  }

  // Haftalık özetler: son çekilen hafta bu haftaya ulaşmadıysa ya da bu hafta
  // için sorgu özeti yoksa.
  if ((ctx.link.lastWeeklyWeek ?? "") < week) {
    return { skipped: "missing_summaries" };
  }
  const own = await readPeriodCoverage(linkId, "WEEK", "query", week, week);
  if (!own.periods.includes(week)) return { skipped: "missing_summaries" };

  const prevWeek = addDays(week, -7);
  const [queriesReady, pagesReady] = await Promise.all([
    summariesFetched(linkId, "WEEK", "query", [prevWeek, week]),
    summariesFetched(linkId, "WEEK", "page", [prevWeek, week]),
  ]);
  const weekRange: SeoRange = { from: week, to: week };
  const prevWeekRange: SeoRange = { from: prevWeek, to: prevWeek };
  const nonBrandOnly = ctx.brandSplitReady;

  const [
    diagnosis,
    queries,
    pages,
    share,
    health,
    opportunities,
    actions,
    updates,
  ] = await Promise.all([
    diagnosisSection(ctx, cur, prev, {
      days: 7,
      end: period.to,
      now,
    }),
    queriesReady
      ? readRankedDeltas({
          linkId,
          dimension: "query",
          grain: "WEEK",
          current: weekRange,
          previous: prevWeekRange,
          nonBrandOnly,
          limit: WEEKLY_TABLE_LIMIT,
        })
      : Promise.resolve([]),
    pagesReady
      ? readRankedDeltas({
          linkId,
          dimension: "page",
          grain: "WEEK",
          current: weekRange,
          previous: prevWeekRange,
          limit: WEEKLY_TABLE_LIMIT,
        })
      : Promise.resolve([]),
    readAnonymousShare(linkId, "WEEK", week, cur.total.clicks),
    readHealthSummary(ctx.projectId),
    readOpportunities(ctx.projectId, 5),
    readActions(ctx.projectId, {
      from: dayKeyToDate(week),
      to: dayKeyToDate(addDays(week, 7)),
    }),
    readUpdates(period, now),
  ]);

  const options = { minDelta: WEEKLY_MIN_DELTA };
  const sections = compact([
    {
      type: "kpis",
      kpis: buildKpis({ current: cur, previous: prev, yearAgo }),
      compareLabel: "vs the week before",
      yearAgoLabel: yearAgo ? "vs last year" : null,
    },
    diagnosis,
    tableSection(
      "losing_queries",
      "By property",
      moverRows(queries, "losers", { ...options, nonBrandOnly }),
    ),
    tableSection(
      "winning_queries",
      "By property",
      moverRows(queries, "winners", { ...options, nonBrandOnly }),
    ),
    tableSection(
      "rising_queries",
      "By property",
      risingRows(queries, { nonBrandOnly }),
    ),
    tableSection(
      "losing_pages",
      "By page",
      moverRows(pages, "losers", options),
    ),
    tableSection(
      "winning_pages",
      "By page",
      moverRows(pages, "winners", options),
    ),
    health ? { type: "health", health } : null,
    opportunities && opportunities.length > 0
      ? { type: "opportunities", items: opportunities }
      : null,
    actions ? { type: "actions", actions } : null,
    updates && updates.length > 0 ? { type: "updates", items: updates } : null,
  ]);

  return {
    snapshot: {
      v: 1,
      kind: "WEEKLY",
      title: SEO_REPORT_TITLE.WEEKLY,
      periodKey: periodKeyOf("WEEKLY", week),
      period: { ...period, label: periodLabel(period.from, period.to) },
      compare: prev
        ? { ...compare, label: periodLabel(compare.from, compare.to) }
        : null,
      yearAgo: yearAgo
        ? {
            ...yearAgoRange,
            label: periodLabel(yearAgoRange.from, yearAgoRange.to),
          }
        : null,
      site: { label: ctx.siteLabel, isMock: ctx.link.isMock },
      finalThrough: ctx.finalThrough,
      brandSplit: ctx.brandSplitReady,
      anonymousShare: share.share,
      sections,
      notes: reportNotes({
        finalThrough: ctx.finalThrough,
        anonymousShare: share.share,
        brandSplit: ctx.brandSplitReady,
        truncated: share.truncated,
        lowData: isLowData("WEEKLY", cur.total.impressions),
        isMock: ctx.link.isMock,
      }),
    },
  };
}
