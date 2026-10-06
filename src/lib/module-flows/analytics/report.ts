import { z } from "zod";

import {
  ANALYTICS_SOURCES,
  FAIL_REASONS,
  SOURCE_LABEL,
  isAnalyticsPeriod,
  type AnalyticsPeriod,
  type AnalyticsSource,
  type FailReason,
} from "./catalog";
import { ANALYTICS_COPY as COPY, FAIL_REASON_TEXT } from "./copy";
import { formatMetric, isCurrencyCode, type MetricFormat } from "./format";

// A built report (docs/modules.md "Analytics"): one section per source with
// the numbers the source really returned, or why it returned none, and the AI
// summary written from those numbers only. It is stored in the card's data, so
// reading it back never trusts the shape: every field is checked, an unknown
// metric or a malformed row is dropped, and the report survives what is left.
// Pure and isomorphic.

type MetricDef = {
  source: AnalyticsSource;
  label: string;
  format: MetricFormat;
  // A count as it stands today (followers), not a total over the period.
  snapshot?: boolean;
};

export const METRIC_DEFS = {
  "ig.reach": { source: "instagram", label: "Reach", format: "count" },
  "ig.views": { source: "instagram", label: "Views", format: "count" },
  "ig.accountsEngaged": {
    source: "instagram",
    label: "Accounts engaged",
    format: "count",
  },
  "ig.interactions": {
    source: "instagram",
    label: "Interactions",
    format: "count",
  },
  "ig.followers": {
    source: "instagram",
    label: "Followers",
    format: "count",
    snapshot: true,
  },
  "ads.spend": { source: "metaAds", label: "Spend", format: "money" },
  "ads.impressions": {
    source: "metaAds",
    label: "Impressions",
    format: "count",
  },
  "ads.reach": { source: "metaAds", label: "Reach", format: "count" },
  "ads.clicks": { source: "metaAds", label: "Clicks", format: "count" },
  "ads.ctr": { source: "metaAds", label: "CTR", format: "percent" },
  "ads.cpc": { source: "metaAds", label: "CPC", format: "money" },
  "ga.activeUsers": { source: "ga4", label: "Active users", format: "count" },
  "ga.newUsers": { source: "ga4", label: "New users", format: "count" },
  "ga.sessions": { source: "ga4", label: "Sessions", format: "count" },
  "ga.views": { source: "ga4", label: "Views", format: "count" },
  "ga.engagementRate": {
    source: "ga4",
    label: "Engagement rate",
    format: "percent",
  },
  "ga.avgSessionDuration": {
    source: "ga4",
    label: "Avg. session",
    format: "duration",
  },
  "sc.clicks": { source: "searchConsole", label: "Clicks", format: "count" },
  "sc.impressions": {
    source: "searchConsole",
    label: "Impressions",
    format: "count",
  },
  "sc.ctr": { source: "searchConsole", label: "CTR", format: "percent" },
  "sc.position": {
    source: "searchConsole",
    label: "Avg. position",
    format: "position",
  },
  "sc.nonBrandClicks": {
    source: "searchConsole",
    label: "Non-brand clicks",
    format: "count",
  },
  "sc.brandClicks": {
    source: "searchConsole",
    label: "Brand clicks",
    format: "count",
  },
} as const satisfies Record<string, MetricDef>;

export type MetricKey = keyof typeof METRIC_DEFS;

export function isMetricKey(value: unknown): value is MetricKey {
  return typeof value === "string" && Object.hasOwn(METRIC_DEFS, value);
}

export function metricDef(key: MetricKey): MetricDef {
  return METRIC_DEFS[key];
}

export type ReportMetric = { key: MetricKey; value: number };
// Meta Ads: the results its campaigns were run for, summed per kind.
export type ReportResult = {
  label: string;
  count: number;
  costPerResult: number | null;
};
export type ReportCampaign = {
  name: string;
  spend: number;
  resultLabel: string | null;
  results: number | null;
  costPerResult: number | null;
};
// Search Console: ctr in percent units, like every other rate here.
export type ReportQuery = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};
// Google Analytics (warehouse only): rates and shares in percent units, null
// where there is nothing to divide by.
export type ReportChannel = {
  channel: string;
  sessions: number;
  share: number | null;
  engagementRate: number | null;
  keyEvents: number;
};
export type ReportLandingPage = {
  page: string;
  sessions: number;
  engagementRate: number | null;
  keyEvents: number;
};
export type ReportKeyEvent = { name: string; count: number };

export type OkSection = {
  source: AnalyticsSource;
  ok: true;
  // The connected account as the person knows it ("@biduniq", a site).
  account: string | null;
  // The days the numbers cover: the period, or less where the source caps it.
  days: number;
  currency: string | null;
  metrics: ReportMetric[];
  results: ReportResult[];
  campaigns: ReportCampaign[];
  queries: ReportQuery[];
  // Optional lists: present only when non-empty, so a report without them
  // (stored before, or built with the lists off) keeps exactly its old shape.
  // Read them as `section.channels ?? []`.
  channels?: ReportChannel[];
  landingPages?: ReportLandingPage[];
  keyEvents?: ReportKeyEvent[];
};
export type FailedSection = {
  source: AnalyticsSource;
  ok: false;
  reason: FailReason;
};
export type ReportSection = OkSection | FailedSection;

export type ReportSummary = {
  headline: string;
  highlights: string[];
  watchouts: string[];
  nextSteps: string[];
};

export type ReportData = {
  period: AnalyticsPeriod;
  builtAt: string;
  sections: ReportSection[];
  summary: ReportSummary | null;
  // Why there is no summary (a limit, a failure); null with a summary.
  summaryNote: string | null;
};

export const SUMMARY_LIMITS = {
  headline: 220,
  item: 280,
  highlights: 3,
  watchouts: 2,
  nextSteps: 3,
} as const;
export const MAX_RESULTS = 3;
export const MAX_CAMPAIGNS = 3;
export const MAX_QUERIES = 5;
export const MAX_CHANNELS = 6;
export const MAX_LANDING_PAGES = 5;
export const MAX_KEY_EVENTS = 5;
const MAX_METRICS = 8;
const LABEL_MAX = 80;
const NAME_MAX = 120;
const QUERY_MAX = 200;
const PAGE_MAX = 200;
const ACCOUNT_MAX = 120;
const NOTE_MAX = 600;

export function failedSection(
  source: AnalyticsSource,
  reason: FailReason,
): FailedSection {
  return { source, ok: false, reason };
}

export function okSection(
  source: AnalyticsSource,
  fields: Partial<Omit<OkSection, "source" | "ok">> & { days: number },
): OkSection {
  return {
    source,
    ok: true,
    account: fields.account ?? null,
    days: fields.days,
    currency: fields.currency ?? null,
    metrics: fields.metrics ?? [],
    results: fields.results ?? [],
    campaigns: fields.campaigns ?? [],
    queries: fields.queries ?? [],
    ...(fields.channels?.length ? { channels: fields.channels } : {}),
    ...(fields.landingPages?.length
      ? { landingPages: fields.landingPages }
      : {}),
    ...(fields.keyEvents?.length ? { keyEvents: fields.keyEvents } : {}),
  };
}

export function okSections(report: ReportData | null): OkSection[] {
  return (report?.sections ?? []).filter(
    (section): section is OkSection => section.ok,
  );
}

// A report worth sharing: at least one source gave numbers.
export function reportHasNumbers(report: ReportData | null): boolean {
  return okSections(report).some((section) => section.metrics.length > 0);
}

// ---- Reading what was stored ------------------------------------------------

const count = z.number().min(0);

const resultSchema = z.object({
  label: z.string().trim().min(1).max(LABEL_MAX),
  count,
  costPerResult: count.nullable(),
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  spend: count,
  resultLabel: z.string().trim().min(1).max(LABEL_MAX).nullable(),
  results: count.nullable(),
  costPerResult: count.nullable(),
});

const querySchema = z.object({
  query: z.string().trim().min(1).max(QUERY_MAX),
  clicks: count,
  impressions: count,
  ctr: count,
  position: count,
});

const channelSchema = z.object({
  channel: z.string().trim().min(1).max(LABEL_MAX),
  sessions: count,
  share: count.nullable(),
  engagementRate: count.nullable(),
  keyEvents: count,
});

const landingPageSchema = z.object({
  page: z.string().trim().min(1).max(PAGE_MAX),
  sessions: count,
  engagementRate: count.nullable(),
  keyEvents: count,
});

const keyEventSchema = z.object({
  name: z.string().trim().min(1).max(LABEL_MAX),
  count,
});

const metricSchema = z.object({ key: z.string(), value: z.number() });

const okHeadSchema = z.object({
  source: z.enum(ANALYTICS_SOURCES),
  ok: z.literal(true),
  days: z.number().int().min(1).max(366),
});

const failedSchema = z.object({
  source: z.enum(ANALYTICS_SOURCES),
  ok: z.literal(false),
  reason: z.enum(FAIL_REASONS),
});

// The valid items of a stored list, at most `max`: a malformed row is dropped,
// never the whole list.
function listOf<T>(raw: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    if (out.length >= max) break;
  }
  return out;
}

function textOrNull(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function readMetrics(raw: unknown, source: AnalyticsSource): ReportMetric[] {
  const seen = new Set<MetricKey>();
  const out: ReportMetric[] = [];
  for (const metric of listOf(raw, metricSchema, MAX_METRICS * 2)) {
    // Only this source's own metrics, each once.
    if (!isMetricKey(metric.key) || seen.has(metric.key)) continue;
    if (METRIC_DEFS[metric.key].source !== source) continue;
    seen.add(metric.key);
    out.push({ key: metric.key, value: metric.value });
  }
  return out.slice(0, MAX_METRICS);
}

export function readSection(raw: unknown): ReportSection | null {
  const failed = failedSchema.safeParse(raw);
  if (failed.success) return failed.data;
  const head = okHeadSchema.safeParse(raw);
  if (!head.success) return null;
  const record = raw as Record<string, unknown>;
  const currency = isCurrencyCode(record.currency) ? record.currency : null;
  const channels = listOf(record.channels, channelSchema, MAX_CHANNELS);
  const landingPages = listOf(
    record.landingPages,
    landingPageSchema,
    MAX_LANDING_PAGES,
  );
  const keyEvents = listOf(record.keyEvents, keyEventSchema, MAX_KEY_EVENTS);
  return {
    source: head.data.source,
    ok: true,
    account: textOrNull(record.account, ACCOUNT_MAX),
    days: head.data.days,
    currency,
    metrics: readMetrics(record.metrics, head.data.source),
    results: listOf(record.results, resultSchema, MAX_RESULTS),
    campaigns: listOf(record.campaigns, campaignSchema, MAX_CAMPAIGNS),
    queries: listOf(record.queries, querySchema, MAX_QUERIES),
    ...(channels.length > 0 ? { channels } : {}),
    ...(landingPages.length > 0 ? { landingPages } : {}),
    ...(keyEvents.length > 0 ? { keyEvents } : {}),
  };
}

function textList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const text = textOrNull(item, SUMMARY_LIMITS.item);
    if (text) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export function readSummary(raw: unknown): ReportSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const summary: ReportSummary = {
    headline: textOrNull(record.headline, SUMMARY_LIMITS.headline) ?? "",
    highlights: textList(record.highlights, SUMMARY_LIMITS.highlights),
    watchouts: textList(record.watchouts, SUMMARY_LIMITS.watchouts),
    nextSteps: textList(record.nextSteps, SUMMARY_LIMITS.nextSteps),
  };
  return summaryIsEmpty(summary) ? null : summary;
}

export function summaryIsEmpty(summary: ReportSummary): boolean {
  return (
    !summary.headline &&
    summary.highlights.length === 0 &&
    summary.watchouts.length === 0 &&
    summary.nextSteps.length === 0
  );
}

export function readReport(raw: unknown): ReportData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isAnalyticsPeriod(record.period)) return null;
  if (
    typeof record.builtAt !== "string" ||
    !Number.isFinite(Date.parse(record.builtAt))
  ) {
    return null;
  }
  const sections: ReportSection[] = [];
  const seen = new Set<AnalyticsSource>();
  for (const item of Array.isArray(record.sections) ? record.sections : []) {
    const section = readSection(item);
    if (!section || seen.has(section.source)) continue;
    seen.add(section.source);
    sections.push(section);
  }
  sections.sort(
    (a, b) =>
      ANALYTICS_SOURCES.indexOf(a.source) - ANALYTICS_SOURCES.indexOf(b.source),
  );
  return {
    period: record.period,
    builtAt: record.builtAt,
    sections,
    summary: readSummary(record.summary),
    summaryNote: textOrNull(record.summaryNote, NOTE_MAX),
  };
}

// ---- How a section reads ----------------------------------------------------

export function periodText(days: number): string {
  return COPY.periodOption(days);
}

export function metricLabel(key: MetricKey): string {
  return METRIC_DEFS[key].label;
}

export function isSnapshotMetric(key: MetricKey): boolean {
  const def: MetricDef = METRIC_DEFS[key];
  return def.snapshot === true;
}

export function metricText(
  metric: ReportMetric,
  currency: string | null,
  options: { compact?: boolean } = {},
): string {
  return formatMetric(
    METRIC_DEFS[metric.key].format,
    metric.value,
    currency,
    options,
  );
}

// What a section's numbers come with: a window the source caps, a lag.
export function sectionNote(
  section: OkSection,
  reportPeriod: AnalyticsPeriod,
): string | null {
  if (section.source === "instagram" && section.days < reportPeriod) {
    return COPY.instagramWindow(section.days);
  }
  if (section.source === "searchConsole") return COPY.searchConsoleLag;
  return null;
}

export function sectionTitle(section: ReportSection): string {
  return SOURCE_LABEL[section.source];
}

export function failReasonText(reason: FailReason): string {
  return FAIL_REASON_TEXT[reason];
}
