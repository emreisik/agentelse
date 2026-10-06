// Arama sağlığı ve teknik denetim sınırları (docs/google-search-console-plan.md
// SC-F3). Saf sabitler; tarayıcı, örnekleyici ve sağlık koşucusu buradan okur.

// Tarayıcı kimliği (agentelse.com/bot sayfası bu iki değeri anlatır).
export const SEO_CRAWLER_TOKEN = "AgentelseSiteAudit";
export const SEO_CRAWLER_USER_AGENT =
  "AgentelseSiteAudit/1.0 (+https://agentelse.com/bot)";

// Alan adı doğrulaması: ana sayfada meta etiketi ya da DNS TXT kaydı.
export const SEO_VERIFY_META_NAME = "agentelse-site-verification";
export const SEO_VERIFY_TXT_PREFIX = "agentelse-site-verification=";

// Haftalık tam tarama.
export const CRAWL_PAGES_PER_WEEK = 500;
export const CRAWL_PAGE_LIMITS = [100, 250, 500] as const;
export const CRAWL_MIN_INTERVAL_MS = 1_000;
export const CRAWL_MAX_CRAWL_DELAY_MS = 10_000;
export const CRAWL_MAX_BYTES = 2_000_000;
export const CRAWL_TIMEOUT_MS = 12_000;
export const CRAWL_MAX_REDIRECTS = 4;
export const CRAWL_TICK_BUDGET_MS = 45_000;
export const CRAWL_LEASE_MS = 300_000;
export const CRAWL_FRONTIER_MAX = 2_000;
export const CRAWL_FRONTIER_URL_MAX = 512;
export const CRAWL_LINKS_PER_PAGE = 300;
export const CRAWL_GSC_SEEDS = 200;
export const CRAWL_MIN_RELEASE_MS = 60_000;
// 429/503: site clamp(Retry-After ?? 30 dk, 30 dk, 6 sa) bekletilir.
export const CRAWL_PAUSE_MIN_MS = 1_800_000;
export const CRAWL_PAUSE_MAX_MS = 21_600_000;

// robots.txt.
export const ROBOTS_MAX_BYTES = 512_000;
export const ROBOTS_CACHE_MS = 86_400_000;
export const ROBOTS_RETRY_DELAY_MS = 10_000;
export const ROBOTS_BACKOFF_BASE_MS = 1_800_000;
export const ROBOTS_BACKOFF_MAX_MS = 21_600_000;

// Kendi sitemap okumamız.
export const SITEMAP_MAX_BYTES = 10_000_000;
export const SITEMAP_MAX_FILES = 20;
export const SITEMAP_MAX_STORED_URLS = 10_000;
export const SITEMAP_EVERY_MS = 86_400_000;

// Gerileme bekçisi ve kilit sayfalar.
export const REGRESSION_EVERY_MS = 21_600_000;
export const KEY_PAGE_COUNT = 20;
export const KEY_CHECK_FRESH_MS = 43_200_000;

// URL Inspection bütçesi (site başına PT günü) ve kapsama örneklemi.
export const INSPECTION_DAILY_BUDGET = 200;
export const INSPECTIONS_PER_RUN = 10;
export const INSPECTION_RUN_GAP_MS = 60_000;
export const INSPECTION_QUEUE_MAX = 20;
export const COVERAGE_SAMPLE_TARGET = 100;

export const GSC_SITEMAPS_EVERY_MS = 86_400_000;

// Core Web Vitals (CrUX).
export const CWV_EVERY_MS = 604_800_000;
export const CRUX_REQUESTS_PER_MINUTE = 120;

// Sağlık koşusu, elle yeniden tarama ve doğrulama tazeleme aralıkları.
export const HEALTH_EVERY_MS = 21_600_000;
export const RECRAWL_MIN_GAP_MS = 86_400_000;
export const VERIFY_RECHECK_MS = 2_592_000_000;
