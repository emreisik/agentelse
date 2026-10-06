import {
  formatCount,
  formatPercent,
  formatPosition,
} from "@/lib/module-flows/analytics/format";

import type {
  DiagnoseStepKey,
  DiagnoseVerdict,
  GoalPace,
  SeoKpiKey,
  SeoReportKind,
  SeoReportKpi,
  SeoTableKey,
} from "./types";

// SEO raporlarının arayüz metinleri (docs/search-reports.md). Tüm metinler
// İngilizcedir; sayı ve tarih biçimi sabit yerelle yazılır ki sunucu ve
// tarayıcı çıktısı aynı olsun. Saf ve izomorfik.

export const SEO_REPORT_TITLE: Readonly<Record<SeoReportKind, string>> = {
  PULSE: "Search pulse",
  WEEKLY: "Weekly SEO report",
  MONTHLY: "Monthly SEO report",
  ROADMAP: "SEO roadmap",
};

export const KPI_LABEL: Readonly<Record<SeoKpiKey, string>> = {
  nonBrandClicks: "Non-brand clicks",
  brandClicks: "Brand clicks",
  clicks: "Clicks",
  impressions: "Impressions",
  ctr: "CTR",
  position: "Avg. position",
};

export const TABLE_TITLE: Readonly<Record<SeoTableKey, string>> = {
  winning_queries: "Queries that gained clicks",
  losing_queries: "Queries that lost clicks",
  winning_pages: "Pages that gained clicks",
  losing_pages: "Pages that lost clicks",
  rising_queries: "Rising searches",
};

export const DIAGNOSE_STEP_QUESTION: Readonly<Record<DiagnoseStepKey, string>> =
  {
    data: "Is it a data or connection problem?",
    indexing: "Did pages drop out of Google's index?",
    technical: "Is something on the site blocking Google?",
    update: "Did a Google update roll out?",
    demand: "Are fewer people searching?",
    ranking: "Did positions drop?",
    ctr: "Are fewer people clicking at the same position?",
    cannibalization: "Did another of your pages take over?",
  };

export const DIAGNOSE_CAUSE: Readonly<Record<DiagnoseStepKey, string>> = {
  data: "a data or connection problem",
  indexing: "pages dropping out of Google's index",
  technical: "a technical problem on the site",
  update: "a Google update",
  demand: "lower search demand",
  ranking: "lower positions",
  ctr: "fewer clicks at the same position",
  cannibalization: "another of your pages taking over",
};

export const VERDICT_LABEL: Readonly<Record<DiagnoseVerdict, string>> = {
  yes: "Yes",
  no: "No",
  unknown: "Can't tell",
};

export const PACE_TEXT: Readonly<Record<GoalPace, string>> = {
  achieved: "Reached",
  on_track: "On track",
  behind: "Behind",
  at_risk: "At risk",
  unknown: "Not enough data",
};

// Anlatı yokken nedenini söyleyen tek cümleler. `mock` metni A, D ve E
// testlerinin ortak kanonik metnidir.
export const NARRATIVE_NOTE = {
  mock: "AI summary isn't available with sample data.",
  budget:
    "The AI summary was skipped today because the daily AI limit was reached. The numbers are complete.",
  failed: "The AI summary couldn't be written this time.",
  dropped: "The AI summary was left out because it didn't match the numbers.",
};

export const SEO_REPORT_COPY = {
  keyNumbers: "Key numbers",
  notesHeading: "Notes",
  highlights: "Highlights",
  watchouts: "Watch outs",
  nextSteps: "Next steps",
  healthHeading: "Search health",
  opportunitiesHeading: "Opportunities",
  actionsHeading: "Actions and results",
  updatesHeading: "Google updates and incidents",
  diagnosisHeading: "Why clicks dropped",
  goalsHeading: "SEO goals",
  forecastHeading: "Next month",
  roadmapActionsHeading: "What to do next",
  roadmapDebtHeading: "Technical to-do list",
  pulseHeading: "Search pulse",
  checkInSearchConsole: "Check in Search Console",
  directional: "directional",
  footer:
    "Numbers from Google Search Console, stored by Agentelse. Search Console days (Pacific Time).",
  sampleBadge: "Sample data",
  removed: "This report is no longer stored.",
} as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// "2026-10-03" → { year: 2026, month: 9 (0 tabanlı), day: 3 }; bozuk anahtar null.
function parseDay(day: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return null;
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) return null;
  return { year: Number(match[1]), month, day: Number(match[3]) };
}

// "2026-10-03" → "Oct 3" (gün anahtarının UTC takvimi; yerel saat girmez).
export function dayLabel(day: string): string {
  const parsed = parseDay(day);
  return parsed ? `${MONTHS[parsed.month]} ${parsed.day}` : day;
}

function dayLabelWithYear(day: string): string {
  const parsed = parseDay(day);
  return parsed ? `${dayLabel(day)}, ${parsed.year}` : day;
}

// "Sep 29 – Oct 5"; yıllar farklıysa "Dec 29, 2025 – Jan 4, 2026"; tek gün
// dayLabel.
export function periodLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from);
  const a = parseDay(from);
  const b = parseDay(to);
  if (a && b && a.year !== b.year) {
    return `${dayLabelWithYear(from)} – ${dayLabelWithYear(to)}`;
  }
  return `${dayLabel(from)} – ${dayLabel(to)}`;
}

// "2026-09-01" → "September 2026".
export function monthLabel(monthStart: string): string {
  const parsed = parseDay(monthStart);
  return parsed ? `${MONTH_NAMES[parsed.month]} ${parsed.year}` : monthStart;
}

// Command.replyText: yalnız çeşit ve etiketten; Google verisi taşımaz.
export function seoReportReply(
  kind: SeoReportKind,
  periodLabelText: string,
): string {
  return `${SEO_REPORT_TITLE[kind]} for ${periodLabelText}.`;
}

export function seoWorkSummary(kind: SeoReportKind): string {
  return SEO_REPORT_TITLE[kind];
}

export function kpiValueText(
  kpi: SeoReportKpi,
  which: "value" | "previous" | "yearAgo" = "value",
): string {
  const value = kpi[which];
  if (value === null) return "—";
  if (kpi.format === "percent") return formatPercent(value);
  if (kpi.format === "position") return formatPosition(value);
  return formatCount(value);
}

// YÜZDE biriminde: 12.3 → "+12%", −5 → "−5%" (Unicode eksi), null → "—".
export function changeText(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const rounded = Math.round(Math.abs(pct));
  if (rounded === 0) return "0%";
  return `${pct > 0 ? "+" : "−"}${rounded}%`;
}

// KESİR biriminde: −0.3 → "−30%".
export function changeTextFromRatio(ratio: number | null): string {
  return changeText(ratio === null ? null : ratio * 100);
}
