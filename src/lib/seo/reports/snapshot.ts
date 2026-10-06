import { z } from "zod";

import { dayLabel } from "./text";
import {
  SEO_GOAL_METRIC_KEYS,
  SEO_REPORT_KINDS,
  type DiagnoseStep,
  type SearchDiagnosis,
  type SeoReportGoal,
  type SeoReportKind,
  type SeoReportRow,
  type SeoReportSection,
  type SeoReportSnapshot,
  type SeoRoadmapItem,
} from "./types";

// Rapor anlık görüntüsünün notları ve güvenli okuyucusu (docs/search-reports.md
// "Anlık görüntü"). Anlık görüntü SeoReport.snapshot içinde Json olarak durur;
// okuma şekle asla güvenmez: bölümler tek tek doğrulanır, bozuk bölüm ve satır
// düşer, listeler tip sözleşmesindeki sınırlara kısılır, başlık bozuksa null
// döner. Sonradan eklenen alanlar (findingId, metrics, evaluated) eski
// kayıtlarda varsayılana düşer. Okuyucu asla fırlatmaz. Saf ve izomorfik.

const MAX_NOTES = 8;
const MAX_SECTIONS = 16;
const MAX_TABLE_ROWS = 5;
const MAX_HEALTH_ISSUES = 5;
const MAX_OPPORTUNITIES = 10;
const MAX_ACTION_ITEMS = 5;
const MAX_UPDATES = 5;
const MAX_CONTENT = 10;
const MAX_ROADMAP = 10;
const MAX_GOALS = 10;
const MAX_KPIS = 6;
const MAX_STEPS = 8;
const MAX_EVIDENCE = 4;
const MAX_STEP_ITEMS = 5;
const MAX_ALSO = 8;
const MAX_ASK = 2;

// Düşük veri eşikleri (haftalık / aylık gösterim sayısı).
const LOW_WEEKLY_IMPRESSIONS = 250;
const LOW_MONTHLY_IMPRESSIONS = 1000;

export function isLowData(kind: SeoReportKind, impressions: number): boolean {
  if (kind === "WEEKLY") return impressions < LOW_WEEKLY_IMPRESSIONS;
  if (kind === "MONTHLY") return impressions < LOW_MONTHLY_IMPRESSIONS;
  return false;
}

// Rapor altındaki sabit notlar, sözleşme sırasıyla.
export function reportNotes(input: {
  finalThrough: string;
  anonymousShare: number | null;
  brandSplit: boolean;
  truncated: boolean;
  lowData: boolean;
  isMock: boolean;
}): string[] {
  const notes = [
    `Search Console days (Pacific Time). Final data through ${dayLabel(input.finalThrough)}.`,
  ];
  if (input.anonymousShare !== null && input.anonymousShare >= 0.01) {
    notes.push(
      `${Math.round(input.anonymousShare * 100)}% of clicks come from searches Google doesn't show.`,
    );
  }
  if (!input.brandSplit) {
    notes.push(
      "Brand and non-brand split isn't ready yet, so totals are shown.",
    );
  }
  if (input.truncated) {
    notes.push("Google returned only the top rows for part of this period.");
  }
  if (input.lowData) {
    notes.push(
      "Low search data: indexing, technical health and new content matter most right now.",
    );
  }
  if (input.isMock) notes.push("Sample data.");
  notes.push("Position is Google's average top position, not a rank.");
  return notes;
}

// ---- Okuma şemaları -------------------------------------------------------

const nullableNumber = z.number().nullable().catch(null);
const nullableString = z.string().nullable().catch(null);
const flag = z.boolean().catch(false);

// Geçerli öğeleri alır, bozukları düşürür, üst sınırı uygular.
function readList<T>(value: unknown, schema: z.ZodType<T>, cap: number): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (out.length >= cap) break;
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const severitySchema = z.enum(["INFO", "WARN", "CRITICAL"]);
const rangeSchema = z.object({ from: z.string(), to: z.string() });
const labeledRangeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
});
const cwvRatingSchema = z.enum(["good", "needs-improvement", "poor"]);
const metricSchema = z.enum(["nonBrandClicks", "clicks"]);

const kpiSchema = z.object({
  key: z.enum([
    "nonBrandClicks",
    "brandClicks",
    "clicks",
    "impressions",
    "ctr",
    "position",
  ]),
  label: z.string(),
  value: nullableNumber,
  previous: nullableNumber,
  yearAgo: nullableNumber,
  format: z.enum(["count", "percent", "position"]),
  lowerIsBetter: flag,
});

const rowSchema: z.ZodType<SeoReportRow> = z.object({
  label: z.string(),
  url: nullableString,
  isBrand: flag,
  clicks: z.number(),
  previousClicks: z.number(),
  impressions: z.number(),
  previousImpressions: z.number(),
  position: nullableNumber,
  previousPosition: nullableNumber,
});

const tableSchema = z.object({
  key: z.enum([
    "winning_queries",
    "losing_queries",
    "winning_pages",
    "losing_pages",
    "rising_queries",
  ]),
  title: z.string(),
  aggregation: z.enum(["By property", "By page"]).catch("By property"),
  rows: z.array(z.unknown()),
});

const pulseSchema = z.object({
  day: z.string(),
  metric: metricSchema,
  value: z.number(),
  usual: nullableNumber,
  changePct: nullableNumber,
  newCritical: z.number().catch(0),
  openCritical: z.number().catch(0),
  biggest: z
    .object({
      dimension: z.enum(["country", "device"]),
      key: z.string(),
      value: z.number(),
      usual: z.number(),
    })
    .nullable()
    .catch(null),
});

const healthSchema = z.object({
  score: nullableNumber,
  cappedByCritical: flag,
  critical: z.number().catch(0),
  warn: z.number().catch(0),
  issues: z.array(z.unknown()).catch([]),
  coverage: z
    .object({
      point: z.number(),
      low: z.number(),
      high: z.number(),
      weekStart: z.string(),
    })
    .nullable()
    .catch(null),
  cwv: z
    .object({
      phone: cwvRatingSchema.nullable().catch(null),
      desktop: cwvRatingSchema.nullable().catch(null),
    })
    .nullable()
    .catch(null),
});
const healthIssueSchema = z.object({
  title: z.string(),
  severity: severitySchema,
});

const opportunitySchema = z.object({
  id: z.string(),
  title: z.string(),
  action: z.string().catch(""),
  impactPerMonth: nullableNumber,
  reachPerMonth: nullableNumber,
  confidence: z.enum(["Solid", "Directional"]).catch("Directional"),
  effort: z.string().catch(""),
  status: z.string().catch(""),
  priority: z.number().catch(0),
});

const actionsSchema = z.object({
  accepted: z.number().catch(0),
  done: z.number().catch(0),
  // Sonradan eklendi: eski kayıtlarda yok.
  evaluated: z.number().catch(0),
  items: z.array(z.unknown()).catch([]),
});
const actionItemSchema = z.object({
  title: z.string(),
  status: z.string().catch(""),
  outcome: nullableString,
});

const updateSchema = z.object({
  name: z.string(),
  kind: z.string().catch(""),
  startedAt: z.string(),
  endedAt: nullableString,
  url: nullableString,
});

const goalSchema: z.ZodType<SeoReportGoal> = z.object({
  goalId: z.string(),
  title: z.string(),
  metricKey: z.enum(SEO_GOAL_METRIC_KEYS),
  target: nullableNumber,
  current: nullableNumber,
  pace: z
    .enum(["achieved", "on_track", "behind", "at_risk", "unknown"])
    .catch("unknown"),
  paceLabel: z.string().catch(""),
  measuredThrough: nullableString,
  projected: nullableNumber,
  projectedLow: nullableNumber,
  projectedHigh: nullableNumber,
});

const forecastSchema = z.object({
  metric: metricSchema,
  month: z.string(),
  value: z.number(),
  low: z.number(),
  high: z.number(),
  method: z.enum(["seasonal", "trend"]),
  historyMonths: z.number().catch(0),
  errorPct: z.number().catch(0),
  newContent: z
    .object({
      clicks: z.number(),
      pages: z.number(),
      share: nullableNumber,
    })
    .nullable()
    .catch(null),
});

const contentItemSchema = z.object({
  title: z.string(),
  date: z.string(),
  status: z.string().catch(""),
});

const roadmapItemSchema: z.ZodType<SeoRoadmapItem> = z.object({
  title: z.string(),
  action: z.string().catch(""),
  source: z.enum(["health", "opportunity", "quick_win", "audit"]),
  // Sonradan eklendi: eski kayıtlarda yok.
  findingId: nullableString,
  impactPerMonth: nullableNumber,
  effort: nullableString,
  severity: severitySchema.nullable().catch(null),
  count: nullableNumber,
});

const stepKeySchema = z.enum([
  "data",
  "indexing",
  "technical",
  "update",
  "demand",
  "ranking",
  "ctr",
  "cannibalization",
]);
const stepSchema = z.object({
  key: stepKeySchema,
  question: z.string(),
  verdict: z.enum(["yes", "no", "unknown"]),
  evidence: z.array(z.unknown()).catch([]),
  // Sonradan eklendi: eski kayıtlarda yok.
  metrics: z.record(z.string(), z.number()).catch({}),
  items: z.array(z.unknown()).catch([]),
});
const stepItemSchema = z.object({
  label: z.string(),
  detail: z.string().catch(""),
});
const askSchema = z.object({
  screen: z.enum(["Manual actions", "Security issues"]),
  text: z.string(),
});
const diagnosisSchema = z.object({
  v: z.literal(1),
  metric: metricSchema,
  window: z.object({ current: rangeSchema, previous: rangeSchema }),
  current: z.number(),
  previous: z.number(),
  changePct: nullableNumber,
  dropped: flag,
  primary: stepKeySchema.nullable().catch(null),
  also: z.array(z.unknown()).catch([]),
  steps: z.array(z.unknown()).catch([]),
  askUser: z.array(z.unknown()).catch([]),
  summary: z.string().catch(""),
});

function readDiagnosis(value: unknown): SearchDiagnosis | null {
  const parsed = diagnosisSchema.safeParse(value);
  if (!parsed.success) return null;
  const head = parsed.data;
  const steps: DiagnoseStep[] = [];
  for (const raw of head.steps) {
    if (steps.length >= MAX_STEPS) break;
    const step = stepSchema.safeParse(raw);
    if (!step.success) continue;
    steps.push({
      ...step.data,
      evidence: readList(step.data.evidence, z.string(), MAX_EVIDENCE),
      items: readList(step.data.items, stepItemSchema, MAX_STEP_ITEMS),
    });
  }
  if (steps.length === 0) return null;
  return {
    ...head,
    also: readList(head.also, stepKeySchema, MAX_ALSO),
    steps,
    askUser: readList(head.askUser, askSchema, MAX_ASK),
  };
}

// Bir bölüm; bozuksa null (bölüm düşer, rapor geri kalanla yaşar).
function readSection(value: unknown): SeoReportSection | null {
  const record = asRecord(value);
  if (!record) return null;
  switch (record.type) {
    case "kpis": {
      const kpis = readList(record.kpis, kpiSchema, MAX_KPIS);
      if (kpis.length === 0) return null;
      const labels = z
        .object({ compareLabel: z.string() })
        .safeParse(record);
      if (!labels.success) return null;
      return {
        type: "kpis",
        kpis,
        compareLabel: labels.data.compareLabel,
        yearAgoLabel: nullableString.parse(record.yearAgoLabel),
      };
    }
    case "table": {
      const table = tableSchema.safeParse(record.table);
      if (!table.success) return null;
      return {
        type: "table",
        table: {
          ...table.data,
          rows: readList(table.data.rows, rowSchema, MAX_TABLE_ROWS),
        },
      };
    }
    case "pulse": {
      const pulse = pulseSchema.safeParse(record.pulse);
      return pulse.success ? { type: "pulse", pulse: pulse.data } : null;
    }
    case "health": {
      const health = healthSchema.safeParse(record.health);
      if (!health.success) return null;
      return {
        type: "health",
        health: {
          ...health.data,
          issues: readList(
            health.data.issues,
            healthIssueSchema,
            MAX_HEALTH_ISSUES,
          ),
        },
      };
    }
    case "opportunities":
      return {
        type: "opportunities",
        items: readList(record.items, opportunitySchema, MAX_OPPORTUNITIES),
      };
    case "actions": {
      const actions = actionsSchema.safeParse(record.actions);
      if (!actions.success) return null;
      return {
        type: "actions",
        actions: {
          ...actions.data,
          items: readList(actions.data.items, actionItemSchema, MAX_ACTION_ITEMS),
        },
      };
    }
    case "updates":
      return {
        type: "updates",
        items: readList(record.items, updateSchema, MAX_UPDATES),
      };
    case "diagnosis": {
      const diagnosis = readDiagnosis(record.diagnosis);
      return diagnosis ? { type: "diagnosis", diagnosis } : null;
    }
    case "goals":
      return {
        type: "goals",
        goals: readList(record.goals, goalSchema, MAX_GOALS),
      };
    case "forecast": {
      const forecast = forecastSchema.safeParse(record.forecast);
      return forecast.success
        ? { type: "forecast", forecast: forecast.data }
        : null;
    }
    case "content": {
      const title = z.string().safeParse(record.title);
      if (!title.success) return null;
      return {
        type: "content",
        title: title.data,
        items: readList(record.items, contentItemSchema, MAX_CONTENT),
      };
    }
    case "roadmap":
      return {
        type: "roadmap",
        actions: readList(record.actions, roadmapItemSchema, MAX_ROADMAP),
        techDebt: readList(record.techDebt, roadmapItemSchema, MAX_ROADMAP),
      };
    default:
      return null;
  }
}

const headerSchema = z.object({
  v: z.literal(1),
  kind: z.enum(SEO_REPORT_KINDS),
  title: z.string(),
  periodKey: z.string(),
  period: labeledRangeSchema,
  compare: labeledRangeSchema.nullable().catch(null),
  yearAgo: labeledRangeSchema.nullable().catch(null),
  site: z.object({ label: z.string(), isMock: flag }),
  finalThrough: z.string(),
  brandSplit: flag,
  anonymousShare: nullableNumber,
});

// Saklanan anlık görüntüden güvenli okuma. v !== 1, geçersiz çeşit ya da
// bozuk başlık null döner; bölümler tek tek doğrulanır.
export function readSeoReportSnapshot(raw: unknown): SeoReportSnapshot | null {
  try {
    const record = asRecord(raw);
    if (!record) return null;
    const header = headerSchema.safeParse(record);
    if (!header.success) return null;
    const sections: SeoReportSection[] = [];
    if (Array.isArray(record.sections)) {
      for (const item of record.sections) {
        if (sections.length >= MAX_SECTIONS) break;
        const section = readSection(item);
        if (section) sections.push(section);
      }
    }
    return {
      ...header.data,
      sections,
      notes: readList(record.notes, z.string(), MAX_NOTES),
    };
  } catch {
    return null;
  }
}
