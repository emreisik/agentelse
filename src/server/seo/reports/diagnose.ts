import "server-only";

import { prisma } from "@/lib/prisma";
import { gscPageKey } from "@/lib/seo/crawl-url";
import {
  addDays,
  addWeeks,
  gscToday,
  lastCompleteWeekStart,
  monthEnd,
  monthStart,
  weekEndOf,
  weekStartOf,
  addMonths,
} from "@/lib/seo/dates";
import { SeoFlags } from "@/lib/seo/health-flags";
import { isIndexedVerdict } from "@/lib/seo/inspection";
import { diagnoseSearchDrop } from "@/lib/seo/reports/diagnose";
import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import type {
  DiagnoseInput,
  DiagnosePage,
  DiagnoseRow,
  DiagnoseTables,
  SearchDiagnosis,
  SeoRange,
} from "@/lib/seo/reports/types";
import type { GscTotals } from "@/lib/seo/totals";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { readCoverage } from "@/server/seo/health/coverage";
import { readInspectionsFor } from "@/server/seo/health/google-reads";
import {
  gscDataThrough,
  primaryGscLink,
  readPeriodCoverage,
} from "@/server/seo/store";

import {
  latestFetchedWeeks,
  readFinalWindow,
  readOpenSearchAlerts,
  readPairDeltas,
  readRankedDeltas,
  readUpdates,
  reportContextForLink,
  type RankedDelta,
  type ReportLinkContext,
} from "./inputs";

// "Aramam neden düştü?" teşhisinin veri yükleyicisi (docs/search-reports.md
// "Teşhis ağacı"): ambar ve W2/W3 tablolarından saf ağacın (src/lib/seo/
// reports/diagnose.ts) girdisini kurar. Google'a çağrı yapmaz.

const TABLE_ROW_LIMIT = 200;
const PAIR_QUERY_LIMIT = 20;
const LOST_PAGE_MIN_PREVIOUS = 10;
const LOST_PAGE_MAX_SHARE = 0.5;
const SEO_PAGE_LIMIT = 2_000;
const YEAR_AGO_DAYS = 364;
const FALLBACK_WEEKS = 8;
const FALLBACK_SIDE = 4;

export type DiagnoseOptions = {
  days?: 7 | 28;
  end?: string;
  windows?: {
    current: SeoRange;
    previous: SeoRange;
    tableGrain: "WEEK" | "MONTH";
  };
  now?: Date;
};

// [end − days + 1, end] ile hemen öncesindeki eşit uzunlukta pencere.
export function diagnoseWindows(
  end: string,
  days: 7 | 28,
): { current: SeoRange; previous: SeoRange } {
  return {
    current: { from: addDays(end, -(days - 1)), to: end },
    previous: {
      from: addDays(end, -(2 * days - 1)),
      to: addDays(end, -days),
    },
  };
}

function shiftRange(range: SeoRange, days: number): SeoRange {
  return { from: addDays(range.from, days), to: addDays(range.to, days) };
}

function mondaysOf(range: SeoRange): string[] {
  const list: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 7)) {
    list.push(day);
  }
  return list;
}

// Haftalık özetleri çekilmiş mi: aralıktaki her Pazartesi ambarda olmalı.
async function weeksFetched(
  linkId: string,
  key: "query" | "query_page",
  ranges: readonly SeoRange[],
): Promise<boolean> {
  const first = ranges.reduce(
    (best, range) => (range.from < best ? range.from : best),
    ranges[0]!.from,
  );
  const last = ranges.reduce(
    (best, range) => (range.to > best ? range.to : best),
    ranges[0]!.to,
  );
  const coverage = await readPeriodCoverage(linkId, "WEEK", key, first, last);
  const have = new Set(coverage.periods);
  return ranges.every((range) =>
    mondaysOf(range).every((monday) => have.has(monday)),
  );
}

// Yeni 4 hafta ile ondan önceki 4 hafta (en az 2 çekilmiş hafta gerekir;
// hafta azsa iki yan eşit bölünür). Çekilmiş haftalar yeniden eskiye gelir.
function splitFetchedWeeks(
  weeks: readonly string[],
): { current: SeoRange; previous: SeoRange } | null {
  if (weeks.length < 2) return null;
  const side = Math.min(FALLBACK_SIDE, Math.floor(weeks.length / 2));
  return {
    current: { from: weeks[side - 1]!, to: weeks[0]! },
    previous: { from: weeks[2 * side - 1]!, to: weeks[side]! },
  };
}

async function fallbackWeeks(
  linkId: string,
  through: string,
): Promise<{ current: SeoRange; previous: SeoRange } | null> {
  const weeks = await latestFetchedWeeks(linkId, FALLBACK_WEEKS, through);
  return splitFetchedWeeks(weeks);
}

// Sorgu ve sayfa tablolarının dönemleri; pencereyle hizalı özetler çekilmemişse
// en son çekilen haftalara düşer (fallback = true).
async function resolveTables(
  linkId: string,
  input: {
    days: 7 | 28;
    end: string;
    explicit: NonNullable<DiagnoseOptions["windows"]> | undefined;
  },
): Promise<DiagnoseTables | null> {
  const { days, end, explicit } = input;
  if (explicit?.tableGrain === "MONTH") {
    const month = monthStart(explicit.current.from);
    const previousMonth = addMonths(month, -1);
    const coverage = await readPeriodCoverage(
      linkId,
      "MONTH",
      "query",
      previousMonth,
      month,
    );
    if (
      coverage.periods.includes(month) &&
      coverage.periods.includes(previousMonth)
    ) {
      return {
        grain: "MONTH",
        current: { from: month, to: month },
        previous: { from: previousMonth, to: previousMonth },
        fallback: false,
      };
    }
  }

  let aligned: { current: SeoRange; previous: SeoRange } | null = null;
  const sundayEnd = weekEndOf(weekStartOf(end)) === end;
  if (days === 7 && !explicit) {
    if (sundayEnd) {
      const week = weekStartOf(end);
      aligned = {
        current: { from: week, to: week },
        previous: { from: addWeeks(week, -1), to: addWeeks(week, -1) },
      };
    }
  } else {
    const week = lastCompleteWeekStart(end);
    aligned = {
      current: { from: addWeeks(week, -3), to: week },
      previous: { from: addWeeks(week, -7), to: addWeeks(week, -4) },
    };
  }
  if (
    aligned &&
    (await weeksFetched(linkId, "query", [aligned.previous, aligned.current]))
  ) {
    return { grain: "WEEK", ...aligned, fallback: false };
  }

  const fallback = await fallbackWeeks(linkId, lastCompleteWeekStart(end));
  return fallback ? { grain: "WEEK", ...fallback, fallback: true } : null;
}

// Çift (sorgu × sayfa) özetleri yalnız haftalıktır: tablolar haftalıksa aynı
// aralıklar, aylıksa ayın sonuna kadarki son haftalar kullanılır.
async function resolvePairWeeks(
  linkId: string,
  tables: DiagnoseTables | null,
): Promise<{ current: SeoRange; previous: SeoRange } | null> {
  if (!tables) return null;
  const weeks =
    tables.grain === "WEEK"
      ? { current: tables.current, previous: tables.previous }
      : await fallbackWeeks(
          linkId,
          lastCompleteWeekStart(monthEnd(tables.current.to)),
        );
  if (!weeks) return null;
  const coverage = await readPeriodCoverage(
    linkId,
    "WEEK",
    "query_page",
    weeks.previous.from,
    weeks.current.to,
  );
  const inside = (range: SeoRange) =>
    coverage.periods.some((week) => week >= range.from && week <= range.to);
  return inside(weeks.current) && inside(weeks.previous) ? weeks : null;
}

function plainRow(row: RankedDelta): DiagnoseRow {
  return {
    id: row.id,
    label: row.label,
    current: row.current,
    previous: row.previous,
  };
}

function isLostPage(row: RankedDelta): boolean {
  return (
    row.previous.clicks >= LOST_PAGE_MIN_PREVIOUS &&
    row.current.clicks <= row.previous.clicks * LOST_PAGE_MAX_SHARE
  );
}

// Kaybolan sayfalara kendi taramamızın durumunu (SeoPage) ve URL Inspection
// kararını ekler. Eşleştirme W2'nin lost-urls.ts'i gibi gscPageKey eşitliğiyle
// JS'te yapılır. SEO_HEALTH kapalıysa her şey null kalır.
async function enrichPages(
  projectId: string,
  rows: readonly RankedDelta[],
): Promise<DiagnosePage[]> {
  const bare = (row: RankedDelta): DiagnosePage => ({
    ...plainRow(row),
    status: null,
    noindex: null,
    indexed: null,
  });
  const lost = rows.filter((row) => isLostPage(row) && row.url);
  if (!SeoFlags.health() || lost.length === 0) return rows.map(bare);

  const seoPages = await prisma.seoPage.findMany({
    where: { projectId, site: { isMock: gscMockMode() } },
    select: { url: true, urlHash: true, status: true, noindex: true },
    orderBy: { inlinks: "desc" },
    take: SEO_PAGE_LIMIT,
  });
  const byKey = new Map<string, (typeof seoPages)[number]>();
  for (const page of seoPages) {
    const key = gscPageKey(page.url);
    if (key && !byKey.has(key)) byKey.set(key, page);
  }
  const matched = new Map<string, (typeof seoPages)[number]>();
  for (const row of lost) {
    const key = row.url ? gscPageKey(row.url) : null;
    const page = key ? byKey.get(key) : undefined;
    if (page) matched.set(row.id, page);
  }
  const inspections = await readInspectionsFor(
    projectId,
    [...matched.values()].map((page) => page.urlHash),
  );
  return rows.map((row) => {
    const page = matched.get(row.id);
    if (!page) return bare(row);
    const inspection = inspections.get(page.urlHash);
    return {
      ...plainRow(row),
      status: page.status,
      noindex: page.noindex,
      indexed: inspection ? isIndexedVerdict(inspection.verdict) : null,
    };
  });
}

// Kapsam tahmini: 28 gün ya da aylık raporda şimdiki ile dört hafta önceki,
// 7 günde şimdiki ile bir hafta önceki geçmiş satırı.
async function readCoverageWindow(
  projectId: string,
  weekly: boolean,
): Promise<DiagnoseInput["health"]["coverage"]> {
  const coverage = await readCoverage(projectId);
  if (!coverage) return null;
  if (!weekly) {
    return {
      current: coverage.current,
      previous: coverage.fourWeeksAgo,
    };
  }
  const current = coverage.current;
  const target = current ? addWeeks(current.weekStart, -1) : null;
  const previous = target
    ? (coverage.history.find((row) => row.weekStart === target) ?? null)
    : null;
  return { current, previous };
}

function totalsOf(
  window: Awaited<ReturnType<typeof readFinalWindow>>,
  metric: DiagnoseInput["metric"],
): GscTotals | null {
  return metric === "nonBrandClicks"
    ? window.split.nonBrand
    : window.split.total;
}

export async function loadDiagnoseInput(
  ctx: ReportLinkContext,
  options: DiagnoseOptions = {},
): Promise<DiagnoseInput | null> {
  const now = options.now ?? new Date();
  const explicit = options.windows;
  const days = options.days ?? 28;
  const end = explicit
    ? explicit.current.to
    : (() => {
        const requested = options.end ?? ctx.finalThrough;
        return requested < ctx.finalThrough ? requested : ctx.finalThrough;
      })();
  const windows = explicit
    ? { current: explicit.current, previous: explicit.previous }
    : diagnoseWindows(end, days);
  const link = ctx.link;

  const through = await gscDataThrough(link.id);
  if (!through.earliest || through.earliest > windows.previous.from) {
    return null;
  }

  const [current, previous] = await Promise.all([
    readFinalWindow(link.id, windows.current),
    readFinalWindow(link.id, windows.previous),
  ]);
  const metric: DiagnoseInput["metric"] =
    current.split.nonBrand && previous.split.nonBrand
      ? "nonBrandClicks"
      : "clicks";
  const currentTotals = totalsOf(current, metric);
  const previousTotals = totalsOf(previous, metric);
  if (!currentTotals || !previousTotals) return null;

  // Geçen yıl: iki pencere de 364 gün geriye; ambar o kadar geriye uzanıyorsa.
  let yearAgo: DiagnoseInput["yearAgo"] = null;
  if (through.earliest <= addDays(windows.previous.from, -YEAR_AGO_DAYS)) {
    const [yearCurrent, yearPrevious] = await Promise.all([
      readFinalWindow(link.id, shiftRange(windows.current, -YEAR_AGO_DAYS)),
      readFinalWindow(link.id, shiftRange(windows.previous, -YEAR_AGO_DAYS)),
    ]);
    const a = totalsOf(yearCurrent, metric);
    const b = totalsOf(yearPrevious, metric);
    if (a && b && yearCurrent.days.length > 0 && yearPrevious.days.length > 0) {
      yearAgo = { current: a, previous: b };
    }
  }

  const health = SeoFlags.health();
  const alerts = await readOpenSearchAlerts(ctx.projectId);

  const tables = await resolveTables(link.id, { days, end, explicit });
  const pairWeeks = await resolvePairWeeks(link.id, tables);

  const nonBrandOnly = metric === "nonBrandClicks";
  const [queryDeltas, pageDeltas] = tables
    ? await Promise.all([
        readRankedDeltas({
          linkId: link.id,
          dimension: "query",
          grain: tables.grain,
          current: tables.current,
          previous: tables.previous,
          nonBrandOnly,
          limit: TABLE_ROW_LIMIT,
        }),
        readRankedDeltas({
          linkId: link.id,
          dimension: "page",
          grain: tables.grain,
          current: tables.current,
          previous: tables.previous,
          limit: TABLE_ROW_LIMIT,
        }),
      ])
    : [[], []];
  const queries = queryDeltas.map(plainRow);
  const pages = await enrichPages(ctx.projectId, pageDeltas);

  // Çiftler: en çok tık kaybeden en çok 20 sorgunun sayfaları.
  const losers = [...queries]
    .map((row) => ({
      id: row.id,
      lost: row.previous.clicks - row.current.clicks,
    }))
    .filter((row) => row.lost > 0)
    .sort((a, b) => b.lost - a.lost || a.id.localeCompare(b.id))
    .slice(0, PAIR_QUERY_LIMIT);
  const pairs =
    pairWeeks && losers.length > 0
      ? await readPairDeltas({
          linkId: link.id,
          queryIds: losers.map((row) => row.id),
          current: pairWeeks.current,
          previous: pairWeeks.previous,
        })
      : [];

  const [coverage, updates] = await Promise.all([
    health
      ? readCoverageWindow(ctx.projectId, days === 7 && !explicit)
      : Promise.resolve(null),
    readUpdates(windows.current, now),
  ]);

  return {
    metric,
    today: gscToday(now),
    window: windows,
    tables,
    pairWeeks,
    totals: { current: currentTotals, previous: previousTotals },
    allTotals: {
      current: current.split.total,
      previous: previous.split.total,
    },
    yearAgo,
    data: {
      linkHealth: link.health,
      finalThrough: ctx.finalThrough,
      missingDays: current.missingDays + previous.missingDays,
      freshDays: current.freshDays + previous.freshDays,
      backfillDone: link.backfillDoneAt !== null,
      alertKinds: (alerts ?? []).map((alert) => alert.kind),
    },
    health: {
      available: health,
      alerts: alerts ?? [],
      coverage,
    },
    updatesAvailable: health,
    updates: (updates ?? []).map((update) => ({
      name: update.name,
      kind: update.kind,
      startedAt: update.startedAt,
      endedAt: update.endedAt,
    })),
    queries,
    pages,
    pairs,
  };
}

// Sohbet aracı ve Search sayfası için tek giriş. Bayrak ve izin listesi
// veritabanından önce denetlenir.
export async function runSearchDiagnosis(
  projectId: string,
  options: DiagnoseOptions = {},
): Promise<
  | { ok: true; diagnosis: SearchDiagnosis }
  | { ok: false; reason: "off" | "no_link" | "not_enough_data" }
> {
  if (!seoReportsActiveFor(projectId)) return { ok: false, reason: "off" };
  const link = await primaryGscLink(projectId);
  if (!link) return { ok: false, reason: "no_link" };
  const ctx = await reportContextForLink(link);
  if (!ctx) return { ok: false, reason: "not_enough_data" };
  const input = await loadDiagnoseInput(ctx, options);
  if (!input) return { ok: false, reason: "not_enough_data" };
  return { ok: true, diagnosis: diagnoseSearchDrop(input) };
}
