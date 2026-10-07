import { z } from "zod";

import { readSummary } from "@/lib/module-flows/analytics/report";

import { WEBSITE_GOAL_KEYS } from "./goal-keys";
import {
  REPORT_CAPS,
  REPORT_KPI_KEYS,
  WEBSITE_REPORT_CARD_KIND,
  WEBSITE_REPORT_VARIANTS,
  type AlertBody,
  type MonthlyBody,
  type PeriodReportSections,
  type PlanBody,
  type PlanTargetProposal,
  type PulseAlert,
  type PulseBody,
  type PulseChange,
  type PulseKpi,
  type ReportAgentelseSection,
  type ReportFindingSnap,
  type ReportForecastSnap,
  type ReportGoalSnap,
  type ReportKpi,
  type ReportMeasurement,
  type ReportMover,
  type ReportTable,
  type WebsiteReportBody,
  type WebsiteReportCardData,
  type WeeklyBody,
} from "./types";

// GA-F5 rapor kartı okuyucusu (docs/website-reports.md "Kart"). Kart
// Command.parsedIntent içinde saklanır ve gönderildikten sonra değişmez;
// okuma hiçbir zaman şekle güvenmez: bilinmeyen alanlar atılır, listeler
// REPORT_CAPS ile kısılır, bozuk satırlar düşer, kart geriye kalanla yaşar.
// Çeşit/gövde uyuşmazlığı ya da v !== 1 null döner; okuyucu asla fırlatmaz.
// Saf ve izomorfik.

const MAX_NOTES = 8;
const MAX_TABLE_COLUMNS = 12;
const MAX_REASONS = 3;
const MAX_FORECASTS = 3;

const nullableNumber = z.number().nullable().catch(null);
const nullableString = z.string().nullable().catch(null);
const flag = z.boolean().catch(false);

const formatSchema = z.enum(["count", "percent", "duration", "money"]);
const moneyFormatSchema = z.enum(["count", "money"]);
const goalKeySchema = z.enum(WEBSITE_GOAL_KEYS);
const paceSchema = z.enum([
  "achieved",
  "on_track",
  "at_risk",
  "behind",
  "early",
  "unknown",
]);
const basisSchema = z.enum(["ok", "short_history", "no_baseline", "complete"]);
const metricSchema = z.enum(["sessions", "keyEvents", "revenue"]);

// Geçerli satırları alır, bozukları düşürür, üst sınırı uygular.
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

const kpiSchema: z.ZodType<ReportKpi> = z.object({
  key: z.enum(REPORT_KPI_KEYS),
  label: z.string(),
  format: formatSchema,
  value: nullableNumber,
  previous: nullableNumber,
  changePct: nullableNumber,
  lastYear: nullableNumber,
  lastYearChangePct: nullableNumber,
});

const moverSchema: z.ZodType<ReportMover> = z.object({
  page: z.string(),
  sessions: z.number(),
  previousSessions: z.number(),
  change: z.number(),
  changePct: nullableNumber,
  keyEvents: z.number(),
  previousKeyEvents: z.number(),
});

const findingSchema: z.ZodType<ReportFindingSnap> = z.object({
  id: z.string(),
  ruleKey: z.string(),
  list: z.enum(["changed", "opportunities"]),
  kind: z.string(),
  title: z.string(),
  detail: z.string().catch(""),
  impact: nullableString,
  confidence: z.enum(["Significant", "Directional"]),
  period: z.string().catch(""),
  explanation: nullableString,
  status: z.string(),
  outcome: nullableString,
  preliminary: flag,
  href: z.string().catch(""),
});

const measurementSchema: z.ZodType<ReportMeasurement> = z.object({
  score: nullableNumber,
  label: z.string(),
  tone: z.enum(["ok", "warning", "error", "unknown"]).catch("unknown"),
  issues: z.number().catch(0),
  critical: z.number().catch(0),
  href: z.string().catch(""),
});

const goalSnapSchema: z.ZodType<ReportGoalSnap> = z.object({
  goalId: z.string(),
  title: z.string(),
  metricKey: goalKeySchema,
  format: moneyFormatSchema,
  target: nullableNumber,
  monthToDate: z.number(),
  forecast: nullableNumber,
  low: nullableNumber,
  high: nullableNumber,
  pace: paceSchema,
  paceLabel: z.string().catch(""),
  month: z.string(),
  final: flag,
});

const forecastSnapSchema: z.ZodType<ReportForecastSnap> = z.object({
  metric: metricSchema,
  label: z.string(),
  format: moneyFormatSchema,
  month: z.string(),
  monthToDate: z.number(),
  forecast: nullableNumber,
  low: nullableNumber,
  high: nullableNumber,
  basis: basisSchema,
  note: nullableString,
});

const pulseKpiSchema: z.ZodType<PulseKpi> = z.object({
  key: z.enum(["sessions", "keyEvents", "engagementRate", "revenue"]),
  label: z.string(),
  format: formatSchema,
  value: z.number(),
  usual: nullableNumber,
  changePct: nullableNumber,
  unusual: flag,
});

const pulseChangeSchema: z.ZodType<PulseChange> = z.object({
  channel: z.string(),
  sessions: z.number(),
  usual: z.number(),
  change: z.number(),
});

const pulseAlertSchema: z.ZodType<PulseAlert> = z.object({
  title: z.string(),
  severity: z.enum(["WARN", "CRITICAL"]),
  href: z.string().catch(""),
  isNew: flag,
});

const pulseReasonSchema = z.enum(["alert", "unusual", "anomaly"]);

const proposalSchema: z.ZodType<PlanTargetProposal> = z.object({
  metricKey: goalKeySchema,
  label: z.string(),
  format: moneyFormatSchema,
  baseline: z.number(),
  baselineMonths: z.number(),
  seasonalPct: nullableNumber,
  realistic: z.number(),
  low: z.number(),
  high: z.number(),
  suggested: z.number(),
  currentGoal: z
    .object({ goalId: z.string(), target: nullableNumber })
    .nullable()
    .catch(null),
});

const bestPageSchema = z.object({
  page: z.string(),
  sessions: z.number(),
  keyEvents: z.number(),
  keyEventRate: z.number(),
});

const columnSchema = z.object({ label: z.string(), format: formatSchema });
const tableRowSchema = z.object({
  label: z.string(),
  values: z.array(z.number().nullable()),
});
const tableOtherSchema = z.array(z.number().nullable()).nullable().catch(null);
const rangeSchema = z.object({ from: z.string(), to: z.string() });
const lastYearSchema = rangeSchema.nullable().catch(null);

function emptyTable(): ReportTable {
  return { columns: [], rows: [], other: null, notes: [] };
}

// Tablo: bozuk satırlar düşer; sütun yoksa tablo geçersizdir.
function readTable(value: unknown, rowCap: number): ReportTable | null {
  const record = asRecord(value);
  if (!record) return null;
  const columns = readList(record.columns, columnSchema, MAX_TABLE_COLUMNS);
  if (columns.length === 0) return null;
  return {
    columns,
    rows: readList(record.rows, tableRowSchema, rowCap),
    other: tableOtherSchema.parse(record.other),
    notes: readList(record.notes, z.string(), MAX_NOTES),
  };
}

function readTableOrEmpty(value: unknown, rowCap: number): ReportTable {
  return readTable(value, rowCap) ?? emptyTable();
}

// Dönem raporlarının ortak bölümleri.
function readSections(record: Record<string, unknown>): PeriodReportSections {
  return {
    kpis: readList(record.kpis, kpiSchema, REPORT_KPI_KEYS.length),
    channels: readTableOrEmpty(record.channels, REPORT_CAPS.channels),
    winners: readList(record.winners, moverSchema, REPORT_CAPS.movers),
    losers: readList(record.losers, moverSchema, REPORT_CAPS.movers),
    keyEvents: readTableOrEmpty(record.keyEvents, REPORT_CAPS.keyEvents),
    aiAssistants: readTable(record.aiAssistants, REPORT_CAPS.aiAssistants),
    siteSearch: readTable(record.siteSearch, REPORT_CAPS.siteSearch),
    measurement: measurementSchema.nullable().catch(null).parse(record.measurement),
    insights: z.enum(["on", "pending", "off"]).catch("off").parse(record.insights),
    whatChanged: readList(record.whatChanged, findingSchema, REPORT_CAPS.whatChanged),
    opportunities: readList(
      record.opportunities,
      findingSchema,
      REPORT_CAPS.opportunities,
    ),
    goals: readList(record.goals, goalSnapSchema, REPORT_CAPS.goals),
    nextSteps: readList(record.nextSteps, z.string(), REPORT_CAPS.nextSteps),
    nextStepsSource: z
      .enum(["ai", "findings", "none"])
      .catch("none")
      .parse(record.nextStepsSource),
    notes: readList(record.notes, z.string(), MAX_NOTES),
  };
}

const MAX_AGENTELSE_NOTES = 5;
const MAX_AGENTELSE_NOTE_CHARS = 300;
const agentelseNoteSchema = z.string().max(MAX_AGENTELSE_NOTE_CHARS);

// GA-F6 bölümü isteğe bağlıdır: yok ya da bozuksa null döner ve kart kendi
// başına yaşar (eski kartlar öncekiyle aynı okunur).
function readAgentelse(value: unknown): ReportAgentelseSection | null {
  const record = asRecord(value);
  if (!record) return null;
  const tracked = readTable(record.tracked, REPORT_CAPS.agentelse);
  const ads = readTable(record.ads, REPORT_CAPS.agentelseAds);
  const googleAds = readTable(record.googleAds, REPORT_CAPS.agentelseAds);
  if (!tracked && !ads && !googleAds) return null;
  return {
    tracked,
    ads,
    googleAds,
    notes: readList(record.notes, agentelseNoteSchema, MAX_AGENTELSE_NOTES),
  };
}

const weeklyHeadSchema = z.object({
  from: z.string(),
  to: z.string(),
  previous: rangeSchema,
  lastYear: lastYearSchema,
});

function readWeekly(record: Record<string, unknown>): WeeklyBody | null {
  const head = weeklyHeadSchema.safeParse(record);
  if (!head.success) return null;
  const agentelse = readAgentelse(record.agentelse);
  return {
    variant: "weekly",
    ...readSections(record),
    from: head.data.from,
    to: head.data.to,
    previous: head.data.previous,
    lastYear: head.data.lastYear,
    forecasts: readList(record.forecasts, forecastSnapSchema, MAX_FORECASTS),
    ...(agentelse ? { agentelse } : {}),
  };
}

const monthlyHeadSchema = weeklyHeadSchema.extend({ month: z.string() });
const outcomesSchema = z.object({
  worked: z.number().catch(0),
  didnt: z.number().catch(0),
  inconclusive: z.number().catch(0),
});

function readMonthly(record: Record<string, unknown>): MonthlyBody | null {
  const head = monthlyHeadSchema.safeParse(record);
  if (!head.success) return null;
  const outcomesRecord = asRecord(record.outcomes);
  const counts = outcomesRecord ? outcomesSchema.safeParse(outcomesRecord) : null;
  return {
    variant: "monthly",
    ...readSections(record),
    month: head.data.month,
    from: head.data.from,
    to: head.data.to,
    previous: head.data.previous,
    lastYear: head.data.lastYear,
    topPages: readTableOrEmpty(record.topPages, REPORT_CAPS.topPages),
    paidTraffic: readTable(record.paidTraffic, REPORT_CAPS.paidTrafficRows),
    outcomes:
      outcomesRecord && counts?.success
        ? {
            ...counts.data,
            items: readList(
              outcomesRecord.items,
              findingSchema,
              REPORT_CAPS.outcomes,
            ),
          }
        : null,
  };
}

function readPlan(record: Record<string, unknown>): PlanBody | null {
  const head = z.object({ month: z.string() }).safeParse(record);
  if (!head.success) return null;
  return {
    variant: "plan",
    month: head.data.month,
    proposals: readList(record.proposals, proposalSchema, REPORT_CAPS.proposals),
    proposalNote: nullableString.parse(record.proposalNote),
    topFindings: readList(
      record.topFindings,
      findingSchema,
      REPORT_CAPS.opportunities,
    ),
    bestPages: readList(record.bestPages, bestPageSchema, REPORT_CAPS.bestPages),
    channelQuality: readTable(record.channelQuality, REPORT_CAPS.channels),
    forecasts: readList(record.forecasts, forecastSnapSchema, MAX_FORECASTS),
  };
}

function readPulse(record: Record<string, unknown>): PulseBody | null {
  const head = z.object({ day: z.string() }).safeParse(record);
  if (!head.success) return null;
  return {
    variant: "pulse",
    day: head.data.day,
    kpis: readList(record.kpis, pulseKpiSchema, 4),
    changes: readList(record.changes, pulseChangeSchema, REPORT_CAPS.pulseChanges),
    alerts: readList(record.alerts, pulseAlertSchema, REPORT_CAPS.alerts),
    anomalies: readList(record.anomalies, findingSchema, REPORT_CAPS.anomalies),
    holiday: flag.parse(record.holiday),
    suspect: flag.parse(record.suspect),
    reasons: readList(record.reasons, pulseReasonSchema, MAX_REASONS),
  };
}

const alertHeadSchema = z.object({
  alertId: z.string(),
  kind: z.string(),
  severity: z.literal("CRITICAL"),
  title: z.string(),
  href: z.string().catch(""),
  reconnect: flag,
  openedAt: z.string().catch(""),
});

function readAlert(record: Record<string, unknown>): AlertBody | null {
  const head = alertHeadSchema.safeParse(record);
  if (!head.success) return null;
  return { variant: "alert", ...head.data };
}

function readBody(variant: string, value: unknown): WebsiteReportBody | null {
  const record = asRecord(value);
  if (!record || record.variant !== variant) return null;
  switch (variant) {
    case "pulse":
      return readPulse(record);
    case "weekly":
      return readWeekly(record);
    case "monthly":
      return readMonthly(record);
    case "plan":
      return readPlan(record);
    case "alert":
      return readAlert(record);
    default:
      return null;
  }
}

const shellSchema = z.object({
  kind: z.literal(WEBSITE_REPORT_CARD_KIND),
  v: z.literal(1),
  variant: z.enum(WEBSITE_REPORT_VARIANTS),
  title: z.string(),
  projectId: z.string(),
  linkId: z.string(),
  propertyName: nullableString,
  periodLabel: z.string().catch(""),
  timeZone: z.string(),
  currency: nullableString,
  builtAt: z.string(),
  dataThrough: nullableString,
  preliminary: flag,
  isMock: flag,
  narrativeNote: nullableString,
});

// Değer bir rapor kartı mı (yalnız `kind` bakılır; ayrıntılı doğrulama
// readWebsiteReportCard'ın işidir).
export function isWebsiteReportCard(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && record.kind === WEBSITE_REPORT_CARD_KIND;
}

// Saklanan karttan güvenli okuma; okunamayan kart null (arayüz "This report
// can't be shown." satırına düşer).
export function readWebsiteReportCard(
  value: unknown,
): WebsiteReportCardData | null {
  try {
    const record = asRecord(value);
    if (!record) return null;
    const shell = shellSchema.safeParse(record);
    if (!shell.success) return null;
    const body = readBody(shell.data.variant, record.body);
    if (!body) return null;
    return {
      ...shell.data,
      body,
      narrative: readSummary(record.narrative),
    };
  } catch {
    return null;
  }
}
