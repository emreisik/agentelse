// URL Inspection sonucunun saf okuması (docs/google-search-console-plan.md
// §3.5, docs/search-health.md "URL Inspection"). Google'ın
// UrlInspectionResult biçimi: { inspectionResult: { indexStatusResult,
// richResultsResult, ... } }. Eksik ya da tanınmayan alanlar null olur;
// ayrıştırıcı hiç fırlatmaz.

export type InspectionVerdict =
  "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED";

export type RichResultsSummary = {
  verdict: string | null;
  items: {
    type: string;
    issues: { severity: "ERROR" | "WARNING"; message: string }[];
  }[];
};

export type ParsedInspection = {
  verdict: InspectionVerdict | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: Date | null;
  crawledAs: string | null;
  sitemaps: string[];
  referringUrls: string[];
  richResults: RichResultsSummary | null;
};

const VERDICTS: readonly InspectionVerdict[] = [
  "PASS",
  "PARTIAL",
  "FAIL",
  "NEUTRAL",
  "VERDICT_UNSPECIFIED",
];

// Saklanan liste sınırları (satır büyümesin).
const MAX_REFERRING_URLS = 5;
const MAX_SITEMAPS = 20;
const MAX_RICH_ITEMS = 20;
const MAX_RICH_ISSUES = 20;
const MAX_TEXT = 500;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, MAX_TEXT)
    : null;
}

function texts(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(text)
    .filter((item): item is string => item !== null)
    .slice(0, max);
}

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function verdictOf(value: unknown): InspectionVerdict | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return VERDICTS.includes(value as InspectionVerdict)
    ? (value as InspectionVerdict)
    : "VERDICT_UNSPECIFIED";
}

// richResultsResult.detectedItems[].items[].issues[] tek listeye iner.
function parseRichResults(value: unknown): RichResultsSummary | null {
  const raw = record(value);
  if (!raw) return null;
  const detected = Array.isArray(raw.detectedItems) ? raw.detectedItems : [];
  const items = detected.slice(0, MAX_RICH_ITEMS).flatMap((entry) => {
    const item = record(entry);
    const type = text(item?.richResultType);
    if (!item || !type) return [];
    const subItems = Array.isArray(item.items) ? item.items : [];
    const issues = subItems
      .flatMap((sub) => {
        const list = record(sub)?.issues;
        return Array.isArray(list) ? list : [];
      })
      .flatMap((issue) => {
        const row = record(issue);
        const message = text(row?.issueMessage);
        if (!row || !message) return [];
        const severity: "ERROR" | "WARNING" =
          row.severity === "ERROR" ? "ERROR" : "WARNING";
        return [{ severity, message }];
      })
      .slice(0, MAX_RICH_ISSUES);
    return [{ type, issues }];
  });
  return { verdict: text(raw.verdict), items };
}

export function parseInspectionResult(raw: unknown): ParsedInspection {
  const root = record(raw);
  // Tam yanıt da, yalnız inspectionResult nesnesi de kabul edilir.
  const result = record(root?.inspectionResult) ?? root;
  const index = record(result?.indexStatusResult);
  return {
    verdict: verdictOf(index?.verdict),
    coverageState: text(index?.coverageState),
    indexingState: text(index?.indexingState),
    robotsTxtState: text(index?.robotsTxtState),
    pageFetchState: text(index?.pageFetchState),
    googleCanonical: text(index?.googleCanonical),
    userCanonical: text(index?.userCanonical),
    lastCrawlTime: date(index?.lastCrawlTime),
    crawledAs: text(index?.crawledAs),
    sitemaps: texts(index?.sitemap, MAX_SITEMAPS),
    referringUrls: texts(index?.referringUrls, MAX_REFERRING_URLS),
    richResults: parseRichResults(result?.richResultsResult),
  };
}

export function isIndexedVerdict(verdict: string | null): boolean {
  return verdict === "PASS";
}

// "Crawled - currently not indexed" (tire ya da en-dash, boşluklar esnek).
const CRAWLED_NOT_INDEXED = /crawled\s*[-–]\s*currently not indexed/i;

export function isCrawledNotIndexed(coverageState: string | null): boolean {
  return coverageState !== null && CRAWLED_NOT_INDEXED.test(coverageState);
}

export function verdictLabel(
  verdict: string | null,
): "Indexed" | "Not indexed" | "Partly indexed" | "Not checked yet" {
  if (verdict === "PASS") return "Indexed";
  if (verdict === "PARTIAL") return "Partly indexed";
  if (verdict === "FAIL" || verdict === "NEUTRAL") return "Not indexed";
  return "Not checked yet";
}

export function richResultErrorCount(
  summary: RichResultsSummary | null,
): number {
  if (!summary) return 0;
  return summary.items.reduce(
    (sum, item) =>
      sum + item.issues.filter((issue) => issue.severity === "ERROR").length,
    0,
  );
}
