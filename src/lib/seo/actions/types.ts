import type { SeoActionStatus, SeoFixKind, TechIssue } from "./kinds";

// SEO eylem kaydının tipleri ve saklanan JSON'un hoşgörülü okuyucuları
// (docs/google-search-console-plan.md SC-F6). Saf ve izomorfik. Saklanan
// JSON'a güvenilmez: yanlış biçimli öğeler tek tek atılır, listeler ve
// metinler sınırlanır, hiçbir okuyucu fırlatmaz.

export * from "./kinds";

export type SeoActionSource =
  "FINDING" | "SEO_MANAGER" | "HEALTH_ISSUE" | "OPPORTUNITY_DONE";
export type SeoAppliedVia = "USER" | "DETECTED" | "CMS";
export type SeoOutcome = "WORKED" | "DIDNT" | "INCONCLUSIVE";
export type SeoActionConfidence = "SIGNIFICANT" | "DIRECTIONAL";

export type SnippetText = { title: string; metaDescription: string };

export type PageSnapshot = {
  url: string;
  status: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  h2: string[];
  canonical: string | null;
  noindex: boolean;
  indexable: boolean | null;
  wordCount: number | null;
  textHash: string | null;
  schemaTypes: string[];
  schemaErrors: number;
  fetchedAt: string;
  source: "FETCH" | "CRAWL";
};

export type SeoActionProposal =
  | {
      kind: "TITLE_META";
      before: SnippetText | null;
      after: SnippetText | null;
      variants: (SnippetText & { angle: string })[];
    }
  | {
      kind: "CONTENT_REFRESH";
      primaryKeyword: string | null;
      missing: string[];
      after: { title: string; metaDescription: string; wordCount: number } | null;
    }
  | {
      kind: "NEW_CONTENT" | "LOCALIZE";
      title: string;
      primaryKeyword: string | null;
      language: string | null;
      liveUrl: string | null;
    }
  | {
      kind: "INTERNAL_LINKS";
      links: { fromUrl: string; toUrl: string; anchor: string }[];
    }
  | {
      kind: "CONSOLIDATE";
      from: string[];
      to: string;
      method: "REDIRECT" | "CANONICAL" | null;
    }
  | { kind: "TECH_FIX"; issue: TechIssue; issueCodes: string[] }
  | { kind: "SCHEMA"; types: string[] }
  | {
      kind: "CWV_FIX";
      metric: "lcp" | "inp" | "cls" | null;
      formFactor: "PHONE" | "DESKTOP" | null;
    }
  | { kind: "SITEMAP_FIX"; sitemapUrls: string[] };

export type SeoActionProposalStored = SeoActionProposal & {
  v: 1;
  // Kullanıcının yazdığı not (en çok 400 karakter).
  note: string | null;
  alert: { kind: string; dedupeKey: string; source: "GSC" | "SEO" } | null;
};

// label sabit İngilizce; observed yalnız kendi sitemizden okunan değerdir
// (Google verisi değil) ve 200 karakterle sınırlıdır.
export type VerificationCheck = {
  key: string;
  label: string;
  ok: boolean;
  observed: string | null;
};

export type VerificationMethod =
  "CRAWLER" | "ALERT" | "CRUX" | "SITEMAP" | "USER" | "DETECTED";

export type GoogleStage = {
  state: "pending" | "seen" | "not_seen" | "skipped";
  requestedAt: string | null;
  lastCrawlTime: string | null;
  verdict: string | null;
  richResultsVerdict: string | null;
  checkedAt: string | null;
};

export type SeoVerification = {
  v: 1;
  attempts: number;
  quickRetries: { day: string; count: number } | null;
  lastCheckedAt: string | null;
  checks: VerificationCheck[];
  method: VerificationMethod | null;
  liveSince: string | null;
  google: GoogleStage | null;
  reason:
    | "NOT_SEEN"
    | "FETCH_FAILED"
    | "OUT_OF_SCOPE"
    | "ROBOTS"
    | "NO_SITE"
    | null;
};

export type MetricWindow = {
  weeks: number;
  clicks: number;
  impressions: number;
  // Kesir (yüzde değil).
  ctr: number | null;
  position: number | null;
  // Tıklama ÷ beklenen tıklama.
  ctrAdj: number | null;
};

export type EvaluationMethod =
  "DID" | "DID_SITE" | "PRE_POST" | "LAUNCH" | "ALERT" | "CRUX" | "SITEMAP" | "NONE";
export type DidMetric = "ctr_adj" | "clicks" | "impressions";
export type EvaluationReason =
  | "LOW_DATA"
  | "NO_DATA"
  | "NO_SEARCH_DATA"
  | "NO_PAGE"
  | "GOOGLE_UPDATE"
  | "OVERLAPPING_CHANGE"
  | "ALERT_GONE";

export type SeoEvaluation = {
  v: 1;
  method: EvaluationMethod;
  metric: DidMetric | "index" | "cwv" | "sitemap_errors" | "alert" | null;
  anchorDay: string | null;
  preWeeks: string[];
  postWeeks: string[];
  // Kesir (yüzde değil).
  effect: number | null;
  low: number | null;
  high: number | null;
  controls: number;
  yoyAdjusted: boolean;
  treated: { before: MetricWindow; after: MetricWindow } | null;
  control: { before: MetricWindow; after: MetricWindow } | null;
  yoy: number | null;
  updates: {
    name: string;
    kind: string;
    startedAt: string;
    endedAt: string | null;
  }[];
  truncated: boolean;
  cwv: { metric: string; before: number | null; after: number | null } | null;
  sitemap: {
    errorsBefore: number | null;
    errorsAfter: number | null;
    ownOk: boolean;
  } | null;
  reason: EvaluationReason | null;
  outcome: SeoOutcome;
  confidence: SeoActionConfidence;
  evaluatedAt: string;
};

export type SeoActionView = {
  id: string;
  projectId: string;
  workspaceId: string;
  isMock: boolean;
  linkId: string | null;
  findingId: string | null;
  source: SeoActionSource;
  kind: SeoFixKind;
  status: SeoActionStatus;
  targetUrl: string | null;
  targetUrlHash: string | null;
  targetPath: string | null;
  pageId: string | null;
  targetQueries: string[];
  proposal: SeoActionProposalStored;
  baseline: PageSnapshot | null;
  verification: SeoVerification;
  evaluation: SeoEvaluation | null;
  outcome: SeoOutcome | null;
  confidence: SeoActionConfidence | null;
  appliedVia: SeoAppliedVia | null;
  appliedAt: Date | null;
  verifiedAt: Date | null;
  askedAt: Date | null;
  measureFrom: Date | null;
  evaluateAfter: Date | null;
  evaluatedAt: Date | null;
  nextCheckAt: Date | null;
  windowDays: number;
  commandId: string | null;
  workId: string | null;
  creativeId: string | null;
  learningId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// Sınırlar.
export const PROPOSAL_LIMITS = {
  variants: 3,
  missing: 8,
  links: 5,
  from: 4,
  h2: 20,
  checks: 20,
  updates: 10,
  issueCodes: 10,
  schemaTypes: 10,
  sitemapUrls: 10,
  title: 120,
  meta: 320,
  anchor: 120,
  note: 400,
  observed: 200,
  url: 2048,
  phrase: 160,
} as const;

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function clamp(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = clamp(value, max);
  return text ? text : null;
}

function strOr(value: unknown, max: number): string {
  return str(value, max) ?? "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number {
  const n = finiteNumber(value);
  return n === null ? 0 : Math.max(0, Math.round(n));
}

function bool(value: unknown): boolean {
  return value === true;
}

// Boş olmayan metin listesi; geçersiz öğeler atılır, sınır uygulanır.
function strings(value: unknown, limit: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = str(item, max);
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function snippetText(value: unknown): SnippetText | null {
  const item = record(value);
  if (!item || typeof item.title !== "string") return null;
  return {
    title: clamp(item.title, PROPOSAL_LIMITS.title),
    metaDescription: strOr(item.metaDescription, PROPOSAL_LIMITS.meta),
  };
}

const TECH_ISSUES: readonly TechIssue[] = [
  "NOINDEX",
  "STATUS",
  "CANONICAL",
  "ROBOTS",
  "REDIRECT",
  "HREFLANG",
  "OTHER",
];

function oneOf<T extends string>(
  value: unknown,
  list: readonly T[],
): T | null {
  return list.find((item) => item === value) ?? null;
}

function parseAlert(value: unknown): SeoActionProposalStored["alert"] {
  const item = record(value);
  if (!item) return null;
  const kind = str(item.kind, 80);
  const dedupeKey = str(item.dedupeKey, 200);
  if (!kind || !dedupeKey) return null;
  // Eski kayıtlarda kaynak yoksa yalnız tarayıcı uyarısı varsayılır.
  return { kind, dedupeKey, source: item.source === "GSC" ? "GSC" : "SEO" };
}

function proposalBody(
  item: Json,
  kind: SeoFixKind,
): SeoActionProposal | null {
  switch (kind) {
    case "TITLE_META": {
      const variants: (SnippetText & { angle: string })[] = [];
      for (const raw of Array.isArray(item.variants) ? item.variants : []) {
        const text = snippetText(raw);
        if (!text) continue;
        variants.push({
          ...text,
          angle: strOr(record(raw)?.angle, PROPOSAL_LIMITS.phrase),
        });
        if (variants.length >= PROPOSAL_LIMITS.variants) break;
      }
      return {
        kind,
        before: snippetText(item.before),
        after: snippetText(item.after),
        variants,
      };
    }
    case "CONTENT_REFRESH": {
      const after = record(item.after);
      return {
        kind,
        primaryKeyword: str(item.primaryKeyword, PROPOSAL_LIMITS.phrase),
        missing: strings(
          item.missing,
          PROPOSAL_LIMITS.missing,
          PROPOSAL_LIMITS.phrase,
        ),
        after:
          after && typeof after.title === "string"
            ? {
                title: clamp(after.title, PROPOSAL_LIMITS.title),
                metaDescription: strOr(
                  after.metaDescription,
                  PROPOSAL_LIMITS.meta,
                ),
                wordCount: count(after.wordCount),
              }
            : null,
      };
    }
    case "NEW_CONTENT":
    case "LOCALIZE":
      return {
        kind,
        title: strOr(item.title, PROPOSAL_LIMITS.title),
        primaryKeyword: str(item.primaryKeyword, PROPOSAL_LIMITS.phrase),
        language: str(item.language, 16),
        liveUrl: str(item.liveUrl, PROPOSAL_LIMITS.url),
      };
    case "INTERNAL_LINKS": {
      const links: { fromUrl: string; toUrl: string; anchor: string }[] = [];
      for (const raw of Array.isArray(item.links) ? item.links : []) {
        const link = record(raw);
        const fromUrl = str(link?.fromUrl, PROPOSAL_LIMITS.url);
        const toUrl = str(link?.toUrl, PROPOSAL_LIMITS.url);
        if (!fromUrl || !toUrl) continue;
        links.push({
          fromUrl,
          toUrl,
          anchor: strOr(link?.anchor, PROPOSAL_LIMITS.anchor),
        });
        if (links.length >= PROPOSAL_LIMITS.links) break;
      }
      return { kind, links };
    }
    case "CONSOLIDATE":
      return {
        kind,
        from: strings(item.from, PROPOSAL_LIMITS.from, PROPOSAL_LIMITS.url),
        to: strOr(item.to, PROPOSAL_LIMITS.url),
        method: oneOf(item.method, ["REDIRECT", "CANONICAL"] as const),
      };
    case "TECH_FIX":
      return {
        kind,
        issue: oneOf(item.issue, TECH_ISSUES) ?? "OTHER",
        issueCodes: strings(item.issueCodes, PROPOSAL_LIMITS.issueCodes, 40),
      };
    case "SCHEMA":
      return {
        kind,
        types: strings(item.types, PROPOSAL_LIMITS.schemaTypes, 60),
      };
    case "CWV_FIX":
      return {
        kind,
        metric: oneOf(item.metric, ["lcp", "inp", "cls"] as const),
        formFactor: oneOf(item.formFactor, ["PHONE", "DESKTOP"] as const),
      };
    case "SITEMAP_FIX":
      return {
        kind,
        sitemapUrls: strings(
          item.sitemapUrls,
          PROPOSAL_LIMITS.sitemapUrls,
          PROPOSAL_LIMITS.url,
        ),
      };
  }
}

// Saklanan teklifin geri okunması; tür uyuşmazsa null.
export function parseProposal(
  value: unknown,
  kind: SeoFixKind,
): SeoActionProposalStored | null {
  const item = record(value);
  if (!item || item.kind !== kind) return null;
  const body = proposalBody(item, kind);
  if (!body) return null;
  return {
    ...body,
    v: 1,
    note: str(item.note, PROPOSAL_LIMITS.note),
    alert: parseAlert(item.alert),
  };
}

export function emptyProposal(kind: SeoFixKind): SeoActionProposalStored {
  const body = proposalBody({}, kind);
  // proposalBody her geçerli tür için bir gövde döndürür.
  if (!body) throw new Error(`Unknown SEO fix kind: ${kind}`);
  return { ...body, v: 1, note: null, alert: null };
}

export function parsePageSnapshot(value: unknown): PageSnapshot | null {
  const item = record(value);
  if (!item) return null;
  const url = str(item.url, PROPOSAL_LIMITS.url);
  const fetchedAt = str(item.fetchedAt, 40);
  if (!url || !fetchedAt) return null;
  const status = finiteNumber(item.status);
  const wordCount = finiteNumber(item.wordCount);
  return {
    url,
    status: status === null ? null : Math.round(status),
    title: str(item.title, 300),
    metaDescription: str(item.metaDescription, 500),
    h1: str(item.h1, 300),
    h2: strings(item.h2, PROPOSAL_LIMITS.h2, 300),
    canonical: str(item.canonical, PROPOSAL_LIMITS.url),
    noindex: bool(item.noindex),
    indexable: typeof item.indexable === "boolean" ? item.indexable : null,
    wordCount: wordCount === null ? null : Math.max(0, Math.round(wordCount)),
    textHash: str(item.textHash, 64),
    schemaTypes: strings(item.schemaTypes, PROPOSAL_LIMITS.schemaTypes, 60),
    schemaErrors: count(item.schemaErrors),
    fetchedAt,
    source: item.source === "CRAWL" ? "CRAWL" : "FETCH",
  };
}

const VERIFICATION_METHODS: readonly VerificationMethod[] = [
  "CRAWLER",
  "ALERT",
  "CRUX",
  "SITEMAP",
  "USER",
  "DETECTED",
];
const VERIFICATION_REASONS = [
  "NOT_SEEN",
  "FETCH_FAILED",
  "OUT_OF_SCOPE",
  "ROBOTS",
  "NO_SITE",
] as const;
const GOOGLE_STATES = ["pending", "seen", "not_seen", "skipped"] as const;

function parseGoogleStage(value: unknown): GoogleStage | null {
  const item = record(value);
  const state = oneOf(item?.state, GOOGLE_STATES);
  if (!item || !state) return null;
  return {
    state,
    requestedAt: str(item.requestedAt, 40),
    lastCrawlTime: str(item.lastCrawlTime, 40),
    verdict: str(item.verdict, 40),
    richResultsVerdict: str(item.richResultsVerdict, 40),
    checkedAt: str(item.checkedAt, 40),
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
      observed: str(item.observed, PROPOSAL_LIMITS.observed),
    });
    if (checks.length >= PROPOSAL_LIMITS.checks) break;
  }
  return checks;
}

export function parseVerification(value: unknown): SeoVerification {
  const item = record(value);
  const retries = record(item?.quickRetries);
  const day = str(retries?.day, 10);
  return {
    v: 1,
    attempts: count(item?.attempts),
    quickRetries: retries && day ? { day, count: count(retries.count) } : null,
    lastCheckedAt: str(item?.lastCheckedAt, 40),
    checks: parseChecks(item?.checks),
    method: oneOf(item?.method, VERIFICATION_METHODS),
    liveSince: str(item?.liveSince, 40),
    google: parseGoogleStage(item?.google),
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

const EVALUATION_METHODS: readonly EvaluationMethod[] = [
  "DID",
  "DID_SITE",
  "PRE_POST",
  "LAUNCH",
  "ALERT",
  "CRUX",
  "SITEMAP",
  "NONE",
];
const EVALUATION_METRICS = [
  "ctr_adj",
  "clicks",
  "impressions",
  "index",
  "cwv",
  "sitemap_errors",
  "alert",
] as const;
const EVALUATION_REASONS: readonly EvaluationReason[] = [
  "LOW_DATA",
  "NO_DATA",
  "NO_SEARCH_DATA",
  "NO_PAGE",
  "GOOGLE_UPDATE",
  "OVERLAPPING_CHANGE",
  "ALERT_GONE",
];
const OUTCOMES: readonly SeoOutcome[] = ["WORKED", "DIDNT", "INCONCLUSIVE"];

function dayKeys(value: unknown): string[] {
  return strings(value, 64, 10);
}

// Sürüm 1 değilse ya da sonuç/çıktı eksikse null; gerisi hoşgörülüdür.
export function parseEvaluation(value: unknown): SeoEvaluation | null {
  const item = record(value);
  if (!item || item.v !== 1) return null;
  const method = oneOf(item.method, EVALUATION_METHODS);
  const outcome = oneOf(item.outcome, OUTCOMES);
  const evaluatedAt = str(item.evaluatedAt, 40);
  if (!method || !outcome || !evaluatedAt) return null;
  const updates: SeoEvaluation["updates"] = [];
  for (const raw of Array.isArray(item.updates) ? item.updates : []) {
    const update = record(raw);
    const name = str(update?.name, 120);
    const kind = str(update?.kind, 40);
    const startedAt = str(update?.startedAt, 40);
    if (!update || !name || !kind || !startedAt) continue;
    updates.push({
      name,
      kind,
      startedAt,
      endedAt: str(update.endedAt, 40),
    });
    if (updates.length >= PROPOSAL_LIMITS.updates) break;
  }
  const cwv = record(item.cwv);
  const sitemap = record(item.sitemap);
  const metric = oneOf(item.metric, EVALUATION_METRICS);
  return {
    v: 1,
    method,
    metric,
    anchorDay: str(item.anchorDay, 10),
    preWeeks: dayKeys(item.preWeeks),
    postWeeks: dayKeys(item.postWeeks),
    effect: finiteNumber(item.effect),
    low: finiteNumber(item.low),
    high: finiteNumber(item.high),
    controls: count(item.controls),
    yoyAdjusted: bool(item.yoyAdjusted),
    treated: parseWindowPair(item.treated),
    control: parseWindowPair(item.control),
    yoy: finiteNumber(item.yoy),
    updates,
    truncated: bool(item.truncated),
    cwv:
      cwv && typeof cwv.metric === "string"
        ? {
            metric: clamp(cwv.metric, 20),
            before: finiteNumber(cwv.before),
            after: finiteNumber(cwv.after),
          }
        : null,
    sitemap: sitemap
      ? {
          errorsBefore: finiteNumber(sitemap.errorsBefore),
          errorsAfter: finiteNumber(sitemap.errorsAfter),
          ownOk: bool(sitemap.ownOk),
        }
      : null,
    reason: oneOf(item.reason, EVALUATION_REASONS),
    outcome,
    confidence: item.confidence === "SIGNIFICANT" ? "SIGNIFICANT" : "DIRECTIONAL",
    evaluatedAt,
  };
}
