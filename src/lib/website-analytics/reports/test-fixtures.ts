import { daysInRange } from "@/lib/website-analytics/days";
import type { GaStoredSlice } from "@/lib/website-analytics/slices";
import type { GaPeriodTotals } from "@/lib/website-analytics/totals";

import type {
  AlertBody,
  MonthlyBody,
  PlanBody,
  PulseBody,
  ReportFindingSnap,
  ReportKpi,
  ReportTable,
  ReportWindowData,
  WeeklyBody,
  WebsiteReportCardData,
} from "./types";

// GA-F5 testleri için belirlenimci örnek kartlar ve ambar yardımcıları;
// yalnız *.test.ts dosyaları içe aktarır. Her kartta her alan doludur.

// Özet, sohbet özeti ve dışa aktarma testlerinin sızdırmaması gereken metinler.
export const SAMPLE_SENSITIVE = {
  page: "/pricing",
  searchTerm: "red running shoes size 44",
  campaign: "brand-search-secret-sale",
  eventName: "generate_lead_secret",
  narrativeHeadline: "Organic search carried the week and the pricing page grew",
  scriptLabel: "<script>alert(1)</script>",
} as const;

// Örnek bir mülk: tüm kartlar aynı projeye ve bağlantıya aittir.
const BASE = {
  kind: "website-report",
  v: 1,
  projectId: "proj_1",
  linkId: "link_1",
  propertyName: "Example Shop",
  timeZone: "Europe/Skopje",
  currency: "EUR",
  builtAt: "2026-10-05T07:30:00.000Z",
  dataThrough: "2026-10-04",
  preliminary: false,
  isMock: false,
  narrative: null,
  narrativeNote: null,
} as const;

export function makeTotals(partial: Partial<GaPeriodTotals> = {}): GaPeriodTotals {
  return {
    dailyActiveUsersSum: 0,
    newUsers: 0,
    sessions: 0,
    engagedSessions: 0,
    engagementSec: 0,
    sessionDurationSec: 0,
    screenPageViews: 0,
    keyEvents: 0,
    revenueMicros: BigInt(0),
    transactions: 0,
    ...partial,
  };
}

// Kompakt saklama biçimi: satır = [boyutlar..., metrikler...].
export function makeSlice(
  day: string,
  dimensionHeaders: string[],
  metricHeaders: string[],
  rows: (string | number)[][],
): GaStoredSlice {
  return {
    day,
    dimensionHeaders,
    metricHeaders,
    rows,
    truncated: false,
    otherRow: null,
    quality: {},
  };
}

export function makeWindow(
  range: { from: string; to: string },
  partial: Partial<ReportWindowData> = {},
): ReportWindowData {
  const days = daysInRange(range.from, range.to);
  return {
    from: range.from,
    to: range.to,
    days,
    coveredDays: days,
    preliminary: false,
    totals: makeTotals(),
    channel: [],
    landing: [],
    events: [],
    sourceMedium: [],
    campaign: [],
    landingMissingDays: 0,
    ...partial,
  };
}

function kpi(
  key: ReportKpi["key"],
  label: string,
  format: ReportKpi["format"],
  value: number,
  previous: number,
  lastYear: number | null,
): ReportKpi {
  const pct = (a: number, b: number) =>
    b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10;
  return {
    key,
    label,
    format,
    value,
    previous,
    changePct: pct(value, previous),
    lastYear,
    lastYearChangePct: lastYear === null ? null : pct(value, lastYear),
  };
}

function finding(
  id: string,
  list: "changed" | "opportunities",
  title: string,
  extra: Partial<ReportFindingSnap> = {},
): ReportFindingSnap {
  return {
    id,
    ruleKey: list === "changed" ? "AN3" : "AN5",
    list,
    kind: list === "changed" ? "change" : "opportunity",
    title,
    detail: "Sessions rose from 1,200 to 1,480 on this page.",
    impact: "About 40 more key events a month",
    confidence: "Significant",
    period: "Sep 28 – Oct 4",
    explanation: null,
    status: "OPEN",
    outcome: null,
    preliminary: false,
    href: `/projects/proj_1/site#finding-${id}`,
    ...extra,
  };
}

function table(
  columns: ReportTable["columns"],
  rows: ReportTable["rows"],
  extra: Partial<ReportTable> = {},
): ReportTable {
  return { columns, rows, other: null, notes: [], ...extra };
}

const CHANNEL_COLUMNS: ReportTable["columns"] = [
  { label: "Sessions", format: "count" },
  { label: "Change", format: "percent" },
  { label: "Share", format: "percent" },
  { label: "Engagement rate", format: "percent" },
  { label: "Key events", format: "count" },
];

function channelRows(): ReportTable["rows"] {
  return [
    { label: "Organic Search", values: [2100, 12.4, 44.1, 61.2, 88] },
    { label: "Direct", values: [1200, -3.1, 25.2, 55.8, 41] },
    { label: "Paid Search", values: [900, 30, 18.9, 49.1, 52] },
    { label: SAMPLE_SENSITIVE.scriptLabel, values: [560, null, 11.8, 40.3, 6] },
  ];
}

function weeklyBody(): WeeklyBody {
  return {
    variant: "weekly",
    from: "2026-09-28",
    to: "2026-10-04",
    previous: { from: "2026-09-21", to: "2026-09-27" },
    lastYear: { from: "2025-09-29", to: "2025-10-05" },
    kpis: [
      kpi("users", "Users", "count", 3100, 2900, null),
      kpi("sessions", "Sessions", "count", 4760, 4300, 3900),
      kpi("newUsers", "New users", "count", 2200, 2000, 1800),
      kpi("engagementRate", "Engagement rate", "percent", 56.4, 54.9, 52.1),
      kpi("engagementTime", "Engagement time per session", "duration", 71, 66, 60),
      kpi("keyEvents", "Key events", "count", 187, 160, 120),
      kpi("keyEventRate", "Key event rate", "percent", 3.9, 3.7, 3.1),
    ],
    channels: table(CHANNEL_COLUMNS, channelRows(), {
      other: [100, null, 2.1, 38, 1],
    }),
    winners: [
      {
        page: SAMPLE_SENSITIVE.page,
        sessions: 640,
        previousSessions: 480,
        change: 160,
        changePct: 33.3,
        keyEvents: 31,
        previousKeyEvents: 20,
      },
      {
        page: "/blog/guide",
        sessions: 300,
        previousSessions: 240,
        change: 60,
        changePct: 25,
        keyEvents: 9,
        previousKeyEvents: 8,
      },
    ],
    losers: [
      {
        page: "/old-offer",
        sessions: 90,
        previousSessions: 210,
        change: -120,
        changePct: -57.1,
        keyEvents: 1,
        previousKeyEvents: 6,
      },
      {
        page: SAMPLE_SENSITIVE.page + "/compare",
        sessions: 110,
        previousSessions: 170,
        change: -60,
        changePct: -35.3,
        keyEvents: 2,
        previousKeyEvents: 5,
      },
    ],
    keyEvents: table(
      [
        { label: "Key events", format: "count" },
        { label: "Change", format: "percent" },
      ],
      [
        { label: SAMPLE_SENSITIVE.eventName, values: [120, 20] },
        { label: "purchase", values: [67, 8.1] },
      ],
    ),
    aiAssistants: table(
      [
        { label: "Sessions", format: "count" },
        { label: "Change", format: "percent" },
      ],
      [
        { label: "chatgpt.com", values: [42, 40] },
        { label: "perplexity.ai", values: [11, null] },
      ],
    ),
    siteSearch: table(
      [
        { label: "Searches", format: "count" },
        { label: "Change", format: "percent" },
      ],
      [{ label: SAMPLE_SENSITIVE.searchTerm, values: [14, 21.5] }],
    ),
    measurement: {
      score: 82,
      label: "Good",
      tone: "ok",
      issues: 2,
      critical: 0,
      href: "/projects/proj_1/site#measurement-health",
    },
    insights: "on",
    whatChanged: [
      finding("f1", "changed", "Organic Search grew"),
      finding("f2", "changed", "Pricing page gained visits"),
    ],
    opportunities: [
      finding("f3", "opportunities", "Improve the checkout step"),
      finding("f4", "opportunities", "Add a lead form to the guide"),
    ],
    goals: [
      {
        goalId: "goal_1",
        title: "Website sessions per month",
        metricKey: "web.sessions",
        format: "count",
        target: 25000,
        monthToDate: 4760,
        forecast: 18400,
        low: 16900,
        high: 19900,
        pace: "at_risk",
        paceLabel: "At risk",
        month: "2026-10",
        final: false,
      },
    ],
    forecasts: [
      {
        metric: "sessions",
        label: "Sessions",
        format: "count",
        month: "2026-10",
        monthToDate: 4760,
        forecast: 18400,
        low: 16900,
        high: 19900,
        basis: "ok",
        note: null,
      },
    ],
    nextSteps: ["Review the checkout step on the Website page."],
    nextStepsSource: "ai",
    notes: ["Numbers from the last 7 days may still change slightly."],
  };
}

export function sampleWeeklyCard(
  partial: Partial<WebsiteReportCardData> = {},
): WebsiteReportCardData {
  return {
    ...BASE,
    variant: "weekly",
    title: "Weekly website report · Sep 28 – Oct 4",
    periodLabel: "Sep 28 – Oct 4",
    preliminary: true,
    body: weeklyBody(),
    narrative: {
      headline: SAMPLE_SENSITIVE.narrativeHeadline,
      highlights: ["Sessions grew 10.7% on the week before."],
      watchouts: ["The old offer page lost most of its visits."],
      nextSteps: ["Review the checkout step."],
    },
    narrativeNote: null,
    ...partial,
  };
}

function monthlyBody(): MonthlyBody {
  const weekly = weeklyBody();
  return {
    variant: "monthly",
    month: "2026-09",
    from: "2026-09-01",
    to: "2026-09-30",
    previous: { from: "2026-08-01", to: "2026-08-31" },
    lastYear: { from: "2025-09-01", to: "2025-09-30" },
    kpis: weekly.kpis.filter((row) => row.key !== "users"),
    channels: weekly.channels,
    winners: weekly.winners,
    losers: weekly.losers,
    keyEvents: weekly.keyEvents,
    aiAssistants: weekly.aiAssistants,
    siteSearch: null,
    measurement: weekly.measurement,
    insights: "on",
    whatChanged: [finding("f5", "changed", "Direct traffic fell")],
    opportunities: [finding("f6", "opportunities", "Speed up the landing page")],
    goals: [
      {
        goalId: "goal_1",
        title: "Website sessions per month",
        metricKey: "web.sessions",
        format: "count",
        target: 20000,
        monthToDate: 19100,
        forecast: 19100,
        low: 19100,
        high: 19100,
        pace: "on_track",
        paceLabel: "On track",
        month: "2026-09",
        final: true,
      },
    ],
    topPages: table(
      [
        { label: "Sessions", format: "count" },
        { label: "Key events", format: "count" },
        { label: "Share", format: "percent" },
      ],
      [
        { label: "/", values: [5200, 80, 27.2] },
        { label: SAMPLE_SENSITIVE.page, values: [2600, 120, 13.6] },
      ],
    ),
    paidTraffic: table(
      [
        { label: "Sessions", format: "count" },
        { label: "Key events", format: "count" },
        { label: "Revenue", format: "money" },
      ],
      [
        { label: SAMPLE_SENSITIVE.campaign, values: [1400, 60, 2310.5] },
        { label: "Paid Search", values: [3200, 140, 5120] },
      ],
    ),
    outcomes: {
      worked: 1,
      didnt: 0,
      inconclusive: 1,
      items: [
        finding("f7", "opportunities", "Shorten the signup form", {
          status: "DONE",
          outcome: "WORKED",
        }),
      ],
    },
    nextSteps: [],
    nextStepsSource: "findings",
    notes: [],
  };
}

export function sampleMonthlyCard(
  partial: Partial<WebsiteReportCardData> = {},
): WebsiteReportCardData {
  return {
    ...BASE,
    variant: "monthly",
    title: "Monthly website report · September 2026",
    periodLabel: "September 2026",
    builtAt: "2026-10-02T07:30:00.000Z",
    dataThrough: "2026-09-30",
    body: monthlyBody(),
    narrative: {
      headline: "September closed close to its sessions target",
      highlights: ["Paid Search drove most of the key events."],
      watchouts: [],
      nextSteps: ["Plan the October campaign budget."],
    },
    narrativeNote: null,
    ...partial,
  };
}

function planBody(): PlanBody {
  return {
    variant: "plan",
    month: "2026-10",
    proposals: [
      {
        metricKey: "web.sessions",
        label: "Sessions",
        format: "count",
        baseline: 18000,
        baselineMonths: 3,
        seasonalPct: 4,
        realistic: 18700,
        low: 20600,
        high: 21500,
        suggested: 21000,
        currentGoal: { goalId: "goal_1", target: 20000 },
      },
      {
        metricKey: "web.revenue",
        label: "Revenue",
        format: "money",
        baseline: 7200.5,
        baselineMonths: 3,
        seasonalPct: null,
        realistic: 7200.5,
        low: 7920.55,
        high: 8280.58,
        suggested: 7900,
        currentGoal: null,
      },
    ],
    proposalNote: null,
    topFindings: [finding("f8", "opportunities", "Improve the checkout step")],
    bestPages: [
      { page: SAMPLE_SENSITIVE.page, sessions: 2600, keyEvents: 120, keyEventRate: 4.6 },
      { page: "/blog/guide", sessions: 900, keyEvents: 30, keyEventRate: 3.3 },
    ],
    channelQuality: table(
      [
        { label: "Sessions", format: "count" },
        { label: "Key event rate", format: "percent" },
      ],
      [
        { label: "Organic Search", values: [8400, 4.2] },
        { label: "Paid Search", values: [3200, 4.4] },
      ],
    ),
    forecasts: [
      {
        metric: "sessions",
        label: "Sessions",
        format: "count",
        month: "2026-10",
        monthToDate: 4760,
        forecast: 18400,
        low: 16900,
        high: 19900,
        basis: "ok",
        note: null,
      },
    ],
  };
}

export function samplePlanCard(
  partial: Partial<WebsiteReportCardData> = {},
): WebsiteReportCardData {
  return {
    ...BASE,
    variant: "plan",
    title: "Next month plan · October 2026",
    periodLabel: "October 2026",
    builtAt: "2026-10-02T08:10:00.000Z",
    dataThrough: "2026-10-01",
    body: planBody(),
    narrative: null,
    narrativeNote: null,
    ...partial,
  };
}

function pulseBody(): PulseBody {
  return {
    variant: "pulse",
    day: "2026-10-05",
    kpis: [
      {
        key: "sessions",
        label: "Sessions",
        format: "count",
        value: 980,
        usual: 640,
        changePct: 53.1,
        unusual: true,
      },
      {
        key: "keyEvents",
        label: "Key events",
        format: "count",
        value: 31,
        usual: 28,
        changePct: 10.7,
        unusual: false,
      },
      {
        key: "engagementRate",
        label: "Engagement rate",
        format: "percent",
        value: 52.5,
        usual: 56,
        changePct: -6.3,
        unusual: false,
      },
      {
        key: "revenue",
        label: "Revenue",
        format: "money",
        value: 410.5,
        usual: 380,
        changePct: 8,
        unusual: false,
      },
    ],
    changes: [{ channel: "Paid Search", sessions: 420, usual: 180, change: 240 }],
    alerts: [
      {
        title: "Purchase events stopped arriving",
        severity: "CRITICAL",
        href: "/projects/proj_1/site#measurement-health",
        isNew: true,
      },
      {
        title: "Some pages have no tag",
        severity: "WARN",
        href: "/projects/proj_1/site#measurement-health",
        isNew: false,
      },
    ],
    anomalies: [finding("f9", "changed", "Sessions jumped on Monday")],
    holiday: false,
    suspect: false,
    reasons: ["alert", "unusual", "anomaly"],
  };
}

export function samplePulseCard(
  partial: Partial<WebsiteReportCardData> = {},
): WebsiteReportCardData {
  return {
    ...BASE,
    variant: "pulse",
    title: "Website pulse · Mon, Oct 5",
    periodLabel: "Mon, Oct 5",
    builtAt: "2026-10-06T06:15:00.000Z",
    dataThrough: "2026-10-05",
    body: pulseBody(),
    narrative: null,
    narrativeNote: null,
    ...partial,
  };
}

function alertBody(): AlertBody {
  return {
    variant: "alert",
    alertId: "alert_1",
    kind: "GA_MH1",
    severity: "CRITICAL",
    title: "The Google tag is missing from your site",
    href: "/projects/proj_1/site#measurement-health",
    reconnect: false,
    openedAt: "2026-10-05T09:00:00.000Z",
  };
}

export function sampleAlertCard(
  partial: Partial<WebsiteReportCardData> = {},
): WebsiteReportCardData {
  return {
    ...BASE,
    variant: "alert",
    title: "Tracking alert: The Google tag is missing from your site",
    periodLabel: "Oct 5",
    builtAt: "2026-10-05T09:05:00.000Z",
    dataThrough: "2026-10-04",
    body: alertBody(),
    narrative: null,
    narrativeNote: null,
    ...partial,
  };
}
