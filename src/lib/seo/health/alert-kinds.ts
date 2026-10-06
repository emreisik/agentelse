// Arama sağlığı uyarı türleri (docs/search-health.md "Uyarılar", plan SC-F3):
// her tür bir kaynağa (GSC = Search Console verisinden, SEO = kendi
// tarayıcımız / robots / kendi sitemap okumamız / CrUX), bir kontrol koduna
// (SH1–SH27) ve bir puan parçasına bağlıdır. Saf ve ortam değişkeninden
// bağımsız; Ads Telegram metni de buradan okur.
//
// Telegram: GSC türleri asla gönderilmez (telegram null; Google verisi
// operatöre gitmez). SEO türleri yalnız sabit, rakamsız, adressiz bir ifade
// taşır (test edilir).

export type SearchAlertSource = "GSC" | "SEO";

export type HealthCheckCode =
  | "SH1"
  | "SH2"
  | "SH3"
  | "SH4"
  | "SH5"
  | "SH6"
  | "SH7"
  | "SH8"
  | "SH9"
  | "SH10"
  | "SH11"
  | "SH12"
  | "SH13"
  | "SH14"
  | "SH15"
  | "SH16"
  | "SH17"
  | "SH18"
  | "SH19"
  | "SH20"
  | "SH21"
  | "SH22"
  | "SH23"
  | "SH24"
  | "SH25"
  | "SH26"
  | "SH27"
  | "CRAWL";

export type ScorePartKey =
  "indexing" | "technical" | "sitemap_robots" | "cwv" | "data";

export type SearchAlertKind =
  | "GSC_SYNC_STALE"
  | "GSC_SEARCH_DROP"
  | "SEO_KEY_PAGE_NOINDEX"
  | "SEO_ROBOTS_BLOCK"
  | "SEO_ROBOTS_ERROR"
  | "SEO_ROBOTS_ASSETS"
  | "SEO_KEY_PAGE_ERROR"
  | "GSC_CANONICAL_MISMATCH"
  | "SEO_CANONICAL_OFFSITE"
  | "GSC_INDEX_LOST"
  | "GSC_NEW_PAGES_NOT_INDEXED"
  | "GSC_COVERAGE_DROP"
  | "GSC_CRAWLED_NOT_INDEXED"
  | "GSC_SITEMAP_ERRORS"
  | "SEO_SITEMAP_MISSING"
  | "SEO_SITEMAP_HYGIENE"
  | "GSC_STALE_CRAWL"
  | "SEO_STRUCTURED_DATA"
  | "GSC_RICH_RESULTS"
  | "SEO_CWV_POOR"
  | "SEO_HTTPS"
  | "SEO_REDIRECT_CHAINS"
  | "SEO_BROKEN_LINKS"
  | "SEO_ORPHAN_PAGES"
  | "GSC_ORPHAN_PAGES"
  | "SEO_TITLES_META"
  | "SEO_HREFLANG"
  | "SEO_RENDER_RISK"
  | "GSC_UPDATE_OVERLAP"
  | "GSC_SITE_MISMATCH"
  | "GSC_CONNECTION"
  | "SEO_AI_CRAWLERS_BLOCKED"
  | "GSC_LOST_URLS"
  | "SEO_SITE_MIGRATION"
  | "SEO_CRAWL_BLOCKED";

export type SearchAlertKindDef = {
  source: SearchAlertSource;
  check: HealthCheckCode;
  part: ScorePartKey;
  telegram: string | null;
};

function gsc(check: HealthCheckCode, part: ScorePartKey): SearchAlertKindDef {
  return { source: "GSC", check, part, telegram: null };
}

function seo(
  check: HealthCheckCode,
  part: ScorePartKey,
  telegram: string,
): SearchAlertKindDef {
  return { source: "SEO", check, part, telegram };
}

export const SEARCH_ALERT_KINDS: Readonly<
  Record<SearchAlertKind, SearchAlertKindDef>
> = {
  // Veri ve bağlantı
  GSC_SYNC_STALE: gsc("SH1", "data"),
  GSC_SEARCH_DROP: gsc("SH2", "data"),
  GSC_UPDATE_OVERLAP: gsc("SH23", "data"),
  GSC_SITE_MISMATCH: gsc("SH24", "data"),
  GSC_CONNECTION: gsc("SH25", "data"),
  // İndeksleme
  GSC_INDEX_LOST: gsc("SH7", "indexing"),
  GSC_NEW_PAGES_NOT_INDEXED: gsc("SH8", "indexing"),
  GSC_COVERAGE_DROP: gsc("SH9", "indexing"),
  GSC_CRAWLED_NOT_INDEXED: gsc("SH10", "indexing"),
  GSC_CANONICAL_MISMATCH: gsc("SH6", "indexing"),
  GSC_STALE_CRAWL: gsc("SH13", "indexing"),
  GSC_RICH_RESULTS: gsc("SH14", "indexing"),
  GSC_LOST_URLS: gsc("SH27", "indexing"),
  // Sitemap ve robots
  SEO_ROBOTS_BLOCK: seo(
    "SH4",
    "sitemap_robots",
    "robots.txt is blocking search engines from important pages",
  ),
  SEO_ROBOTS_ERROR: seo(
    "SH4",
    "sitemap_robots",
    "robots.txt is returning server errors",
  ),
  SEO_ROBOTS_ASSETS: seo(
    "SH4",
    "sitemap_robots",
    "robots.txt is blocking files search engines need",
  ),
  GSC_SITEMAP_ERRORS: gsc("SH11", "sitemap_robots"),
  SEO_SITEMAP_MISSING: seo(
    "SH11",
    "sitemap_robots",
    "the sitemap could not be read",
  ),
  SEO_SITEMAP_HYGIENE: seo(
    "SH12",
    "sitemap_robots",
    "the sitemap lists pages that should not be there",
  ),
  SEO_AI_CRAWLERS_BLOCKED: seo(
    "SH26",
    "sitemap_robots",
    "robots.txt is blocking AI search crawlers",
  ),
  // Core Web Vitals
  SEO_CWV_POOR: seo("SH15", "cwv", "page speed for real visitors is poor"),
  // Teknik
  SEO_KEY_PAGE_NOINDEX: seo("SH3", "technical", "a key page is set to noindex"),
  SEO_KEY_PAGE_ERROR: seo("SH5", "technical", "a key page is not loading"),
  SEO_CANONICAL_OFFSITE: seo(
    "SH6",
    "technical",
    "a key page points search engines to another website",
  ),
  SEO_STRUCTURED_DATA: seo(
    "SH14",
    "technical",
    "structured data on a key page has errors",
  ),
  SEO_HTTPS: seo("SH16", "technical", "some pages are not fully secure"),
  SEO_REDIRECT_CHAINS: seo(
    "SH17",
    "technical",
    "internal links go through long redirect chains",
  ),
  SEO_BROKEN_LINKS: seo(
    "SH18",
    "technical",
    "the site has broken internal links",
  ),
  SEO_ORPHAN_PAGES: seo(
    "SH19",
    "technical",
    "some pages have no internal links pointing to them",
  ),
  GSC_ORPHAN_PAGES: gsc("SH19", "technical"),
  SEO_TITLES_META: seo(
    "SH20",
    "technical",
    "some pages have missing or duplicate titles or descriptions",
  ),
  SEO_HREFLANG: seo(
    "SH21",
    "technical",
    "language versions of pages are set up incorrectly",
  ),
  SEO_RENDER_RISK: seo(
    "SH22",
    "technical",
    "a key page may show little content to search engines",
  ),
  SEO_SITE_MIGRATION: seo(
    "SH27",
    "technical",
    "many page addresses changed recently",
  ),
  SEO_CRAWL_BLOCKED: seo(
    "CRAWL",
    "technical",
    "the site is blocking our site audit",
  ),
};

const KIND_NAMES = Object.keys(SEARCH_ALERT_KINDS) as SearchAlertKind[];

export const SEARCH_ALERT_KIND_NAMES: readonly SearchAlertKind[] = KIND_NAMES;

export function isSearchAlertKind(value: string): value is SearchAlertKind {
  return Object.prototype.hasOwnProperty.call(SEARCH_ALERT_KINDS, value);
}

export function kindsForSource(source: SearchAlertSource): SearchAlertKind[] {
  return KIND_NAMES.filter(
    (kind) => SEARCH_ALERT_KINDS[kind].source === source,
  );
}

// Tür ve site başına tek uyarı: "gsc:GSC_SEARCH_DROP", "seo:SEO_HTTPS".
export function searchDedupeKey(kind: SearchAlertKind): string {
  return `${SEARCH_ALERT_KINDS[kind].source.toLowerCase()}:${kind}`;
}

export const SEARCH_TELEGRAM_FALLBACK = "a search health check needs attention";

// GSC türleri ve bilinmeyen türler genel ifadeye düşer.
export function seoTelegramPhrase(kind: string): string {
  if (!isSearchAlertKind(kind)) return SEARCH_TELEGRAM_FALLBACK;
  return SEARCH_ALERT_KINDS[kind].telegram ?? SEARCH_TELEGRAM_FALLBACK;
}

export type SeoAlertDraft = {
  source: SearchAlertSource;
  kind: SearchAlertKind;
  severity: "INFO" | "WARN" | "CRITICAL";
  dedupeKey: string;
  title: string;
  detail: string | null;
  data?: Record<string, string | number | boolean | null | string[]>;
};
