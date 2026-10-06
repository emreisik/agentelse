import { allowedNumbersOf } from "@/lib/module-flows/analytics/number-check";
import { limitGoogleStrings } from "@/lib/seo/llm-budget";
import {
  maskGooglePath,
  maskGoogleText,
} from "@/server/integrations/google/pii";

import { kpiChangePct } from "./kpis";
import { DIAGNOSE_CAUSE, kpiValueText, monthLabel } from "./text";
import type {
  SearchDiagnosis,
  SeoReportRow,
  SeoReportSnapshot,
  SeoTableKey,
} from "./types";

// Anlatıya (LLM) giden olgular (docs/search-reports.md "Anlatı"). Sayılar
// yalnız anlık görüntüden gelir; Google dizgileri (sorgu, sayfa yolu, bulgu
// başlığı) maskelenir ve en çok 20 farklı dizgiyle sınırlanır. Saf ve
// izomorfik.
// BİRİM: buradaki *Pct alanları YÜZDEDİR (kpiChangePct gibi).

export type SeoNarrativeFacts = {
  report: "weekly" | "monthly";
  period: string;
  compare: string | null;
  yearAgo: string | null;
  site: string;
  kpis: {
    metric: string;
    value: string;
    previous: string | null;
    changePct: number | null;
    yearAgo: string | null;
    yoyPct: number | null;
  }[];
  anonymousSharePct: number | null;
  tables: {
    title: string;
    rows: {
      text: string;
      clicks: number;
      change: number;
      position: number | null;
    }[];
  }[];
  health: {
    score: number | null;
    critical: number;
    warn: number;
    issues: string[];
    coveragePct: { point: number; low: number; high: number } | null;
    cwv: { phone: string | null; desktop: string | null } | null;
  } | null;
  opportunities: {
    action: string;
    title: string;
    clicksPerMonth: number | null;
  }[];
  actions: { accepted: number; done: number; evaluated: number } | null;
  diagnosis: { cause: string | null; evidence: string[] } | null;
  goals: {
    goal: string;
    target: number | null;
    current: number | null;
    pace: string;
  }[];
  forecast: {
    month: string;
    value: number;
    low: number;
    high: number;
    method: string;
  } | null;
  updates: string[];
  notes: string[];
};

const MAX_EVIDENCE = 3;

// Tablolar bütçeye bu sırayla girer: önce kaybedenler, en son fırsatlar.
const TABLE_PRIORITY: readonly SeoTableKey[] = [
  "losing_queries",
  "winning_queries",
  "losing_pages",
  "winning_pages",
  "rising_queries",
];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isPageTable(key: SeoTableKey): boolean {
  return key.endsWith("_pages");
}

function maskedLabel(row: SeoReportRow, page: boolean): string {
  return page ? maskGooglePath(row.label) : maskGoogleText(row.label);
}

// Teşhis öğesinin etiketi sorgu ya da yol olabilir; "/" ile başlayan yoldur.
function maskedItemLabel(label: string): string {
  return label.startsWith("/") ? maskGooglePath(label) : maskGoogleText(label);
}

// Bölünme (cannibalization) öğesinin detayı "/a → /b" biçiminde iki sayfa yolu
// taşır; bunlar da Google dizgisidir: yol gibi maskelenir ve bütçeye sayılır.
const DETAIL_ARROW = " → ";

function detailPaths(detail: string): string[] {
  return detail.includes(DETAIL_ARROW)
    ? detail.split(DETAIL_ARROW).map(maskedItemLabel)
    : [];
}

function maskedItemDetail(detail: string): string {
  const paths = detailPaths(detail);
  return paths.length > 0 ? paths.join(DETAIL_ARROW) : maskGoogleText(detail);
}

type Entry<T> = { value: T; text: string };

export function seoNarrativeFacts(snapshot: SeoReportSnapshot): {
  facts: SeoNarrativeFacts;
  googleStrings: number;
} {
  // Google dizgisi taşıyan öğeler: tablo satırları (öncelik sırasıyla) ve
  // fırsat başlıkları. Tek bir limitGoogleStrings çağrısı bütçeyi birlikte
  // uygular; sığmayan satır düşer.
  const rowEntries: { key: SeoTableKey; entry: Entry<SeoReportRow> }[] = [];
  for (const key of TABLE_PRIORITY) {
    for (const section of snapshot.sections) {
      if (section.type !== "table" || section.table.key !== key) continue;
      for (const row of section.table.rows) {
        rowEntries.push({
          key,
          entry: { value: row, text: maskedLabel(row, isPageTable(key)) },
        });
      }
    }
  }
  const opportunityEntries: Entry<{
    action: string;
    title: string;
    clicksPerMonth: number | null;
  }>[] = [];
  for (const section of snapshot.sections) {
    if (section.type !== "opportunities") continue;
    for (const item of section.items) {
      opportunityEntries.push({
        value: {
          action: item.action,
          title: maskGoogleText(item.title),
          clicksPerMonth: item.impactPerMonth,
        },
        text: maskGoogleText(item.title),
      });
    }
  }
  const budget = limitGoogleStrings<
    | { kind: "row"; item: (typeof rowEntries)[number] }
    | { kind: "opp"; item: (typeof opportunityEntries)[number] }
  >(
    [
      ...rowEntries.map((item) => ({ kind: "row" as const, item })),
      ...opportunityEntries.map((item) => ({ kind: "opp" as const, item })),
    ],
    (entry) => [entry.kind === "row" ? entry.item.entry.text : entry.item.text],
  );
  const keptRows = new Set(
    budget.items.flatMap((entry) => (entry.kind === "row" ? [entry.item] : [])),
  );
  const keptOpportunities = budget.items.flatMap((entry) =>
    entry.kind === "opp" ? [entry.item.value] : [],
  );

  const facts: SeoNarrativeFacts = {
    report: snapshot.kind === "WEEKLY" ? "weekly" : "monthly",
    period: snapshot.period.label,
    compare: snapshot.compare?.label ?? null,
    yearAgo: snapshot.yearAgo?.label ?? null,
    site: snapshot.site.label,
    kpis: [],
    anonymousSharePct:
      snapshot.anonymousShare === null
        ? null
        : round1(snapshot.anonymousShare * 100),
    tables: [],
    health: null,
    opportunities: keptOpportunities,
    actions: null,
    diagnosis: null,
    goals: [],
    forecast: null,
    updates: [],
    notes: snapshot.notes,
  };

  for (const section of snapshot.sections) {
    switch (section.type) {
      case "kpis":
        facts.kpis = section.kpis.map((kpi) => ({
          metric: kpi.label,
          value: kpiValueText(kpi),
          previous:
            kpi.previous === null ? null : kpiValueText(kpi, "previous"),
          changePct: kpiChangePct(kpi, "previous"),
          yearAgo: kpi.yearAgo === null ? null : kpiValueText(kpi, "yearAgo"),
          yoyPct: kpiChangePct(kpi, "yearAgo"),
        }));
        break;
      case "table": {
        const rows = rowEntries
          .filter(
            (item) =>
              keptRows.has(item) &&
              item.key === section.table.key &&
              section.table.rows.includes(item.entry.value),
          )
          .map((item) => ({
            text: item.entry.text,
            clicks: item.entry.value.clicks,
            change: item.entry.value.clicks - item.entry.value.previousClicks,
            position: item.entry.value.position,
          }));
        if (rows.length > 0) {
          facts.tables.push({ title: section.table.title, rows });
        }
        break;
      }
      case "health": {
        const { health } = section;
        facts.health = {
          score: health.score,
          critical: health.critical,
          warn: health.warn,
          issues: health.issues.map((issue) => maskGoogleText(issue.title)),
          coveragePct: health.coverage
            ? {
                point: Math.round(health.coverage.point * 100),
                low: Math.round(health.coverage.low * 100),
                high: Math.round(health.coverage.high * 100),
              }
            : null,
          cwv: health.cwv
            ? { phone: health.cwv.phone, desktop: health.cwv.desktop }
            : null,
        };
        break;
      }
      case "actions":
        facts.actions = {
          accepted: section.actions.accepted,
          done: section.actions.done,
          evaluated: section.actions.evaluated,
        };
        break;
      case "diagnosis": {
        const { diagnosis } = section;
        const primary = diagnosis.steps.find(
          (step) => step.key === diagnosis.primary,
        );
        facts.diagnosis = {
          cause: diagnosis.primary ? DIAGNOSE_CAUSE[diagnosis.primary] : null,
          evidence: primary ? primary.evidence.slice(0, MAX_EVIDENCE) : [],
        };
        break;
      }
      case "goals":
        facts.goals = section.goals.map((goal) => ({
          goal: goal.title,
          target: goal.target,
          current: goal.current,
          pace: goal.paceLabel,
        }));
        break;
      case "forecast":
        facts.forecast = {
          month: monthLabel(section.forecast.month),
          value: section.forecast.value,
          low: section.forecast.low,
          high: section.forecast.high,
          method: section.forecast.method,
        };
        break;
      case "updates":
        facts.updates = section.items.map((item) => item.name);
        break;
      default:
        break;
    }
  }

  return { facts, googleStrings: budget.used };
}

// numberTokens işaretsizdir ("12.3" bir sayı, "-" değil): model "fell 12.3%"
// yazınca −12.3'lük bir değişim eşleşsin diye izinli sayılara her sayının
// mutlak değeri de eklenir.
export function narrativeAllowedNumbers(facts: unknown): number[] {
  const allowed = allowedNumbersOf(facts);
  return [...new Set([...allowed, ...allowed.map((value) => Math.abs(value))])];
}

// Sohbet aracı için teşhis olguları: en çok 20 farklı Google dizgisi (öğe
// etiketleri), aynı maskeleme; değişim YÜZDE ve 1 ondalık.
export function diagnosisFacts(
  diagnosis: SearchDiagnosis,
): Record<string, unknown> {
  const candidates = diagnosis.steps.flatMap((step, stepIndex) =>
    step.items.map((item) => ({
      stepIndex,
      label: maskedItemLabel(item.label),
      detail: maskedItemDetail(item.detail),
    })),
  );
  const budget = limitGoogleStrings(candidates, (item) => [
    item.label,
    ...detailPaths(item.detail),
  ]);
  const kept = new Set(budget.items);
  return {
    metric: diagnosis.metric,
    changePct:
      diagnosis.changePct === null ? null : round1(diagnosis.changePct * 100),
    current: diagnosis.current,
    previous: diagnosis.previous,
    cause: diagnosis.primary ? DIAGNOSE_CAUSE[diagnosis.primary] : null,
    also: diagnosis.also.map((key) => DIAGNOSE_CAUSE[key]),
    steps: diagnosis.steps.map((step, stepIndex) => ({
      question: step.question,
      verdict: step.verdict,
      evidence: step.evidence,
      metrics: step.metrics,
      items: candidates
        .filter((item) => item.stepIndex === stepIndex && kept.has(item))
        .map((item) => ({ label: item.label, detail: item.detail })),
    })),
    askUser: diagnosis.askUser.map((ask) => ({
      screen: ask.screen,
      text: ask.text,
    })),
  };
}
