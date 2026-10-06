import "server-only";

import { prisma } from "@/lib/prisma";
import {
  addDays,
  addWeeks,
  dateToDayKey,
  lastCompleteWeekStart,
  weekEndOf,
  weekStartOf,
} from "@/lib/seo/dates";
import { SeoFlags, cwvEnabled } from "@/lib/seo/health-flags";
import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import {
  PACE_HORIZON_WEEKS,
  PACE_LABEL,
  SEO_GOAL_METRICS,
  goalPace,
  isSeoGoalMetric,
  seoGoalTitle,
  validSeoGoalTarget,
} from "@/lib/seo/reports/goals";
import {
  SEO_GOAL_METRIC_KEYS,
  type GoalPace,
  type GoalSeriesPoint,
  type SeoGoalMetricKey,
  type SeoReportGoal,
} from "@/lib/seo/reports/types";
import { sumGscDays } from "@/lib/seo/totals";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { readCoverage } from "@/server/seo/health/coverage";
import { readLatestCwv } from "@/server/seo/health/cwv";
import { readGscDays } from "@/server/seo/store";

import {
  latestFetchedWeeks,
  readFinalWindow,
  reportContextFor,
  type ReportLinkContext,
} from "./inputs";

// SEO hedefleri (docs/search-reports.md "Hedefler"): ProjectGoal satırlarının
// beş TAM metricKey'i; günlük ölçüm, 13 haftalık tempo ve silme. Hedefler tek
// moda aittir (ProjectGoal.isMock); mock bağ gerçek hedefin değerine hiç
// dokunmaz. Google'a çağrı yok.

const WINDOW_DAYS = 30;
const SERIES_WEEKS = 13;
const TOP10_POSITION = 10;
const TOP10_MIN_IMPRESSIONS = 3;
const TOP10_AVERAGE_WEEKS = 4;
const ACTIVE_STATUSES = ["ACTIVE", "APPROVED"] as const;
const KEEP_OUT_STATUSES = ["ARCHIVED", "REJECTED"] as const;

export type SeoGoalMeasure = {
  value: number | null;
  measuredThrough: string | null;
  series: GoalSeriesPoint[];
  reason: string | null;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function unmeasured(reason: string): SeoGoalMeasure {
  return { value: null, measuredThrough: null, series: [], reason };
}

// Son 13 tam PT haftası; her hafta 30/7 ile aylık eşdeğere çevrilir ki seri
// "son 30 gün" değeriyle aynı birimde olsun. Eksik ya da taze günü olan hafta
// (markasızda marka değeri eksik olan da) atlanır.
async function weeklyClickSeries(
  ctx: ReportLinkContext,
  metric: "gsc.clicks" | "gsc.nonBrandClicks",
): Promise<GoalSeriesPoint[]> {
  const last = lastCompleteWeekStart(ctx.finalThrough);
  const first = addWeeks(last, -(SERIES_WEEKS - 1));
  const days = await readGscDays(ctx.link.id, first, weekEndOf(last));
  const byWeek = new Map<string, typeof days>();
  for (const day of days) {
    if (day.fresh) continue;
    const week = weekStartOf(day.day);
    byWeek.set(week, [...(byWeek.get(week) ?? []), day]);
  }
  const series: GoalSeriesPoint[] = [];
  for (let week = first; week <= last; week = addWeeks(week, 1)) {
    const weekDays = byWeek.get(week) ?? [];
    if (weekDays.length !== 7) continue;
    const split = sumGscDays(weekDays);
    const clicks =
      metric === "gsc.nonBrandClicks"
        ? split.nonBrand?.clicks
        : split.total.clicks;
    if (clicks === undefined) continue;
    series.push({ week, value: Math.round((clicks * WINDOW_DAYS) / 7) });
  }
  return series;
}

async function measureClicks(
  ctx: ReportLinkContext,
  metric: "gsc.clicks" | "gsc.nonBrandClicks",
): Promise<SeoGoalMeasure> {
  const nonBrand = metric === "gsc.nonBrandClicks";
  if (nonBrand && !ctx.brandSplitReady) return unmeasured("no_brand_split");
  const window = await readFinalWindow(ctx.link.id, {
    from: addDays(ctx.finalThrough, -(WINDOW_DAYS - 1)),
    to: ctx.finalThrough,
  });
  if (nonBrand && window.complete && !window.split.nonBrand) {
    return unmeasured("no_brand_split");
  }
  const series = await weeklyClickSeries(ctx, metric);
  if (!window.complete) {
    return {
      value: null,
      measuredThrough: null,
      series,
      reason: "short_history",
    };
  }
  const clicks = nonBrand
    ? (window.split.nonBrand?.clicks ?? null)
    : window.split.total.clicks;
  if (clicks === null) return unmeasured("no_brand_split");
  return {
    value: clicks,
    measuredThrough: ctx.finalThrough,
    series,
    reason: null,
  };
}

type Top10Row = { week: string; count: number };

// Markasız sorgulardan, haftalık ortalama konumu ilk 10'da olanların (en az 3
// gösterim) sayısı; değer son 4 çekilmiş haftanın ortalamasıdır.
async function measureTop10(ctx: ReportLinkContext): Promise<SeoGoalMeasure> {
  // Ayrım hazır olmadan her GscQuery.isBrand varsayılan false'tur: marka
  // sorguları markasız sayılırdı.
  if (!ctx.brandSplitReady) return unmeasured("no_brand_split");
  const weeks = (
    await latestFetchedWeeks(
      ctx.link.id,
      SERIES_WEEKS,
      lastCompleteWeekStart(ctx.finalThrough),
    )
  ).reverse();
  if (weeks.length === 0) return unmeasured("short_history");
  const rows = await prisma.$queryRaw<Top10Row[]>`
    SELECT w."weekStart"::text AS "week", COUNT(*)::int AS "count"
      FROM "GscWeeklyQuery" w
      JOIN "GscQuery" q ON q."id" = w."queryId"
     WHERE w."linkId" = ${ctx.link.id}
       AND w."weekStart" BETWEEN ${weeks[0]!}::date AND ${weeks[weeks.length - 1]!}::date
       AND q."isBrand" = false
       AND w."impressions" >= ${TOP10_MIN_IMPRESSIONS}
       AND w."positionWeighted" / w."impressions" <= ${TOP10_POSITION}
     GROUP BY w."weekStart"
  `;
  const counts = new Map(rows.map((row) => [row.week, Number(row.count)]));
  const series = weeks.map((week) => ({ week, value: counts.get(week) ?? 0 }));
  if (series.length < TOP10_AVERAGE_WEEKS) {
    return {
      value: null,
      measuredThrough: null,
      series,
      reason: "short_history",
    };
  }
  const recent = series.slice(-TOP10_AVERAGE_WEEKS);
  const mean =
    recent.reduce((sum, point) => sum + point.value, 0) / recent.length;
  return {
    value: Math.round(mean),
    measuredThrough: ctx.finalThrough,
    series,
    reason: null,
  };
}

// W2 kapsam tahmininin noktası (yüzde); seri haftalık geçmişten.
async function measureIndexedShare(
  ctx: ReportLinkContext,
): Promise<SeoGoalMeasure> {
  if (!SeoFlags.health()) return unmeasured("no_health");
  const coverage = await readCoverage(ctx.projectId);
  const current = coverage?.current;
  if (!coverage || !current) return unmeasured("no_value");
  return {
    value: round1(current.point * 100),
    measuredThrough: current.weekStart,
    series: coverage.history
      .slice(-SERIES_WEEKS)
      .map((row) => ({ week: row.weekStart, value: round1(row.point * 100) })),
    reason: null,
  };
}

// Ölçülen (origin ve kilit sayfa, telefon ve masaüstü) Core Web Vitals
// görünümlerinden "good" olanların payı (yüzde).
async function measureCwvGoodShare(
  ctx: ReportLinkContext,
): Promise<SeoGoalMeasure> {
  if (!cwvEnabled()) return unmeasured("no_cwv");
  const summary = await readLatestCwv(ctx.projectId);
  if (!summary) return unmeasured("no_value");
  const views = [
    summary.phone,
    summary.desktop,
    ...summary.urls.flatMap((row) => [row.phone, row.desktop]),
  ].filter((view) => view !== null && view.overall !== null);
  if (views.length === 0) return unmeasured("no_value");
  const good = views.filter((view) => view?.overall === "good").length;
  return {
    value: round1((good / views.length) * 100),
    measuredThrough: summary.checkedAt ? dateToDayKey(summary.checkedAt) : null,
    series: [],
    reason: null,
  };
}

export async function measureSeoGoal(
  ctx: ReportLinkContext,
  metric: SeoGoalMetricKey,
): Promise<SeoGoalMeasure> {
  switch (metric) {
    case "gsc.clicks":
    case "gsc.nonBrandClicks":
      return measureClicks(ctx, metric);
    case "gsc.top10Queries":
      return measureTop10(ctx);
    case "seo.indexedShare":
      return measureIndexedShare(ctx);
    case "seo.cwvGoodShare":
      return measureCwvGoodShare(ctx);
  }
}

function asPace(value: string): GoalPace {
  return value === "achieved" ||
    value === "on_track" ||
    value === "behind" ||
    value === "at_risk"
    ? value
    : "unknown";
}

// Her hedefin güncel değerini ve temposunu yeniler. Bayrak denetimi çağıranda
// (koşucu); yalnız bağın kipindeki hedefler işlenir. Dönüş: currentValue'su
// değişen ProjectGoal sayısı.
export async function refreshSeoGoals(
  projectId: string,
  now: Date = new Date(),
): Promise<number> {
  const ctx = await reportContextFor(projectId);
  if (!ctx) return 0;
  const isMock = ctx.link.isMock;
  const goals = await prisma.projectGoal.findMany({
    where: {
      projectId,
      status: { in: [...ACTIVE_STATUSES] },
      metricKey: { in: [...SEO_GOAL_METRIC_KEYS] },
      isMock,
    },
    orderBy: { createdAt: "asc" },
  });

  let updated = 0;
  for (const goal of goals) {
    if (!isSeoGoalMetric(goal.metricKey)) continue;
    const metric = goal.metricKey;
    const measure = await measureSeoGoal(ctx, metric);
    const pace = goalPace({
      current: measure.value,
      target: goal.targetValue,
      series: measure.series,
      max: SEO_GOAL_METRICS[metric].unit === "percent" ? 100 : null,
    });
    if (measure.value !== null && measure.value !== goal.currentValue) {
      await prisma.projectGoal.update({
        where: { id: goal.id },
        data: { currentValue: measure.value },
      });
      updated += 1;
    }
    const data = {
      metricKey: metric,
      value: measure.value,
      measuredThrough: measure.measuredThrough,
      pace: pace.pace,
      projected: pace.projected,
      projectedLow: pace.low,
      projectedHigh: pace.high,
      series: measure.series.slice(-PACE_HORIZON_WEEKS),
      reason: measure.reason ?? pace.reason,
      isMock,
    };
    await prisma.seoGoalProgress.upsert({
      where: { goalId: goal.id },
      create: {
        ...data,
        workspaceId: goal.workspaceId,
        projectId,
        linkId: ctx.link.id,
        goalId: goal.id,
      },
      update: { ...data, linkId: ctx.link.id },
    });
  }

  // Hedefi artık etkin olmayan (arşivlenmiş, silinmiş) ilerleme satırları.
  await prisma.seoGoalProgress.deleteMany({
    where: {
      projectId,
      isMock,
      goalId: { notIn: goals.map((goal) => goal.id) },
    },
  });
  void now;
  return updated;
}

// Aynı proje, metrik ve kipte tek etkin hedef: varsa hedef değeri güncellenir.
export async function upsertSeoGoal(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  metricKey: SeoGoalMetricKey;
  target: number;
}): Promise<{ goalId: string; created: boolean }> {
  if (!validSeoGoalTarget(input.metricKey, input.target)) {
    throw new Error("The goal target is not valid for this metric.");
  }
  const isMock = gscMockMode();
  const existing = await prisma.projectGoal.findFirst({
    where: {
      projectId: input.projectId,
      metricKey: input.metricKey,
      isMock,
      status: { notIn: [...KEEP_OUT_STATUSES] },
    },
    select: { id: true },
  });
  const data = {
    title: seoGoalTitle(input.metricKey, input.target),
    description: `Measured daily from Google Search Console (${SEO_GOAL_METRICS[input.metricKey].window}).`,
    targetValue: input.target,
    status: "ACTIVE" as const,
    approvedByType: "USER" as const,
    approvedByUserId: input.userId,
  };
  if (existing) {
    await prisma.projectGoal.update({ where: { id: existing.id }, data });
    return { goalId: existing.id, created: false };
  }
  const created = await prisma.projectGoal.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      metricKey: input.metricKey,
      isMock,
      ...data,
    },
    select: { id: true },
  });
  return { goalId: created.id, created: true };
}

// Yalnız projenin SEO anahtarlı hedefi arşivlenir; ilerleme satırı silinir.
export async function archiveSeoGoal(
  projectId: string,
  goalId: string,
): Promise<boolean> {
  const archived = await prisma.projectGoal.updateMany({
    where: {
      id: goalId,
      projectId,
      metricKey: { in: [...SEO_GOAL_METRIC_KEYS] },
      isMock: gscMockMode(),
      status: { not: "ARCHIVED" },
    },
    data: { status: "ARCHIVED" },
  });
  if (archived.count === 0) return false;
  await prisma.seoGoalProgress.deleteMany({ where: { goalId } });
  return true;
}

export async function listSeoGoals(
  projectId: string,
): Promise<SeoReportGoal[]> {
  const goals = await prisma.projectGoal.findMany({
    where: {
      projectId,
      metricKey: { in: [...SEO_GOAL_METRIC_KEYS] },
      status: { in: [...ACTIVE_STATUSES] },
      isMock: gscMockMode(),
    },
    orderBy: { createdAt: "asc" },
  });
  if (goals.length === 0) return [];
  const progress = await prisma.seoGoalProgress.findMany({
    where: { goalId: { in: goals.map((goal) => goal.id) } },
  });
  const byGoal = new Map(progress.map((row) => [row.goalId, row]));
  return goals.flatMap((goal) => {
    if (!isSeoGoalMetric(goal.metricKey)) return [];
    const row = byGoal.get(goal.id);
    const pace = asPace(row?.pace ?? "unknown");
    return [
      {
        goalId: goal.id,
        title: goal.title,
        metricKey: goal.metricKey,
        target: goal.targetValue,
        current: goal.currentValue,
        pace,
        paceLabel: PACE_LABEL[pace],
        measuredThrough: row?.measuredThrough ?? null,
        projected: row?.projected ?? null,
        projectedLow: row?.projectedLow ?? null,
        projectedHigh: row?.projectedHigh ?? null,
      },
    ];
  });
}

// Brand Brain → Goals rozeti: bayrak ya da izin kapalıysa veritabanına
// dokunmadan boş.
export async function loadSeoGoalPaces(
  projectId: string,
): Promise<
  Map<string, { pace: GoalPace; label: string; measuredThrough: string | null }>
> {
  if (!seoReportsActiveFor(projectId)) return new Map();
  const rows = await prisma.seoGoalProgress.findMany({
    where: { projectId, isMock: gscMockMode() },
    select: { goalId: true, pace: true, measuredThrough: true },
  });
  return new Map(
    rows.map((row) => {
      const pace = asPace(row.pace);
      return [
        row.goalId,
        { pace, label: PACE_LABEL[pace], measuredThrough: row.measuredThrough },
      ];
    }),
  );
}

// Disconnect ve "Delete stored data": bayraktan bağımsız. SEO anahtarlı
// hedeflerin ölçülen değeri silinir (hedefin kendisi kalır); önek eşleşmesi
// yok, yalnız beş tam anahtar.
// `isMock` verilirse yalnız o kipin hedef değerleri ve ilerleme satırları
// silinir (canlı veritabanını paylaşan mock süreç canlı hedefi silemez).
export async function forgetSeoGoalValues(
  projectIds: readonly string[],
  options: { isMock?: boolean } = {},
): Promise<number> {
  if (projectIds.length === 0) return 0;
  const ids = [...projectIds];
  const mode = options.isMock === undefined ? {} : { isMock: options.isMock };
  const cleared = await prisma.projectGoal.updateMany({
    where: {
      projectId: { in: ids },
      metricKey: { in: [...SEO_GOAL_METRIC_KEYS] },
      ...mode,
    },
    data: { currentValue: null },
  });
  await prisma.seoGoalProgress.deleteMany({
    where: { projectId: { in: ids }, ...mode },
  });
  return cleared.count;
}
