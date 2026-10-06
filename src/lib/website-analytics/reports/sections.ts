import {
  findingConfidenceText,
  findingDetail,
  findingImpactText,
  findingPeriodText,
  findingTitle,
  outcomeText,
} from "@/lib/website-analytics/analysis/describe";
import { aiAssistantOf } from "@/lib/website-analytics/analysis/ai-sources";
import { gaRule, isGaRuleKey } from "@/lib/website-analytics/analysis/registry";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import type { MeasurementSummary } from "@/lib/website-analytics/health/view-types";
import { changePercent } from "@/lib/website-analytics/periods";
import { mergeQuality, qualityNotes } from "@/lib/website-analytics/response";
import {
  aggregateSlices,
  droppedTotals,
  type GaStoredSlice,
} from "@/lib/website-analytics/slices";
import {
  engagementRate,
  engagementSecondsPerSession,
  revenue,
  type GaPeriodTotals,
} from "@/lib/website-analytics/totals";
import { maskGoogleText } from "@/server/integrations/google/pii";

import { WEBSITE_REPORT_COPY } from "./copy";
import { goalFormatOf } from "./goal-keys";
import { paceLabel } from "./pace";
import {
  REPORT_CAPS,
  type ForecastMetric,
  type GoalProgressView,
  type MonthForecastView,
  type PlanBody,
  type ReportFindingSnap,
  type ReportForecastSnap,
  type ReportGoalSnap,
  type ReportKpi,
  type ReportKpiKey,
  type ReportMeasurement,
  type ReportMover,
  type ReportTable,
  type ReportValueFormat,
} from "./types";

// GA-F5 rapor bölümleri: ambardan okunan dilimler ve toplamlar kartın
// tablolarına, KPI satırlarına ve bulgu özetlerine çevrilir. Sayılar
// server/website-analytics/report.ts ile aynı birimdedir (yüzde birimi 0–100,
// süre saniye, para ana birim). Saf ve izomorfik: Google çağrısı, sorgu yok.

const NOT_SET = "(not set)";

// Değişim yüzdesi 1 ondalığa yuvarlanır; önceki değer yoksa ya da sıfırsa null.
export function roundedChangePct(
  current: number | null,
  previous: number | null,
): number | null {
  const change = changePercent(current, previous);
  if (change === null || !Number.isFinite(change)) return null;
  const rounded = Math.round(change * 10) / 10;
  // -0 JSON'a "0" yazılır ama karşılaştırmalarda şaşırtır.
  return rounded === 0 ? 0 : rounded;
}

function labelOf(value: string | undefined): string {
  return value ? value : NOT_SET;
}

function ratePercent(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

// Kalite notları: iki dönemin dilimlerinden birleşik.
function notesOf(...groups: readonly (readonly GaStoredSlice[])[]): string[] {
  const qualities = groups.flatMap((group) =>
    group.map((slice) => slice.quality),
  );
  return qualityNotes(mergeQuality(qualities));
}

// --- KPI satırları ------------------------------------------------------------

type KpiValues = {
  sessions: number;
  newUsers: number;
  engagementRate: number | null;
  engagementTime: number | null;
  keyEvents: number;
  keyEventRate: number | null;
  revenue: number;
};

function valuesOf(totals: GaPeriodTotals): KpiValues {
  return {
    sessions: totals.sessions,
    newUsers: totals.newUsers,
    engagementRate: engagementRate(totals),
    engagementTime: engagementSecondsPerSession(totals),
    keyEvents: totals.keyEvents,
    keyEventRate: ratePercent(totals.keyEvents, totals.sessions),
    revenue: revenue(totals),
  };
}

function kpiRow(
  key: ReportKpiKey,
  label: string,
  format: ReportValueFormat,
  value: number | null,
  previous: number | null,
  lastYear: number | null,
): ReportKpi {
  return {
    key,
    label,
    format,
    value,
    previous,
    changePct: roundedChangePct(value, previous),
    lastYear,
    lastYearChangePct: roundedChangePct(value, lastYear),
  };
}

export function kpiRows(input: {
  current: GaPeriodTotals;
  previous: GaPeriodTotals;
  lastYear: GaPeriodTotals | null;
  users: { current: number | null; previous: number | null };
}): ReportKpi[] {
  const current = valuesOf(input.current);
  const previous = valuesOf(input.previous);
  // Geçen yıl yalnız oturumu olan dönem için anlamlıdır.
  const year =
    input.lastYear && input.lastYear.sessions > 0
      ? valuesOf(input.lastYear)
      : null;
  const rows: ReportKpi[] = [];
  // Kullanıcı sayısı günlüklerden toplanamaz; geçen yıl değeri hiç yok.
  if (input.users.current !== null) {
    rows.push(
      kpiRow(
        "users",
        "Users",
        "count",
        input.users.current,
        input.users.previous,
        null,
      ),
    );
  }
  rows.push(
    kpiRow(
      "sessions",
      "Sessions",
      "count",
      current.sessions,
      previous.sessions,
      year?.sessions ?? null,
    ),
    kpiRow(
      "newUsers",
      "New users",
      "count",
      current.newUsers,
      previous.newUsers,
      year?.newUsers ?? null,
    ),
    kpiRow(
      "engagementRate",
      "Engagement rate",
      "percent",
      current.engagementRate,
      previous.engagementRate,
      year?.engagementRate ?? null,
    ),
    kpiRow(
      "engagementTime",
      "Avg. engagement time",
      "duration",
      current.engagementTime,
      previous.engagementTime,
      year?.engagementTime ?? null,
    ),
    kpiRow(
      "keyEvents",
      "Key events",
      "count",
      current.keyEvents,
      previous.keyEvents,
      year?.keyEvents ?? null,
    ),
    kpiRow(
      "keyEventRate",
      "Key event rate",
      "percent",
      current.keyEventRate,
      previous.keyEventRate,
      year?.keyEventRate ?? null,
    ),
  );
  if (current.revenue > 0 || previous.revenue > 0) {
    rows.push(
      kpiRow(
        "revenue",
        "Revenue",
        "money",
        current.revenue,
        previous.revenue,
        year?.revenue ?? null,
      ),
    );
  }
  return rows;
}

// --- Kanallar ------------------------------------------------------------------

const CHANNEL_METRICS = [
  "sessions",
  "engagedSessions",
  "keyEvents",
  "totalRevenue",
];

export function channelTable(
  current: readonly GaStoredSlice[],
  previous: readonly GaStoredSlice[],
  totals: GaPeriodTotals,
): ReportTable {
  const rows = aggregateSlices(
    [...current],
    ["sessionDefaultChannelGroup"],
    CHANNEL_METRICS,
  );
  const before = new Map(
    aggregateSlices(
      [...previous],
      ["sessionDefaultChannelGroup"],
      CHANNEL_METRICS,
    ).map((row) => [labelOf(row.key[0]), row.values[0] ?? 0]),
  );
  const withRevenue = rows.some((row) => (row.values[3] ?? 0) > 0);
  const shown = rows.slice(0, REPORT_CAPS.channels);
  const shownSessions = shown.reduce(
    (sum, row) => sum + (row.values[0] ?? 0),
    0,
  );
  const otherSessions = Math.max(0, totals.sessions - shownSessions);
  return {
    columns: [
      { label: "Sessions", format: "count" },
      { label: "Change", format: "percent" },
      { label: "Share", format: "percent" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key events", format: "count" },
      ...(withRevenue ? [{ label: "Revenue", format: "money" as const }] : []),
    ],
    rows: shown.map((row) => {
      const [sessions = 0, engaged = 0, keyEvents = 0, money = 0] = row.values;
      const name = labelOf(row.key[0]);
      return {
        label: name,
        values: [
          sessions,
          roundedChangePct(sessions, before.get(name) ?? null),
          ratePercent(sessions, totals.sessions),
          ratePercent(engaged, sessions),
          keyEvents,
          ...(withRevenue ? [money] : []),
        ],
      };
    }),
    // Gösterilmeyen kanalların ve (other) satırlarının toplamı.
    other:
      otherSessions > 0
        ? [
            otherSessions,
            null,
            ratePercent(otherSessions, totals.sessions),
            null,
            null,
            ...(withRevenue ? [null] : []),
          ]
        : null,
    notes: notesOf(current, previous),
  };
}

// --- Açılış sayfaları ----------------------------------------------------------

export function landingMovers(
  current: readonly GaStoredSlice[],
  previous: readonly GaStoredSlice[],
  options: { limit?: number; minSessions?: number } = {},
): { winners: ReportMover[]; losers: ReportMover[] } {
  const limit = options.limit ?? REPORT_CAPS.movers;
  const minSessions = options.minSessions ?? 20;
  const metrics = ["sessions", "keyEvents"];
  const now = aggregateSlices([...current], ["landingPage"], metrics);
  const before = aggregateSlices([...previous], ["landingPage"], metrics);
  const byPage = new Map<
    string,
    {
      sessions: number;
      keyEvents: number;
      prevSessions: number;
      prevKey: number;
    }
  >();
  for (const row of now) {
    byPage.set(labelOf(row.key[0]), {
      sessions: row.values[0] ?? 0,
      keyEvents: row.values[1] ?? 0,
      prevSessions: 0,
      prevKey: 0,
    });
  }
  for (const row of before) {
    const page = labelOf(row.key[0]);
    const entry = byPage.get(page) ?? {
      sessions: 0,
      keyEvents: 0,
      prevSessions: 0,
      prevKey: 0,
    };
    entry.prevSessions = row.values[0] ?? 0;
    entry.prevKey = row.values[1] ?? 0;
    byPage.set(page, entry);
  }
  const movers: ReportMover[] = [];
  for (const [page, entry] of byPage) {
    if (Math.max(entry.sessions, entry.prevSessions) < minSessions) continue;
    movers.push({
      page,
      sessions: entry.sessions,
      previousSessions: entry.prevSessions,
      change: entry.sessions - entry.prevSessions,
      changePct: roundedChangePct(entry.sessions, entry.prevSessions),
      keyEvents: entry.keyEvents,
      previousKeyEvents: entry.prevKey,
    });
  }
  const byName = (a: ReportMover, b: ReportMover) =>
    a.page < b.page ? -1 : a.page > b.page ? 1 : 0;
  const winners = movers
    .filter((mover) => mover.change > 0)
    .sort((a, b) => b.change - a.change || byName(a, b))
    .slice(0, limit);
  const losers = movers
    .filter((mover) => mover.change < 0)
    .sort((a, b) => a.change - b.change || byName(a, b))
    .slice(0, limit);
  return { winners, losers };
}

// --- Key event'ler -------------------------------------------------------------

export function keyEventTable(
  current: readonly GaStoredSlice[],
  previous: readonly GaStoredSlice[],
): ReportTable {
  const keyRows = (slices: readonly GaStoredSlice[]) =>
    aggregateSlices(
      [...slices],
      ["eventName", "isKeyEvent"],
      ["keyEvents", "eventCount"],
    ).filter((row) => row.key[1] === "true");
  const before = new Map(
    keyRows(previous).map((row) => [labelOf(row.key[0]), row.values[0] ?? 0]),
  );
  const rows = keyRows(current)
    .filter((row) => (row.values[0] ?? 0) > 0)
    .slice(0, REPORT_CAPS.keyEvents);
  return {
    columns: [
      { label: "Key events", format: "count" },
      { label: "Change", format: "percent" },
    ],
    rows: rows.map((row) => {
      const name = labelOf(row.key[0]);
      const count = row.values[0] ?? 0;
      return {
        label: name,
        values: [count, roundedChangePct(count, before.get(name) ?? null)],
      };
    }),
    other: null,
    notes: notesOf(current, previous),
  };
}

// --- Yapay zekâ asistanları ----------------------------------------------------

export function aiAssistantTable(
  current: readonly GaStoredSlice[],
  previous: readonly GaStoredSlice[],
): ReportTable | null {
  const metrics = ["sessions", "keyEvents"];
  const group = (slices: readonly GaStoredSlice[]) => {
    const byAssistant = new Map<
      string,
      { sessions: number; keyEvents: number }
    >();
    for (const row of aggregateSlices(
      [...slices],
      ["sessionSource"],
      metrics,
    )) {
      const assistant = aiAssistantOf(row.key[0] ?? "");
      if (!assistant) continue;
      const entry = byAssistant.get(assistant) ?? { sessions: 0, keyEvents: 0 };
      entry.sessions += row.values[0] ?? 0;
      entry.keyEvents += row.values[1] ?? 0;
      byAssistant.set(assistant, entry);
    }
    return byAssistant;
  };
  const now = group(current);
  const before = group(previous);
  const total = (map: Map<string, { sessions: number }>) =>
    [...map.values()].reduce((sum, entry) => sum + entry.sessions, 0);
  if (total(now) === 0 && total(before) === 0) return null;
  const rows = [...now.entries()]
    .filter(([, entry]) => entry.sessions > 0)
    .sort((a, b) => b[1].sessions - a[1].sessions || a[0].localeCompare(b[0]))
    .slice(0, REPORT_CAPS.aiAssistants);
  return {
    columns: [
      { label: "Sessions", format: "count" },
      { label: "Change", format: "percent" },
      { label: "Key events", format: "count" },
    ],
    rows: rows.map(([name, entry]) => ({
      label: name,
      values: [
        entry.sessions,
        roundedChangePct(entry.sessions, before.get(name)?.sessions ?? null),
        entry.keyEvents,
      ],
    })),
    other: null,
    notes: notesOf(current, previous),
  };
}

// --- Site içi arama (haftalık) -------------------------------------------------

export function siteSearchTable(
  weekSlices: readonly GaStoredSlice[] | null,
): ReportTable | null {
  if (!weekSlices || weekSlices.length === 0) return null;
  const slices = [...weekSlices];
  const rows = aggregateSlices(slices, ["searchTerm"], ["eventCount"]);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, REPORT_CAPS.siteSearch);
  const rest =
    rows
      .slice(REPORT_CAPS.siteSearch)
      .reduce((sum, row) => sum + (row.values[0] ?? 0), 0) +
    (droppedTotals(slices, ["eventCount"])[0] ?? 0);
  return {
    columns: [{ label: "Searches", format: "count" }],
    rows: shown.map((row) => ({
      label: labelOf(row.key[0]),
      values: [row.values[0] ?? 0],
    })),
    other: rest > 0 ? [rest] : null,
    notes: [...notesOf(slices), "Weekly data."],
  };
}

// --- En çok ziyaret alan sayfalar (aylık) --------------------------------------

export function topPagesTable(
  landing: readonly GaStoredSlice[],
  totals: GaPeriodTotals,
): ReportTable {
  const rows = aggregateSlices(
    [...landing],
    ["landingPage"],
    ["sessions", "engagedSessions", "keyEvents"],
  );
  const shown = rows.slice(0, REPORT_CAPS.topPages);
  const shownSessions = shown.reduce(
    (sum, row) => sum + (row.values[0] ?? 0),
    0,
  );
  const otherSessions = Math.max(0, totals.sessions - shownSessions);
  return {
    columns: [
      { label: "Sessions", format: "count" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key events", format: "count" },
    ],
    rows: shown.map((row) => {
      const [sessions = 0, engaged = 0, keyEvents = 0] = row.values;
      return {
        label: labelOf(row.key[0]),
        values: [sessions, ratePercent(engaged, sessions), keyEvents],
      };
    }),
    other: otherSessions > 0 ? [otherSessions, null, null] : null,
    notes: notesOf(landing),
  };
}

// --- Ücretli trafik (aylık) ----------------------------------------------------

const QUALITY_METRICS = ["sessions", "engagedSessions", "keyEvents"];
const CAMPAIGN_LABEL_MAX = 80;

function isPaidChannel(name: string): boolean {
  return (
    name.startsWith("Paid") || name === "Display" || name === "Cross-network"
  );
}

export function paidTrafficTable(
  channel: readonly GaStoredSlice[],
  campaign: readonly GaStoredSlice[],
): ReportTable | null {
  const channels = aggregateSlices(
    [...channel],
    ["sessionDefaultChannelGroup"],
    QUALITY_METRICS,
  )
    .filter((row) => isPaidChannel(row.key[0] ?? ""))
    .slice(0, REPORT_CAPS.paidChannels);
  const campaigns = aggregateSlices(
    [...campaign],
    ["sessionCampaignName", "sessionSource", "sessionMedium"],
    QUALITY_METRICS,
  ).slice(0, REPORT_CAPS.paidTraffic);
  if (channels.length === 0 && campaigns.length === 0) return null;
  const toValues = (values: readonly number[]) => {
    const [sessions = 0, engaged = 0, keyEvents = 0] = values;
    return [
      sessions,
      ratePercent(engaged, sessions),
      ratePercent(keyEvents, sessions),
      keyEvents,
    ];
  };
  return {
    columns: [
      { label: "Sessions", format: "count" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key event rate", format: "percent" },
      { label: "Key events", format: "count" },
    ],
    rows: [
      ...channels.map((row) => ({
        label: labelOf(row.key[0]),
        values: toValues(row.values),
      })),
      ...campaigns.map((row) => {
        const [name, source, medium] = row.key;
        // Kampanya adı serbest metindir (e-posta, telefon olabilir): maskelenir.
        const text = maskGoogleText(
          `${labelOf(name)} (${labelOf(source)} / ${labelOf(medium)})`,
        );
        return {
          label: text.slice(0, CAMPAIGN_LABEL_MAX),
          values: toValues(row.values),
        };
      }),
    ],
    other: null,
    notes: notesOf(channel, campaign),
  };
}

// --- Kanal kalitesi (plan) -----------------------------------------------------

const QUALITY_MIN_SESSIONS = 50;

export function channelQualityTable(
  channel: readonly GaStoredSlice[],
  totals: GaPeriodTotals,
): ReportTable | null {
  const rows = aggregateSlices(
    [...channel],
    ["sessionDefaultChannelGroup"],
    QUALITY_METRICS,
  )
    .filter((row) => (row.values[0] ?? 0) >= QUALITY_MIN_SESSIONS)
    .slice(0, REPORT_CAPS.channels);
  if (rows.length === 0) return null;
  const shownSessions = rows.reduce(
    (sum, row) => sum + (row.values[0] ?? 0),
    0,
  );
  const rest = Math.max(0, totals.sessions - shownSessions);
  return {
    columns: [
      { label: "Sessions", format: "count" },
      { label: "Engagement rate", format: "percent" },
      { label: "Key event rate", format: "percent" },
    ],
    rows: rows.map((row) => {
      const [sessions = 0, engaged = 0, keyEvents = 0] = row.values;
      return {
        label: labelOf(row.key[0]),
        values: [
          sessions,
          ratePercent(engaged, sessions),
          ratePercent(keyEvents, sessions),
        ],
      };
    }),
    other: rest > 0 ? [rest, null, null] : null,
    notes: notesOf(channel),
  };
}

export function bestConvertingPages(
  landing: readonly GaStoredSlice[],
  options: { limit?: number; minSessions?: number } = {},
): PlanBody["bestPages"] {
  const limit = options.limit ?? REPORT_CAPS.bestPages;
  const minSessions = options.minSessions ?? 50;
  return aggregateSlices(
    [...landing],
    ["landingPage"],
    ["sessions", "keyEvents"],
  )
    .map((row) => ({
      page: labelOf(row.key[0]),
      sessions: row.values[0] ?? 0,
      keyEvents: row.values[1] ?? 0,
    }))
    .filter((page) => page.sessions >= minSessions && page.keyEvents > 0)
    .map((page) => ({
      ...page,
      keyEventRate: (page.keyEvents / page.sessions) * 100,
    }))
    .sort(
      (a, b) =>
        b.keyEventRate - a.keyEventRate ||
        b.sessions - a.sessions ||
        a.page.localeCompare(b.page),
    )
    .slice(0, limit);
}

// --- Bulgular, ölçüm sağlığı, hedefler, tahminler ------------------------------

export function findingSnap(
  view: GaFindingView,
  input: { currency: string | null; timeZone: string; href: string },
): ReportFindingSnap {
  return {
    id: view.id,
    ruleKey: view.ruleKey,
    // Bilinmeyen kural anahtarı kartı çökertmesin: "changed" varsayılır.
    list: isGaRuleKey(view.ruleKey) ? gaRule(view.ruleKey).list : "changed",
    kind: view.kind,
    title: findingTitle(view),
    detail: findingDetail(view, { currency: input.currency }),
    impact: findingImpactText(view.impact, {
      currency: input.currency,
      finding: view,
    }),
    confidence: findingConfidenceText(view.confidence),
    period: findingPeriodText(view.period),
    explanation: view.explanation,
    status: view.status,
    outcome: view.outcome ? outcomeText(view.outcome) : null,
    preliminary: view.preliminary,
    href: input.href,
  };
}

export function measurementSnap(
  summary: MeasurementSummary | null,
  href: string,
): ReportMeasurement | null {
  if (!summary) return null;
  return {
    score: summary.score,
    label: summary.label,
    tone: summary.tone,
    issues: summary.issues,
    critical: summary.critical,
    href,
  };
}

// Yalnız rapor ayının hedefleri; final = bitmiş ayın kesin sonucu.
export function goalSnaps(
  goals: readonly GoalProgressView[],
  options: { final: boolean; month: string },
): ReportGoalSnap[] {
  return goals
    .filter((goal) => goal.month === options.month)
    .slice(0, REPORT_CAPS.goals)
    .map((goal) => ({
      goalId: goal.goalId,
      title: goal.title,
      metricKey: goal.metricKey,
      format: goalFormatOf(goal.metricKey),
      target: goal.target,
      monthToDate: goal.monthToDate,
      forecast: goal.forecast,
      low: goal.forecastLow,
      high: goal.forecastHigh,
      pace: goal.pace,
      paceLabel: paceLabel(goal.pace),
      month: goal.month,
      final: options.final,
    }));
}

const FORECAST_LABEL: Record<ForecastMetric, string> = {
  sessions: "Sessions",
  keyEvents: "Key events",
  revenue: "Revenue",
};

// Tahmin minimum günden sonra başlar: kısa geçmiş ve ayın ilk günleri notlanır.
const FORECAST_EARLY_DAY = 5;

export function forecastSnaps(
  forecasts: readonly MonthForecastView[],
): ReportForecastSnap[] {
  return forecasts.map((forecast) => ({
    metric: forecast.metric,
    label: FORECAST_LABEL[forecast.metric],
    format: forecast.metric === "revenue" ? "money" : "count",
    month: forecast.month,
    monthToDate: forecast.monthToDate,
    forecast: forecast.forecast,
    low: forecast.low,
    high: forecast.high,
    basis: forecast.basis,
    note:
      forecast.basis === "short_history"
        ? WEBSITE_REPORT_COPY.forecastShort
        : forecast.dayOfMonth < FORECAST_EARLY_DAY
          ? WEBSITE_REPORT_COPY.forecastEarly
          : null,
  }));
}
