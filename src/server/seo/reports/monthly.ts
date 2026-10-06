import "server-only";

import { addMonths, dayKeyToDate, monthEnd } from "@/lib/seo/dates";
import { periodKeyOf } from "@/lib/seo/reports/ids";
import { buildKpis } from "@/lib/seo/reports/kpis";
import { moverRows } from "@/lib/seo/reports/movers";
import { isLowData, reportNotes } from "@/lib/seo/reports/snapshot";
import { SEO_REPORT_TITLE, monthLabel } from "@/lib/seo/reports/text";
import type {
  SeoLabeledRange,
  SeoRange,
  SeoReportContentItem,
  SeoReportSection,
} from "@/lib/seo/reports/types";
import type { GscSplit } from "@/lib/seo/totals";
import { gscDataThrough, readPeriodCoverage } from "@/server/seo/store";

import {
  readActions,
  readAnonymousShare,
  readContentPlan,
  readFinalWindow,
  readHealthSummary,
  readRankedDeltas,
  readUpdates,
  type FinalWindow,
  type ReportLinkContext,
} from "./inputs";
import { forecastSearchMonth } from "./forecast";
import { listSeoGoals } from "./goals";
import type { BuiltReport, ReportSkip } from "./pulse";
import {
  compact,
  diagnosisSection,
  summariesFetched,
  tableSection,
} from "./weekly";

export type { BuiltReport, ReportSkip } from "./pulse";

// Aylık SEO raporu (docs/search-reports.md "Aylık rapor"). Yalnız okur:
// hedefleri YENİLEMEZ (refreshSeoGoals'u çalıştıran koşucu rapordan hemen
// önce yeniler) ve LLM çağırmaz. Takvim ayı, bir önceki takvim ayı ve
// (ambar o kadar geriye gidiyorsa) geçen yılın aynı ayıyla karşılaştırılır.

const MONTHLY_TABLE_LIMIT = 200;
const MONTHLY_MIN_DELTA = 10;

function usable(window: FinalWindow): GscSplit | null {
  return window.complete ? window.split : null;
}

function monthRange(month: string): SeoRange {
  return { from: month, to: monthEnd(month) };
}

function labeled(range: SeoRange, month: string): SeoLabeledRange {
  return { ...range, label: monthLabel(month) };
}

function contentSection(
  title: string,
  items: SeoReportContentItem[],
): SeoReportSection | null {
  return items.length > 0 ? { type: "content", title, items } : null;
}

export async function buildMonthlyReport(
  ctx: ReportLinkContext,
  month: string,
  now: Date,
): Promise<BuiltReport | ReportSkip> {
  const linkId = ctx.link.id;
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const yearMonth = addMonths(month, -12);
  const period = monthRange(month);
  const compare = monthRange(prevMonth);
  const yearAgoRange = monthRange(yearMonth);

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

  // Aylık özetler: son çekilen ay bu aya ulaşmadıysa ya da bu ay için sorgu
  // özeti yoksa.
  if ((ctx.link.lastMonthlyMonth ?? "") < month) {
    return { skipped: "missing_summaries" };
  }
  const own = await readPeriodCoverage(linkId, "MONTH", "query", month, month);
  if (!own.periods.includes(month)) return { skipped: "missing_summaries" };

  const [queriesReady, pagesReady] = await Promise.all([
    summariesFetched(linkId, "MONTH", "query", [prevMonth, month]),
    summariesFetched(linkId, "MONTH", "page", [prevMonth, month]),
  ]);
  const monthRangeNow: SeoRange = { from: month, to: month };
  const prevMonthRange: SeoRange = { from: prevMonth, to: prevMonth };
  const nonBrandOnly = ctx.brandSplitReady;

  const [
    goals,
    forecast,
    diagnosis,
    queries,
    pages,
    share,
    health,
    actions,
    thisMonth,
    planned,
    updates,
  ] = await Promise.all([
    listSeoGoals(ctx.projectId),
    forecastSearchMonth(ctx, nextMonth),
    // Teşhis KPI'larla aynı takvim ayı pencerelerini kullanır.
    diagnosisSection(ctx, cur, prev, {
      windows: { current: period, previous: compare, tableGrain: "MONTH" },
      now,
    }),
    queriesReady
      ? readRankedDeltas({
          linkId,
          dimension: "query",
          grain: "MONTH",
          current: monthRangeNow,
          previous: prevMonthRange,
          nonBrandOnly,
          limit: MONTHLY_TABLE_LIMIT,
        })
      : Promise.resolve([]),
    pagesReady
      ? readRankedDeltas({
          linkId,
          dimension: "page",
          grain: "MONTH",
          current: monthRangeNow,
          previous: prevMonthRange,
          limit: MONTHLY_TABLE_LIMIT,
        })
      : Promise.resolve([]),
    readAnonymousShare(linkId, "MONTH", month, cur.total.clicks),
    readHealthSummary(ctx.projectId),
    readActions(ctx.projectId, {
      from: dayKeyToDate(month),
      to: dayKeyToDate(nextMonth),
    }),
    readContentPlan(ctx.projectId, month, ctx.timezone),
    readContentPlan(ctx.projectId, nextMonth, ctx.timezone),
    readUpdates(period, now),
  ]);

  const options = { minDelta: MONTHLY_MIN_DELTA };
  const sections = compact([
    {
      type: "kpis",
      kpis: buildKpis({ current: cur, previous: prev, yearAgo }),
      compareLabel: "vs the month before",
      yearAgoLabel: yearAgo ? "vs last year" : null,
    },
    goals.length > 0 ? { type: "goals", goals } : null,
    forecast ? { type: "forecast", forecast } : null,
    diagnosis,
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
    health ? { type: "health", health } : null,
    actions ? { type: "actions", actions } : null,
    contentSection("SEO articles this month", thisMonth),
    contentSection("Planned for next month", planned),
    updates && updates.length > 0 ? { type: "updates", items: updates } : null,
  ]);

  return {
    snapshot: {
      v: 1,
      kind: "MONTHLY",
      title: SEO_REPORT_TITLE.MONTHLY,
      periodKey: periodKeyOf("MONTHLY", month),
      period: labeled(period, month),
      compare: prev ? labeled(compare, prevMonth) : null,
      yearAgo: yearAgo ? labeled(yearAgoRange, yearMonth) : null,
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
        lowData: isLowData("MONTHLY", cur.total.impressions),
        isMock: ctx.link.isMock,
      }),
    },
  };
}
