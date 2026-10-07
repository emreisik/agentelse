// SEO eylem türleri ve durumları (docs/google-search-console-plan.md SC-F6).
// Yalnız dize ve sabit içerir; hiçbir şey içe aktarmaz, bu yüzden istemci
// bileşenleri de güvenle alabilir. Saf ve izomorfik.

export const SEO_FIX_KINDS = [
  "TITLE_META",
  "CONTENT_REFRESH",
  "NEW_CONTENT",
  "LOCALIZE",
  "INTERNAL_LINKS",
  "CONSOLIDATE",
  "TECH_FIX",
  "SCHEMA",
  "CWV_FIX",
  "SITEMAP_FIX",
] as const;
export type SeoFixKind = (typeof SEO_FIX_KINDS)[number];

const FIX_KIND_SET: ReadonlySet<string> = new Set(SEO_FIX_KINDS);

export function isSeoFixKind(value: unknown): value is SeoFixKind {
  return typeof value === "string" && FIX_KIND_SET.has(value);
}

export const SEO_ACTION_STATUSES = [
  "PROPOSED",
  "ACCEPTED",
  "APPLIED",
  "VERIFIED",
  "EVALUATING",
  "WORKED",
  "DIDNT",
  "INCONCLUSIVE",
  "DISMISSED",
  "EXPIRED",
] as const;
export type SeoActionStatus = (typeof SEO_ACTION_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(SEO_ACTION_STATUSES);

export function isSeoActionStatus(value: unknown): value is SeoActionStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

// Açık durumlar openKey tekilliğini tutar; terminal durumlarda openKey null olur.
export const OPEN_ACTION_STATUSES: readonly SeoActionStatus[] = [
  "PROPOSED",
  "ACCEPTED",
  "APPLIED",
  "VERIFIED",
  "EVALUATING",
];
export const TERMINAL_ACTION_STATUSES: readonly SeoActionStatus[] = [
  "WORKED",
  "DIDNT",
  "INCONCLUSIVE",
  "DISMISSED",
  "EXPIRED",
];

// SC-F4 bulgusunun actionKind'i → eylem türü. INVESTIGATE ve bilinmeyen
// değerlerin düzeltme eylemi yoktur.
export function fixKindForFinding(actionKind: string): SeoFixKind | null {
  if (actionKind === "INVESTIGATE") return null;
  return isSeoFixKind(actionKind) ? actionKind : null;
}

export function isFixableFindingKind(actionKind: string): boolean {
  return fixKindForFinding(actionKind) !== null;
}

export type TechIssue =
  | "NOINDEX"
  | "STATUS"
  | "CANONICAL"
  | "ROBOTS"
  | "REDIRECT"
  | "HREFLANG"
  | "OTHER";

// "I fixed this" düğmesi olan sağlık uyarıları (AdsAlert.kind → eylem türü).
// Anahtar listesi bilerek sabittir; yeni bir uyarı türü burada açıkça eklenmeden
// düzeltme eylemi almaz.
export const HEALTH_FIX_KINDS: Readonly<
  Record<string, { kind: SeoFixKind; issue?: TechIssue }>
> = {
  SEO_KEY_PAGE_NOINDEX: { kind: "TECH_FIX", issue: "NOINDEX" },
  SEO_KEY_PAGE_ERROR: { kind: "TECH_FIX", issue: "STATUS" },
  SEO_ROBOTS_BLOCK: { kind: "TECH_FIX", issue: "ROBOTS" },
  SEO_CANONICAL_OFFSITE: { kind: "TECH_FIX", issue: "CANONICAL" },
  GSC_CANONICAL_MISMATCH: { kind: "TECH_FIX", issue: "CANONICAL" },
  SEO_REDIRECT_CHAINS: { kind: "TECH_FIX", issue: "REDIRECT" },
  SEO_HREFLANG: { kind: "TECH_FIX", issue: "HREFLANG" },
  SEO_STRUCTURED_DATA: { kind: "SCHEMA" },
  GSC_RICH_RESULTS: { kind: "SCHEMA" },
  SEO_CWV_POOR: { kind: "CWV_FIX" },
  GSC_SITEMAP_ERRORS: { kind: "SITEMAP_FIX" },
  SEO_SITEMAP_MISSING: { kind: "SITEMAP_FIX" },
  SEO_SITEMAP_HYGIENE: { kind: "SITEMAP_FIX" },
};

// Google'ın yeniden taramasını URL Inspection ile görmemiz gereken uyarılar.
export const INSPECTION_ALERT_KINDS: readonly string[] = [
  "GSC_CANONICAL_MISMATCH",
  "GSC_RICH_RESULTS",
];
