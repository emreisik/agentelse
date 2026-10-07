import type {
  DidMetric,
  EvaluationReason,
  MetricWindow,
  SeoActionConfidence,
  SeoOutcome,
  VerificationCheck,
} from "@/lib/seo/actions/types";

// Bölünmüş SEO testinin tipleri ve saklanan JSON'un hoşgörülü okuyucuları
// (docs/google-search-console-plan.md SC-F9, docs/search-agency.md). Saf ve
// izomorfik. Saklanan JSON'a güvenilmez: yanlış biçimli alanlar tek tek
// atılır, metinler ve listeler sınırlanır, hiçbir okuyucu fırlatmaz.

export const SPLIT_CHANGE_KINDS = [
  "TITLE_META",
  "SCHEMA",
  "INTERNAL_LINKS_BLOCK",
  "CONTENT_BLOCK",
  "TEMPLATE_CHANGE",
  "OTHER",
] as const;
export type SplitChangeKind = (typeof SPLIT_CHANGE_KINDS)[number];

export function isSplitChangeKind(value: unknown): value is SplitChangeKind {
  return SPLIT_CHANGE_KINDS.some((kind) => kind === value);
}

export const SPLIT_STATUSES = [
  "DRAFT",
  "APPLIED",
  "EVALUATING",
  "WORKED",
  "DIDNT",
  "INCONCLUSIVE",
  "CANCELLED",
  "EXPIRED",
] as const;
export type SplitStatus = (typeof SPLIT_STATUSES)[number];

export function isSplitStatus(value: unknown): value is SplitStatus {
  return SPLIT_STATUSES.some((status) => status === value);
}

export const OPEN_SPLIT_STATUSES: readonly SplitStatus[] = [
  "DRAFT",
  "APPLIED",
  "EVALUATING",
];

// Kullanıcının kendi içeriği (desen, şema türü, not); Google verisi değil.
export type SplitChange = {
  titlePattern: string | null;
  metaPattern: string | null;
  schemaType: string | null;
  note: string | null;
};

// Plasebo (A/A) denetimi: aynı iki kol, yalnız önceki haftalar. padding,
// ana aralığın iki ucuna eklenen mutlak etkidir.
export type SplitPlacebo = {
  effect: number | null;
  low: number | null;
  high: number | null;
  passed: boolean;
  padding: number;
};

// low/high plasebo payını zaten içerir; effect/low/high kesirdir (yüzde değil).
export type SplitEvaluation = {
  v: 1;
  method: "DID";
  metric: DidMetric;
  anchorDay: string;
  preWeeks: string[];
  postWeeks: string[];
  testPages: number;
  controlPages: number;
  usedTest: number;
  usedControl: number;
  excluded: number;
  effect: number | null;
  low: number | null;
  high: number | null;
  placebo: SplitPlacebo | null;
  treated: { before: MetricWindow; after: MetricWindow } | null;
  control: { before: MetricWindow; after: MetricWindow } | null;
  updates: {
    name: string;
    kind: string;
    startedAt: string;
    endedAt: string | null;
  }[];
  truncated: boolean;
  reason: EvaluationReason | "PRE_TREND" | null;
  outcome: SeoOutcome;
  confidence: SeoActionConfidence;
  evaluatedAt: string;
};

export type SplitVerification = {
  v: 1;
  attempts: number;
  lastCheckedAt: string | null;
  checks: VerificationCheck[];
  method: "CRAWLER" | "USER" | "CMS" | null;
  reason:
    | "NOT_SEEN"
    | "FETCH_FAILED"
    | "NO_SITE"
    | "CMS_CHANGE_FAILED"
    | "CONTROL_CHANGED"
    | null;
};

// İstemciye giden görünüm: BigInt, Date nesnesi ve ham Json yok.
export type SplitTestView = {
  id: string;
  projectId: string;
  linkId: string;
  isMock: boolean;
  isSecondarySite: boolean;
  name: string;
  changeKind: SplitChangeKind;
  description: string | null;
  status: SplitStatus;
  pageGroups: string[];
  capped: boolean;
  arms: { test: number; control: number };
  perGroup: { group: string; test: number; control: number }[];
  balance: {
    testClicks: number;
    controlClicks: number;
    ratio: number;
    recommended: boolean;
  };
  change: SplitChange;
  appliedVia: "MANUAL" | "CMS" | null;
  appliedAt: string | null;
  cms: {
    total: number;
    verified: number;
    failed: number;
    waiting: number;
  } | null;
  verification: SplitVerification | null;
  measureFrom: string | null;
  evaluateAfter: string | null;
  windowDays: number;
  evaluation: SplitEvaluation | null;
  outcome: SeoOutcome | null;
  confidence: SeoActionConfidence | null;
  evaluatedAt: string | null;
  createdAt: string;
  canApplyViaCms: boolean;
  crawlerVerifiable: boolean;
};

// Sınırlar.
export const SPLIT_LIMITS = {
  name: 80,
  description: 300,
  pattern: 320,
  schemaType: 40,
  note: 400,
  checks: 20,
  observed: 200,
  updates: 10,
  weeks: 64,
  groups: 5,
} as const;

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number {
  const n = finiteNumber(value);
  return n === null ? 0 : Math.max(0, Math.round(n));
}

function oneOf<T extends string>(value: unknown, list: readonly T[]): T | null {
  return list.find((item) => item === value) ?? null;
}

function dayKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = str(item, 10);
    if (text) out.push(text);
    if (out.length >= SPLIT_LIMITS.weeks) break;
  }
  return out;
}

export function parseSplitChange(raw: unknown): SplitChange {
  const item = record(raw);
  return {
    titlePattern: str(item?.titlePattern, SPLIT_LIMITS.pattern),
    metaPattern: str(item?.metaPattern, SPLIT_LIMITS.pattern),
    schemaType: str(item?.schemaType, SPLIT_LIMITS.schemaType),
    note: str(item?.note, SPLIT_LIMITS.note),
  };
}

function parseChecks(value: unknown): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const item = record(raw);
    const key = str(item?.key, 60);
    const label = str(item?.label, 120);
    if (!item || !key || !label || typeof item.ok !== "boolean") continue;
    checks.push({
      key,
      label,
      ok: item.ok,
      observed: str(item.observed, SPLIT_LIMITS.observed),
    });
    if (checks.length >= SPLIT_LIMITS.checks) break;
  }
  return checks;
}

const VERIFICATION_METHODS = ["CRAWLER", "USER", "CMS"] as const;
const VERIFICATION_REASONS = [
  "NOT_SEEN",
  "FETCH_FAILED",
  "NO_SITE",
  "CMS_CHANGE_FAILED",
  "CONTROL_CHANGED",
] as const;

export function parseSplitVerification(raw: unknown): SplitVerification {
  const item = record(raw);
  return {
    v: 1,
    attempts: count(item?.attempts),
    lastCheckedAt: str(item?.lastCheckedAt, 40),
    checks: parseChecks(item?.checks),
    method: oneOf(item?.method, VERIFICATION_METHODS),
    reason: oneOf(item?.reason, VERIFICATION_REASONS),
  };
}

function parseMetricWindow(value: unknown): MetricWindow | null {
  const item = record(value);
  if (!item) return null;
  return {
    weeks: count(item.weeks),
    clicks: finiteNumber(item.clicks) ?? 0,
    impressions: finiteNumber(item.impressions) ?? 0,
    ctr: finiteNumber(item.ctr),
    position: finiteNumber(item.position),
    ctrAdj: finiteNumber(item.ctrAdj),
  };
}

function parseWindowPair(
  value: unknown,
): { before: MetricWindow; after: MetricWindow } | null {
  const item = record(value);
  const before = parseMetricWindow(item?.before);
  const after = parseMetricWindow(item?.after);
  return before && after ? { before, after } : null;
}

function parsePlacebo(value: unknown): SplitPlacebo | null {
  const item = record(value);
  if (!item || typeof item.passed !== "boolean") return null;
  return {
    effect: finiteNumber(item.effect),
    low: finiteNumber(item.low),
    high: finiteNumber(item.high),
    passed: item.passed,
    padding: finiteNumber(item.padding) ?? 0,
  };
}

const METRICS = ["ctr_adj", "clicks", "impressions"] as const;
const REASONS = [
  "LOW_DATA",
  "NO_DATA",
  "NO_SEARCH_DATA",
  "NO_PAGE",
  "GOOGLE_UPDATE",
  "OVERLAPPING_CHANGE",
  "ALERT_GONE",
  "PRE_TREND",
] as const;
const OUTCOMES = ["WORKED", "DIDNT", "INCONCLUSIVE"] as const;

// Sürüm 1 değilse ya da sonuç/ölçüt/zaman eksikse null; gerisi hoşgörülüdür.
export function parseSplitEvaluation(raw: unknown): SplitEvaluation | null {
  const item = record(raw);
  if (!item || item.v !== 1) return null;
  const metric = oneOf(item.metric, METRICS);
  const outcome = oneOf(item.outcome, OUTCOMES);
  const evaluatedAt = str(item.evaluatedAt, 40);
  const anchorDay = str(item.anchorDay, 10);
  if (!metric || !outcome || !evaluatedAt || !anchorDay) return null;
  const updates: SplitEvaluation["updates"] = [];
  for (const rawUpdate of Array.isArray(item.updates) ? item.updates : []) {
    const update = record(rawUpdate);
    const name = str(update?.name, 120);
    const kind = str(update?.kind, 40);
    const startedAt = str(update?.startedAt, 40);
    if (!update || !name || !kind || !startedAt) continue;
    updates.push({ name, kind, startedAt, endedAt: str(update.endedAt, 40) });
    if (updates.length >= SPLIT_LIMITS.updates) break;
  }
  return {
    v: 1,
    method: "DID",
    metric,
    anchorDay,
    preWeeks: dayKeys(item.preWeeks),
    postWeeks: dayKeys(item.postWeeks),
    testPages: count(item.testPages),
    controlPages: count(item.controlPages),
    usedTest: count(item.usedTest),
    usedControl: count(item.usedControl),
    excluded: count(item.excluded),
    effect: finiteNumber(item.effect),
    low: finiteNumber(item.low),
    high: finiteNumber(item.high),
    placebo: parsePlacebo(item.placebo),
    treated: parseWindowPair(item.treated),
    control: parseWindowPair(item.control),
    updates,
    truncated: item.truncated === true,
    reason: oneOf(item.reason, REASONS),
    outcome,
    confidence:
      item.confidence === "SIGNIFICANT" ? "SIGNIFICANT" : "DIRECTIONAL",
    evaluatedAt,
  };
}
