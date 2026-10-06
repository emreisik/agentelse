import "server-only";

import { addDays, dateToDayKey, dayKeyToDate } from "@/lib/seo/dates";
import {
  biggestSliceChange,
  pulseNotable,
  usualValue,
} from "@/lib/seo/reports/pulse";
import { changeRatio } from "@/lib/seo/reports/diagnose";
import { periodKeyOf } from "@/lib/seo/reports/ids";
import { reportNotes } from "@/lib/seo/reports/snapshot";
import { SEO_REPORT_TITLE, dayLabel } from "@/lib/seo/reports/text";
import type {
  SeoReportPulse,
  SeoReportSection,
  SeoReportSnapshot,
} from "@/lib/seo/reports/types";
import type { SliceRow } from "@/lib/seo/slices";
import { prisma } from "@/lib/prisma";
import { readGscDays, type GscDayRow } from "@/server/seo/store";

import {
  countNewCriticalAlerts,
  readHealthSummary,
  readOpenSearchAlerts,
  type ReportLinkContext,
} from "./inputs";

// SEO nabzı (docs/search-reports.md "Nabız"): kesinleşen son günün değeri
// aynı haftanın günlerinin ortancasından belirgin sapıyorsa ya da son
// denetimden beri yeni bir CRITICAL uyarı çıktıysa tek günlük kart. Yalnız
// okur: yazma ve LLM yok; sayılar ambardan ve W2 uyarılarından gelir.

export type BuiltReport = { snapshot: SeoReportSnapshot };
export type ReportSkip = {
  skipped: "quiet" | "not_final" | "no_data" | "missing_summaries";
};

// Aynı hafta gününün geçmişi: D−7 … D−56 (8 hafta).
const HISTORY_DAYS = 56;
const MIN_BRAND_HISTORY = 3;
// Ülke ve cihaz kırılımı için D ile D−7 … D−28.
const SLICE_WEEKS = 4;

type PulseMetric = SeoReportPulse["metric"];

function sameWeekdayDays(
  day: string,
  days: Map<string, GscDayRow>,
): GscDayRow[] {
  const history: GscDayRow[] = [];
  for (let back = 7; back <= HISTORY_DAYS; back += 7) {
    const row = days.get(addDays(day, -back));
    if (row && !row.fresh) history.push(row);
  }
  return history;
}

function hasBrand(row: GscDayRow): boolean {
  return (
    row.brandClicks !== null &&
    row.brandImpressions !== null &&
    row.brandPositionWeighted !== null
  );
}

function metricValue(row: GscDayRow, metric: PulseMetric): number {
  if (metric === "clicks") return row.clicks;
  return Math.max(0, row.clicks - (row.brandClicks ?? 0));
}

// Json satırlarını SliceRow'a çevirir; bozuk satır atlanır.
function sliceRows(raw: unknown): SliceRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SliceRow[] = [];
  for (const item of raw) {
    if (
      Array.isArray(item) &&
      item.length >= 4 &&
      typeof item[0] === "string" &&
      typeof item[1] === "number" &&
      typeof item[2] === "number" &&
      typeof item[3] === "number"
    ) {
      rows.push([item[0], item[1], item[2], item[3]]);
    }
  }
  return rows;
}

async function readBiggest(
  linkId: string,
  day: string,
): Promise<SeoReportPulse["biggest"]> {
  const dates = [day];
  for (let week = 1; week <= SLICE_WEEKS; week += 1) {
    dates.push(addDays(day, -7 * week));
  }
  const rows = await prisma.gscDailySlice.findMany({
    where: {
      linkId,
      kind: { in: ["country", "device"] },
      date: { in: dates.map(dayKeyToDate) },
    },
    select: { kind: true, date: true, rows: true },
  });
  const candidates: NonNullable<SeoReportPulse["biggest"]>[] = [];
  for (const dimension of ["country", "device"] as const) {
    const own = rows.filter((row) => row.kind === dimension);
    const today = own.find((row) => dateToDayKey(row.date) === day);
    if (!today) continue;
    const history = own
      .filter((row) => dateToDayKey(row.date) !== day)
      .map((row) => sliceRows(row.rows));
    const change = biggestSliceChange({
      dimension,
      day: sliceRows(today.rows),
      history,
    });
    if (change) candidates.push(change);
  }
  // En büyük mutlak sapma; eşitlikte ülke (listedeki ilk).
  let best: NonNullable<SeoReportPulse["biggest"]> | null = null;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate.value - candidate.usual);
    if (!best || delta > Math.abs(best.value - best.usual)) best = candidate;
  }
  return best;
}

export async function buildPulseReport(
  ctx: ReportLinkContext,
  day: string,
  options: { since: Date | null; now: Date },
): Promise<BuiltReport | ReportSkip> {
  if (day > ctx.finalThrough) return { skipped: "not_final" };
  const rows = await readGscDays(ctx.link.id, addDays(day, -HISTORY_DAYS), day);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const today = byDay.get(day);
  if (!today || today.fresh) return { skipped: "not_final" };

  const history = sameWeekdayDays(day, byDay);
  const brandHistory = history.filter(hasBrand);
  const metric: PulseMetric =
    hasBrand(today) && brandHistory.length >= MIN_BRAND_HISTORY
      ? "nonBrandClicks"
      : "clicks";
  const value = metricValue(today, metric);
  const usual = usualValue(
    (metric === "clicks" ? history : brandHistory).map((row) =>
      metricValue(row, metric),
    ),
  );

  const [biggest, alerts, newCritical] = await Promise.all([
    readBiggest(ctx.link.id, day),
    readOpenSearchAlerts(ctx.projectId),
    options.since
      ? countNewCriticalAlerts(ctx.projectId, options.since, options.now)
      : Promise.resolve(0),
  ]);
  const openCritical =
    alerts?.filter((alert) => alert.severity === "CRITICAL").length ?? 0;

  const pulse: SeoReportPulse = {
    day,
    metric,
    value,
    usual,
    changePct: usual === null ? null : changeRatio(value, usual),
    newCritical,
    openCritical,
    biggest,
  };
  if (!pulseNotable(pulse)) return { skipped: "quiet" };

  const sections: SeoReportSection[] = [{ type: "pulse", pulse }];
  if (openCritical > 0) {
    const health = await readHealthSummary(ctx.projectId);
    if (health) sections.push({ type: "health", health });
  }

  return {
    snapshot: {
      v: 1,
      kind: "PULSE",
      title: SEO_REPORT_TITLE.PULSE,
      periodKey: periodKeyOf("PULSE", day),
      period: { from: day, to: day, label: dayLabel(day) },
      compare: null,
      yearAgo: null,
      site: { label: ctx.siteLabel, isMock: ctx.link.isMock },
      finalThrough: ctx.finalThrough,
      brandSplit: ctx.brandSplitReady,
      anonymousShare: null,
      sections,
      notes: reportNotes({
        finalThrough: ctx.finalThrough,
        anonymousShare: null,
        brandSplit: ctx.brandSplitReady,
        truncated: false,
        lowData: false,
        isMock: ctx.link.isMock,
      }),
    },
  };
}
