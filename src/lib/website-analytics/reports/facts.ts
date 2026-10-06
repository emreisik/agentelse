import { formatMetric } from "@/lib/module-flows/analytics/format";
import { allowedNumbersOf } from "@/lib/module-flows/analytics/number-check";
import { findingFacts } from "@/lib/website-analytics/analysis/describe";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import { daysInRange } from "@/lib/website-analytics/days";
import {
  maskGooglePath,
  maskGoogleText,
} from "@/server/integrations/google/pii";

import { WEBSITE_REPORT_COPY } from "./copy";
import { WEBSITE_GOAL_LABEL } from "./goal-keys";
import { safeOperatorTitle } from "./text";
import type {
  ReportFindingSnap,
  ReportMover,
  ReportTable,
  WebsiteReportCardData,
} from "./types";

// GA-F5 anlatı olguları: haftalık/aylık kartın LLM'e verilen özeti. Yalnız
// toplanmış rakamlar (arayüzdeki gibi biçimlenmiş) ve en çok 20 maskeli
// Google metni (sayfa yolu, olay adı, bulgu konusu) girer. Arama terimi,
// kampanya adı ve yapay zekâ asistanı satırları HİÇ girmez. Saf ve
// izomorfik.

// Bir raporda LLM'e giden Google kaynaklı metin sayısı üst sınırı.
export const REPORT_LLM_MAX_STRINGS = 20;

// En çok bu kadar bulgu olguya girer.
const MAX_FINDINGS = 5;

export type WebsiteReportFacts = {
  report: "weekly" | "monthly";
  period: "last week" | "last month";
  days: number;
  comparedWith: "the week before" | "the month before";
  kpis: {
    name: string;
    value: string;
    previous: string | null;
    changePct: number | null;
    lastYear: string | null;
    lastYearChangePct: number | null;
  }[];
  channels: {
    name: string;
    sessions: number;
    changePct: number | null;
    sharePct: number | null;
    engagementRatePct: number | null;
    keyEvents: number;
  }[];
  pagesUp: { page: string; sessions: number; previousSessions: number }[];
  pagesDown: { page: string; sessions: number; previousSessions: number }[];
  keyEvents: { name: string; count: number; changePct: number | null }[];
  aiAssistantSessions: number | null;
  measurement: {
    score: number | null;
    issues: number;
    critical: number;
  } | null;
  findings: {
    list: "changed" | "opportunities";
    title: string;
    confidence: string;
    facts: Record<string, unknown>;
  }[];
  goals: {
    name: string;
    target: number | null;
    soFar: number;
    forecast: number | null;
    status: string;
  }[];
  forecasts: {
    name: string;
    soFar: number;
    forecast: number | null;
    low: number | null;
    high: number | null;
  }[];
  notes: string[];
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Google metni sayılmayan değerler: gün anahtarları (ürettiğimiz tarih).
function isDayKey(value: string): boolean {
  return DAY_KEY.test(value);
}

function maskString(value: string): string {
  return value.startsWith("/") ? maskGooglePath(value) : maskGoogleText(value);
}

// Olgudaki her metni maskeler ve sayar; iç içe nesne ve dizi gezilir.
function maskDeep(value: unknown): { value: unknown; strings: number } {
  if (typeof value === "string") {
    return isDayKey(value)
      ? { value, strings: 0 }
      : { value: maskString(value), strings: 1 };
  }
  if (Array.isArray(value)) {
    let strings = 0;
    const items = value.map((item) => {
      const masked = maskDeep(item);
      strings += masked.strings;
      return masked.value;
    });
    return { value: items, strings };
  }
  if (value && typeof value === "object") {
    let strings = 0;
    const entries: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const masked = maskDeep(item);
      strings += masked.strings;
      entries[key] = masked.value;
    }
    return { value: entries, strings };
  }
  return { value, strings: 0 };
}

function columnOf(table: ReportTable, label: string): number {
  return table.columns.findIndex((column) => column.label === label);
}

function cell(
  table: ReportTable,
  values: readonly (number | null)[],
  label: string,
): number | null {
  const index = columnOf(table, label);
  return index < 0 ? null : (values[index] ?? null);
}

// numberTokens işaretsizdir ("10.7" bir sayı, "-" değil): model "fell 10.7%"
// yazınca −10.7'lik bir değişim eşleşsin diye izinli sayılara her sayının
// mutlak değeri de eklenir (düşüşü anlatan cümleler atılmasın).
export function narrativeAllowedNumbers(facts: unknown): number[] {
  const allowed = allowedNumbersOf(facts);
  return [...new Set([...allowed, ...allowed.map((value) => Math.abs(value))])];
}

export function reportFactsOf(
  card: WebsiteReportCardData,
  findings: readonly GaFindingView[],
): { facts: WebsiteReportFacts; googleStrings: number } | null {
  const body = card.body;
  if (body.variant !== "weekly" && body.variant !== "monthly") return null;
  const weekly = body.variant === "weekly";
  const currency = card.currency;
  let budget = REPORT_LLM_MAX_STRINGS;

  // 1. Bulgular: başlık genel, olgular maskeli; sığmayan bulgu bütün düşer.
  const picked: {
    list: "changed" | "opportunities";
    snap: ReportFindingSnap;
  }[] = [
    ...body.whatChanged.map((snap) => ({ list: "changed" as const, snap })),
    ...body.opportunities.map((snap) => ({
      list: "opportunities" as const,
      snap,
    })),
  ];
  const viewById = new Map(findings.map((view) => [view.id, view]));
  const findingFactsList: WebsiteReportFacts["findings"] = [];
  for (const { list, snap } of picked) {
    if (findingFactsList.length >= MAX_FINDINGS) break;
    const view = viewById.get(snap.id);
    if (!view) continue;
    const masked = maskDeep(findingFacts(view, { currency }));
    if (masked.strings > budget) continue;
    budget -= masked.strings;
    findingFactsList.push({
      list,
      title: safeOperatorTitle(snap.ruleKey, snap.kind),
      confidence: snap.confidence,
      facts: masked.value as Record<string, unknown>,
    });
  }

  // 2. Sayfalar: her biri bir metin.
  const pagesOf = (movers: readonly ReportMover[]) => {
    const out: WebsiteReportFacts["pagesUp"] = [];
    for (const mover of movers) {
      if (budget <= 0) break;
      budget -= 1;
      out.push({
        page: maskGooglePath(mover.page),
        sessions: mover.sessions,
        previousSessions: mover.previousSessions,
      });
    }
    return out;
  };
  const pagesUp = pagesOf(body.winners);
  const pagesDown = pagesOf(body.losers);

  // 3. Key event adları.
  const keyEvents: WebsiteReportFacts["keyEvents"] = [];
  const eventCount = columnOf(body.keyEvents, "Key events");
  for (const row of body.keyEvents.rows) {
    if (budget <= 0) break;
    budget -= 1;
    keyEvents.push({
      name: maskGoogleText(row.label),
      count: eventCount < 0 ? 0 : (row.values[eventCount] ?? 0),
      changePct: cell(body.keyEvents, row.values, "Change"),
    });
  }

  const ai = body.aiAssistants;
  const aiAssistantSessions = ai
    ? ai.rows.reduce(
        (sum, row) => sum + (cell(ai, row.values, "Sessions") ?? 0),
        0,
      )
    : null;

  const facts: WebsiteReportFacts = {
    report: weekly ? "weekly" : "monthly",
    period: weekly ? "last week" : "last month",
    days: daysInRange(body.from, body.to),
    comparedWith: weekly ? "the week before" : "the month before",
    kpis: body.kpis.flatMap((kpi) =>
      kpi.value === null
        ? []
        : [
            {
              name: kpi.label,
              value: formatMetric(kpi.format, kpi.value, currency),
              previous:
                kpi.previous === null
                  ? null
                  : formatMetric(kpi.format, kpi.previous, currency),
              changePct: kpi.changePct,
              lastYear:
                kpi.lastYear === null
                  ? null
                  : formatMetric(kpi.format, kpi.lastYear, currency),
              lastYearChangePct: kpi.lastYearChangePct,
            },
          ],
    ),
    // GA varsayılan kanal grubu adları Google metni sayılmaz.
    channels: body.channels.rows.map((row) => ({
      name: row.label,
      sessions: cell(body.channels, row.values, "Sessions") ?? 0,
      changePct: cell(body.channels, row.values, "Change"),
      sharePct: cell(body.channels, row.values, "Share"),
      engagementRatePct: cell(body.channels, row.values, "Engagement rate"),
      keyEvents: cell(body.channels, row.values, "Key events") ?? 0,
    })),
    pagesUp,
    pagesDown,
    keyEvents,
    aiAssistantSessions,
    measurement: body.measurement
      ? {
          score: body.measurement.score,
          issues: body.measurement.issues,
          critical: body.measurement.critical,
        }
      : null,
    findings: findingFactsList,
    goals: body.goals.map((goal) => ({
      name: WEBSITE_GOAL_LABEL[goal.metricKey],
      target: goal.target,
      soFar: goal.monthToDate,
      forecast: goal.forecast,
      status: goal.paceLabel,
    })),
    forecasts: weekly
      ? body.forecasts.map((forecast) => ({
          name: forecast.label,
          soFar: forecast.monthToDate,
          forecast: forecast.forecast,
          low: forecast.low,
          high: forecast.high,
        }))
      : [],
    notes: body.notes.filter(
      (note) => note !== WEBSITE_REPORT_COPY.snapshotNote,
    ),
  };

  return { facts, googleStrings: REPORT_LLM_MAX_STRINGS - budget };
}
