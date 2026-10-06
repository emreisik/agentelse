import { KEY_CHECK_FRESH_MS } from "@/lib/seo/audit-constants";
import {
  inScope,
  normalizeCrawlUrl,
  pathOf,
  type CrawlScope,
} from "@/lib/seo/crawl-url";
import { addDays } from "@/lib/seo/dates";
import {
  aiCrawlerAccess,
  isAllowed,
  isAllowedInGroup,
  parseRobotsTxt,
  starGroup,
  type ParsedRobots,
} from "@/lib/seo/robots-parser";
import type { TaCode } from "@/lib/seo/technical-audit";

import {
  SEARCH_ALERT_KIND_NAMES,
  SEARCH_ALERT_KINDS,
  kindsForSource,
  searchDedupeKey,
  type ScorePartKey,
  type SearchAlertKind,
  type SearchAlertSource,
  type SeoAlertDraft,
} from "./alert-kinds";
import { dropVerdict, type DropDay } from "./search-drop";

// Arama sağlığı kontrolleri SH1–SH27 (docs/search-health.md "Kontroller"),
// saf. Girdiyi snapshot.ts toplar; burada yalnız kurallar var. Her tür için
// iki soru: taslak var mı ve tür bu turda "değerlendirildi" mi?
// Değerlendirilen ama taslağı olmayan türün açık uyarısı kapanır; girdisi
// bayat ya da geçici olarak eksik olan tür değerlendirilmez (uyarı açık
// kalır). Kaynağı kapatılan tür (tarama kapalı / kapsam yok, GSC bağı yok,
// CWV kapalı, proje PAUSED/CLOSED) taslaksız değerlendirilir, yani kapanır.
// Google kökenli içerik (tık oranları, GSC sayfa yolları) yalnız source GSC
// taslaklarında; SEO taslakları yalnız kendi taramamızın yollarını taşır.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const CRAWL_FRESH_MS = 8 * DAY_MS;
export const ROBOTS_FRESH_MS = 26 * HOUR_MS;
export const SITEMAPS_FRESH_MS = 26 * HOUR_MS;
export const CWV_FRESH_MS = 8 * DAY_MS;
const LINK_GRACE_MS = 48 * HOUR_MS;
const DAILY_STALE_MS = 36 * HOUR_MS;
const STALE_FINAL_DAYS = 5;
const STALE_CRAWL_MS = 60 * DAY_MS;
const SITEMAP_PENDING_MS = 7 * DAY_MS;
const SITEMAP_DOWNLOAD_MS = 14 * DAY_MS;
const DETAIL_PATHS = 10;

export type KeyPageInspection = {
  verdict: string | null;
  previousVerdict: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlTime: Date | null;
  richResultErrors: number;
};

export type KeyPageCheck = {
  url: string;
  path: string;
  isHomepage: boolean;
  status: number | null;
  fetchError: string | null;
  // Bir önceki kontrolün fetchError'ı (SeoPage.previous)
  previousFetchError: string | null;
  noindexMeta: boolean;
  noindexHeader: boolean;
  canonical: string | null;
  renderRisk: boolean;
  schemaErrors: number;
  // Son kontrol zamanı (SeoPage.lastCrawledAt); hiç kontrol edilmediyse null
  checkedAt: Date | null;
  // URL Inspection sonucu (yalnız GSC bağı varken)
  inspection: KeyPageInspection | null;
};

export type CoverageWeekLike = {
  weekStart: string;
  sampled: number;
  indexed: number;
  crawledNotIndexed: number;
  point: number;
  low: number;
  high: number;
};

export type GscSitemapLike = {
  path: string;
  isPending: boolean;
  lastSubmitted: Date | null;
  lastDownloaded: Date | null;
  errors: number;
};

export type SitemapSummaryLike = {
  url: string;
  status: number | null;
  kind: string;
};

export type LostUrlsLike = {
  rows: { fromPath: string; keyPage: boolean }[];
  lostClicksShare: number | null;
};

export type SearchUpdateLike = {
  name: string;
  startedAt: Date;
  endedAt: Date | null;
};

export type SearchHealthInput = {
  now: Date;
  projectStatus: string | null;
  scope: CrawlScope | null;
  // SeoFlags.crawl() && settings.crawlEnabled && kapsam var
  crawlEnabled: boolean;
  crawlBlocked: boolean;
  lastFullCrawlAt: Date | null;
  lastRegressionAt: Date | null;
  lastFull: {
    status: string;
    pagesFetched: number;
    finishedAt: Date | null;
    newUrls: number;
    knownNowRedirect: number;
    knownRefetched: number;
  } | null;
  // null: okunamadı
  keyPages: KeyPageCheck[] | null;
  robots: {
    verdict: string | null;
    failures: number;
    fetchedAt: Date | null;
    body: string | null;
  } | null;
  sitemaps: {
    checkedAt: Date | null;
    summaries: SitemapSummaryLike[];
  } | null;
  // Ana sayfanın aynı kökten CSS/JS adresleri
  homepageAssets: string[];
  httpRedirectsToHttps: boolean | null;
  // Tam taramanın sorun sayıları; null: okunamadı
  issues: {
    counts: Partial<Record<TaCode, number>>;
    // TA11 sorunu olup iç linki olan sayfalar
    redirectChainsLinked: number;
    // http:// üzerinden 200 dönen sayfalar
    httpPages: number;
    // Sitemap'te olup taranmış sayfalar ve bunların indekslenemeyenleri
    sitemapCrawled: number;
    sitemapBad: number;
  } | null;
  technicalCleanShare: number | null;
  cwv: {
    // cwvEnabled() ve kapsam var
    enabled: boolean;
    checkedAt: Date | null;
    // Telefon ve masaüstünün kötüsü (origin kaydı); kayıt yoksa null
    overall: "good" | "needs-improvement" | "poor" | null;
    worsened: boolean;
    hasOrigin: boolean;
  } | null;
  gsc: {
    link: {
      createdAt: Date;
      health: string;
      domainMatch: boolean | null;
      lastFinalDate: string | null;
      consecutiveFailures: number;
      lastDailyAt: Date | null;
    };
    // gscToday(now)
    today: string;
    // Kesinleşmiş günler (eskiden yeniye); null: okunamadı
    days: DropDay[] | null;
    updates: SearchUpdateLike[] | null;
    coverage: {
      current: CoverageWeekLike | null;
      earlier: CoverageWeekLike | null;
      // coverageDropped(earlier, current)
      dropped: boolean;
    } | null;
    newSitemapUrls: { inspected: number; notIndexed: number } | null;
    sitemaps: { checkedAt: Date | null; rows: GscSitemapLike[] } | null;
    lostUrls: LostUrlsLike | null;
    // Son 4 tam haftanın ilk 200 GSC sayfasından iç linki olmayanlar (yollar)
    orphanPaths: string[] | null;
  } | null;
};

export type SearchHealthEvaluation = {
  drafts: SeoAlertDraft[];
  evaluated: Record<SearchAlertSource, SearchAlertKind[]>;
  available: Record<ScorePartKey, boolean>;
  technicalCleanShare: number | null;
  coveragePoint: number | null;
};

// Kendi taramamızın (ve onun sitemap envanterinin) girdisi olan türler:
// tarama kapalı / kapsam yokken taslaksız değerlendirilir.
export const CRAWLER_KINDS: readonly SearchAlertKind[] = [
  ...SEARCH_ALERT_KIND_NAMES.filter(
    (kind) =>
      SEARCH_ALERT_KINDS[kind].source === "SEO" && kind !== "SEO_CWV_POOR",
  ),
  "GSC_LOST_URLS",
  "GSC_ORPHAN_PAGES",
  "GSC_NEW_PAGES_NOT_INDEXED",
  "GSC_COVERAGE_DROP",
  "GSC_CRAWLED_NOT_INDEXED",
];

const CONNECTION_TITLES: Readonly<
  Record<string, { title: string; detail: string }>
> = {
  AUTH: {
    title: "Reconnect Search Console",
    detail:
      "The Search Console connection needs to be reconnected. Search data stops at the last update.",
  },
  NEEDS_PERMISSION: {
    title: "Agentelse needs permission to read Search Console",
    detail:
      "Reconnect Search Console and tick the box that lets Agentelse read your Search Console data.",
  },
  ACCESS_LOST: {
    title: "Search Console access was lost",
    detail:
      "Your Google account no longer has access to this Search Console property.",
  },
  GONE: {
    title: "The Search Console property no longer exists",
    detail:
      "This Search Console property was removed. Pick another property or add it again in Search Console.",
  },
  API_DISABLED: {
    title: "Search Console access is turned off",
    detail:
      "The Search Console API is turned off for this connection. Reconnect Search Console to turn it back on.",
  },
};

function fresh(at: Date | null, now: Date, maxAgeMs: number): boolean {
  return at !== null && now.getTime() - at.getTime() <= maxAgeMs;
}

function pathList(paths: readonly string[]): string {
  const unique = [...new Set(paths)];
  const shown = unique.slice(0, DETAIL_PATHS).join(", ");
  const more = unique.length - DETAIL_PATHS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function dayLabel(day: string): string {
  return DAY_LABEL.format(new Date(`${day}T00:00:00.000Z`));
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function isServerOrMissing(status: number | null): boolean {
  return status !== null && (status >= 500 || status === 404 || status === 410);
}

function isOk(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

function keyPageError(page: KeyPageCheck): boolean {
  if (isServerOrMissing(page.status)) return true;
  if (page.fetchError === "LOOP" || page.fetchError === "TOO_MANY_REDIRECTS") {
    return true;
  }
  // Ağ hatası ancak art arda iki kontrolde (yanlış alarm olmasın).
  return (
    (page.fetchError === "TIMEOUT" || page.fetchError === "NETWORK") &&
    page.previousFetchError !== null
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

// Kapsam dışı ve aynı kök alan adının altında değilse "başka site".
function canonicalOffsite(canonical: string, scope: CrawlScope): boolean {
  if (!isAbsoluteHttp(canonical)) return false;
  if (inScope(canonical, scope)) return false;
  const host = hostOf(canonical);
  if (!host) return false;
  const root = scope.root.toLowerCase().replace(/^www\./, "");
  return host !== root && !host.endsWith(`.${root}`);
}

class Collector {
  readonly drafts: SeoAlertDraft[] = [];
  readonly evaluated = new Set<SearchAlertKind>();

  mark(...kinds: SearchAlertKind[]): void {
    for (const kind of kinds) this.evaluated.add(kind);
  }

  add(
    kind: SearchAlertKind,
    severity: SeoAlertDraft["severity"],
    title: string,
    detail: string | null,
    data?: SeoAlertDraft["data"],
  ): void {
    this.evaluated.add(kind);
    this.drafts.push({
      source: SEARCH_ALERT_KINDS[kind].source,
      kind,
      severity,
      dedupeKey: searchDedupeKey(kind),
      title,
      detail,
      ...(data ? { data } : {}),
    });
  }
}

// Kilit sayfa kuralı: koşulu taşıyan bayat bir kontrol varsa tür
// değerlendirilmez (uyarı açık kalır); taze kontrol yoksa da değerlendirilmez.
function keyPageRule(
  out: Collector,
  kind: SearchAlertKind,
  pages: readonly KeyPageCheck[],
  now: Date,
  matches: (page: KeyPageCheck) => boolean,
  draft: (hits: KeyPageCheck[]) => void,
): void {
  const isFresh = (page: KeyPageCheck) =>
    fresh(page.checkedAt, now, KEY_CHECK_FRESH_MS);
  const freshPages = pages.filter(isFresh);
  const staleHit = pages.some((page) => !isFresh(page) && matches(page));
  const hits = freshPages.filter(matches);
  if (hits.length > 0) {
    draft(hits);
    return;
  }
  if (freshPages.length > 0 && !staleHit) out.mark(kind);
}

function evaluateKeyPages(
  out: Collector,
  input: SearchHealthInput,
  pages: readonly KeyPageCheck[],
): void {
  const now = input.now;

  // SH3 kilit sayfada noindex
  keyPageRule(
    out,
    "SEO_KEY_PAGE_NOINDEX",
    pages,
    now,
    (page) => isOk(page.status) && (page.noindexMeta || page.noindexHeader),
    (hits) => {
      const home = hits.some((page) => page.isHomepage);
      const parts = hits.map(
        (page) =>
          `${page.path} (${
            page.noindexHeader && !page.noindexMeta
              ? "X-Robots-Tag header"
              : page.noindexHeader
                ? "meta tag and X-Robots-Tag header"
                : "meta tag"
          })`,
      );
      out.add(
        "SEO_KEY_PAGE_NOINDEX",
        "CRITICAL",
        home
          ? "Your homepage is set to noindex"
          : "A key page is set to noindex",
        `Search engines are told not to index: ${pathList(parts)}.`,
        { paths: hits.slice(0, DETAIL_PATHS).map((page) => page.path) },
      );
    },
  );

  // SH5 kilit sayfa açılmıyor
  keyPageRule(out, "SEO_KEY_PAGE_ERROR", pages, now, keyPageError, (hits) => {
    const describe = (page: KeyPageCheck) => {
      if (page.fetchError === "LOOP") return `${page.path} (redirect loop)`;
      if (page.fetchError === "TOO_MANY_REDIRECTS") {
        return `${page.path} (too many redirects)`;
      }
      if (page.fetchError === "TIMEOUT") return `${page.path} (timed out)`;
      if (page.fetchError === "NETWORK") return `${page.path} (no response)`;
      return `${page.path} (status ${page.status ?? "unknown"})`;
    };
    const home = hits.some((page) => page.isHomepage);
    out.add(
      "SEO_KEY_PAGE_ERROR",
      "CRITICAL",
      home ? "Your homepage is not loading" : "A key page is not loading",
      `These key pages failed when we checked them: ${pathList(hits.map(describe))}.`,
      { paths: hits.slice(0, DETAIL_PATHS).map((page) => page.path) },
    );
  });

  // SH6 (SEO) başka siteye işaret eden canonical
  const scope = input.scope;
  if (scope) {
    keyPageRule(
      out,
      "SEO_CANONICAL_OFFSITE",
      pages,
      now,
      (page) =>
        isOk(page.status) &&
        page.canonical !== null &&
        canonicalOffsite(page.canonical, scope),
      (hits) => {
        out.add(
          "SEO_CANONICAL_OFFSITE",
          "CRITICAL",
          "A key page points search engines to another website",
          `The canonical tag of ${pathList(hits.map((page) => page.path))} points to a page on another website.`,
          { paths: hits.slice(0, DETAIL_PATHS).map((page) => page.path) },
        );
      },
    );
  }

  // SH14 (SEO) yapılandırılmış veri hataları
  keyPageRule(
    out,
    "SEO_STRUCTURED_DATA",
    pages,
    now,
    (page) => isOk(page.status) && page.schemaErrors > 0,
    (hits) => {
      out.add(
        "SEO_STRUCTURED_DATA",
        "WARN",
        "Structured data on a key page has errors",
        `Structured data errors on ${pathList(hits.map((page) => page.path))}.`,
      );
    },
  );

  // SH22 render riski
  keyPageRule(
    out,
    "SEO_RENDER_RISK",
    pages,
    now,
    (page) => isOk(page.status) && page.renderRisk,
    (hits) => {
      out.add(
        "SEO_RENDER_RISK",
        "WARN",
        "A key page may show little content to search engines",
        `${pathList(hits.map((page) => page.path))} has very little text in its HTML and relies on JavaScript.`,
      );
    },
  );
}

function evaluateRobots(
  out: Collector,
  input: SearchHealthInput,
  keyPages: readonly KeyPageCheck[] | null,
): void {
  const robots = input.robots;
  if (!robots || !fresh(robots.fetchedAt, input.now, ROBOTS_FRESH_MS)) return;
  const verdict = robots.verdict;

  if (verdict === "SERVER_ERROR" || verdict === "UNREACHABLE") {
    // Tarayıcı hatayı ancak tur içi yeniden deneme de başarısızsa sayar.
    if (robots.failures >= 1) {
      out.add(
        "SEO_ROBOTS_ERROR",
        "CRITICAL",
        "robots.txt is returning server errors",
        verdict === "UNREACHABLE"
          ? "Your robots.txt file could not be reached twice in a row. Google may stop crawling your site until it loads again."
          : "Your robots.txt file answered with a server error twice in a row. Google may stop crawling your site until it loads again.",
      );
    } else {
      out.mark("SEO_ROBOTS_ERROR");
    }
    // Dosyanın içeriği bilinmiyor: engel türleri açık kalır.
    return;
  }

  out.mark("SEO_ROBOTS_ERROR");
  if (verdict !== "OK") {
    // MISSING (4xx) her şeye izin verir; hiç uyarı yok.
    out.mark(
      "SEO_ROBOTS_BLOCK",
      "SEO_ROBOTS_ASSETS",
      "SEO_AI_CRAWLERS_BLOCKED",
    );
    return;
  }

  const parsed: ParsedRobots = parseRobotsTxt(robots.body ?? "");

  // SH4 engel: Googlebot için "/" ya da bir kilit sayfa; ya da "*" grubunun
  // kendisi "/"yu engelliyor (diğer arama motorları).
  const googleRoot = !isAllowed(parsed, "Googlebot", "/").allowed;
  const blockedKeyPaths = (keyPages ?? [])
    .filter((page) => !isAllowed(parsed, "Googlebot", page.path).allowed)
    .map((page) => page.path);
  const othersRoot = !isAllowedInGroup(starGroup(parsed), "/").allowed;
  if (googleRoot || blockedKeyPaths.length > 0 || othersRoot) {
    const reasons: string[] = [];
    if (googleRoot) reasons.push("Google is blocked from your whole site.");
    else if (blockedKeyPaths.length > 0) {
      reasons.push(
        `Google is blocked from key pages: ${pathList(blockedKeyPaths)}.`,
      );
    }
    if (othersRoot) {
      reasons.push(
        "Other search engines are blocked (rules for all crawlers).",
      );
    }
    out.add(
      "SEO_ROBOTS_BLOCK",
      "CRITICAL",
      "robots.txt is blocking search engines",
      reasons.join(" "),
    );
  } else if (keyPages !== null) {
    out.mark("SEO_ROBOTS_BLOCK");
  }

  // SH4 varlıklar: sitemap ya da ana sayfa CSS/JS
  const sitemapUrls = (input.sitemaps?.summaries ?? []).map((row) => row.url);
  const blockedAssets = [...sitemapUrls, ...input.homepageAssets].filter(
    (url) => !isAllowed(parsed, "Googlebot", url).allowed,
  );
  if (blockedAssets.length > 0) {
    out.add(
      "SEO_ROBOTS_ASSETS",
      "WARN",
      "robots.txt is blocking files search engines need",
      `Google cannot fetch: ${pathList(blockedAssets.map((url) => pathOf(url)))}.`,
    );
  } else {
    out.mark("SEO_ROBOTS_ASSETS");
  }

  // SH26 AI arama tarayıcıları
  const blockedAi = aiCrawlerAccess(parsed).filter(
    (row) => row.purpose === "search" && !row.allowed,
  );
  if (blockedAi.length > 0) {
    out.add(
      "SEO_AI_CRAWLERS_BLOCKED",
      "INFO",
      "AI search crawlers are blocked",
      `robots.txt blocks ${blockedAi
        .map((row) => `${row.token} (${row.owner})`)
        .join(", ")}, so your pages may not appear in AI search answers.`,
    );
  } else {
    out.mark("SEO_AI_CRAWLERS_BLOCKED");
  }
}

function sitemapSummaryOk(row: SitemapSummaryLike): boolean {
  return (
    isOk(row.status) &&
    (row.kind === "urlset" ||
      row.kind === "sitemapindex" ||
      row.kind === "text")
  );
}

function evaluateOwnSitemaps(out: Collector, input: SearchHealthInput): void {
  const sitemaps = input.sitemaps;
  if (!sitemaps || !fresh(sitemaps.checkedAt, input.now, SITEMAPS_FRESH_MS)) {
    return;
  }
  // SH11 (SEO) okunabilen sitemap yok
  if (!sitemaps.summaries.some(sitemapSummaryOk)) {
    out.add(
      "SEO_SITEMAP_MISSING",
      "WARN",
      sitemaps.summaries.length === 0
        ? "No sitemap found"
        : "Your sitemap could not be read",
      sitemaps.summaries.length === 0
        ? "We found no sitemap in robots.txt or at the usual address."
        : `None of these sitemaps could be read: ${pathList(sitemaps.summaries.map((row) => pathOf(row.url)))}.`,
    );
  } else {
    out.mark("SEO_SITEMAP_MISSING");
  }
}

function count(
  counts: Partial<Record<TaCode, number>>,
  ...codes: TaCode[]
): number {
  return codes.reduce((sum, code) => sum + (counts[code] ?? 0), 0);
}

function evaluateCrawl(out: Collector, input: SearchHealthInput): void {
  const issues = input.issues;
  if (!issues || !fresh(input.lastFullCrawlAt, input.now, CRAWL_FRESH_MS)) {
    return;
  }
  const counts = issues.counts;

  // SH12 sitemap temizliği
  const badShare =
    issues.sitemapCrawled > 0 ? issues.sitemapBad / issues.sitemapCrawled : 0;
  if (issues.sitemapCrawled >= 20 && badShare > 0.05) {
    out.add(
      "SEO_SITEMAP_HYGIENE",
      "WARN",
      "The sitemap lists pages that should not be there",
      `${issues.sitemapBad} of ${issues.sitemapCrawled} sitemap pages we checked redirect, fail or are not indexable.`,
    );
  } else {
    out.mark("SEO_SITEMAP_HYGIENE");
  }

  // SH16 HTTPS
  const mixed = count(counts, "TA19");
  const httpsReasons: string[] = [];
  if (issues.httpPages > 0) {
    httpsReasons.push(
      `${issues.httpPages} pages load over http without redirecting.`,
    );
  }
  if (input.httpRedirectsToHttps === false) {
    httpsReasons.push(
      "The http version of your homepage does not redirect to https.",
    );
  }
  if (mixed > 0) {
    httpsReasons.push(`${mixed} pages load images or scripts over http.`);
  }
  if (httpsReasons.length > 0) {
    out.add(
      "SEO_HTTPS",
      "WARN",
      "Some pages are not fully secure",
      httpsReasons.join(" "),
    );
  } else {
    out.mark("SEO_HTTPS");
  }

  // SH17 yönlendirme zincirleri (iç linki olan)
  if (issues.redirectChainsLinked > 0) {
    out.add(
      "SEO_REDIRECT_CHAINS",
      "WARN",
      "Internal links go through redirect chains",
      `${issues.redirectChainsLinked} linked pages redirect more than twice or in a loop.`,
    );
  } else {
    out.mark("SEO_REDIRECT_CHAINS");
  }

  // SH18 kırık iç linkler
  const broken = count(counts, "TA12");
  if (broken > 0) {
    out.add(
      "SEO_BROKEN_LINKS",
      "WARN",
      "The site has broken internal links",
      `${broken} pages link to pages that are missing or failing.`,
    );
  } else {
    out.mark("SEO_BROKEN_LINKS");
  }

  // SH20 başlık ve açıklamalar
  const titles = count(counts, "TA1", "TA2", "TA3", "TA4", "TA5");
  if (titles > 0) {
    out.add(
      "SEO_TITLES_META",
      "INFO",
      "Titles or descriptions need work",
      `${titles} title or description issues across your pages.`,
    );
  } else {
    out.mark("SEO_TITLES_META");
  }

  // SH21 hreflang
  const hreflang = count(counts, "TA20");
  if (hreflang > 0) {
    out.add(
      "SEO_HREFLANG",
      "WARN",
      "Language versions are set up incorrectly",
      `${hreflang} pages have hreflang problems.`,
    );
  } else {
    out.mark("SEO_HREFLANG");
  }

  // SH19 (SEO) yalnız eksiksiz (DONE) tam taramadan sonra
  if (input.lastFull?.status === "DONE") {
    const orphans = count(counts, "TA13");
    if (orphans > 0) {
      out.add(
        "SEO_ORPHAN_PAGES",
        "INFO",
        "Some pages have no internal links",
        `${orphans} indexable pages are not linked from any page we crawled.`,
      );
    } else {
      out.mark("SEO_ORPHAN_PAGES");
    }
  }

  // SH27 (SEO) site taşıması
  const full = input.lastFull;
  if (full && (full.status === "DONE" || full.status === "PARTIAL")) {
    const migration =
      full.newUrls >= 20 &&
      full.newUrls >= 0.3 * full.pagesFetched &&
      full.knownRefetched > 0 &&
      full.knownNowRedirect >= 0.2 * full.knownRefetched;
    if (migration) {
      out.add(
        "SEO_SITE_MIGRATION",
        "WARN",
        "Many page addresses changed",
        `The last crawl found ${full.newUrls} new addresses and ${full.knownNowRedirect} known pages that now redirect.`,
      );
    } else {
      out.mark("SEO_SITE_MIGRATION");
    }
  }
}

function evaluateCwv(out: Collector, input: SearchHealthInput): void {
  const cwv = input.cwv;
  if (!cwv) return;
  if (!cwv.enabled) {
    out.mark("SEO_CWV_POOR");
    return;
  }
  if (!fresh(cwv.checkedAt, input.now, CWV_FRESH_MS)) return;
  if (!cwv.hasOrigin) {
    out.mark("SEO_CWV_POOR");
    return;
  }
  // SH15
  if (cwv.overall === "poor" || cwv.worsened) {
    out.add(
      "SEO_CWV_POOR",
      "WARN",
      cwv.overall === "poor"
        ? "Page speed for real visitors is poor"
        : "Page speed for real visitors got worse",
      cwv.overall === "poor"
        ? "Chrome users rate your site's loading, responsiveness or layout stability as poor."
        : "Core Web Vitals from Chrome users got worse over the last weeks.",
    );
  } else if (cwv.overall === "needs-improvement") {
    out.add(
      "SEO_CWV_POOR",
      "INFO",
      "Page speed for real visitors needs improvement",
      "Chrome users rate your site's Core Web Vitals as needing improvement.",
    );
  } else {
    out.mark("SEO_CWV_POOR");
  }
}

function overlappingUpdate(
  updates: readonly SearchUpdateLike[],
  from: string,
  to: string,
  now: Date,
): SearchUpdateLike | null {
  const start = dayStart(from).getTime();
  const end = dayStart(addDays(to, 1)).getTime();
  return (
    updates.find((update) => {
      const updateEnd = (update.endedAt ?? now).getTime();
      return update.startedAt.getTime() < end && updateEnd >= start;
    }) ?? null
  );
}

function evaluateGsc(
  out: Collector,
  input: SearchHealthInput,
  gsc: NonNullable<SearchHealthInput["gsc"]>,
): void {
  const now = input.now;
  const link = gsc.link;
  const staleFinal =
    link.lastFinalDate === null ||
    link.lastFinalDate < addDays(gsc.today, -STALE_FINAL_DAYS);

  // SH1 senkron bayat
  const linkOld = now.getTime() - link.createdAt.getTime() > LINK_GRACE_MS;
  const failing =
    link.consecutiveFailures >= 3 &&
    (link.lastDailyAt === null ||
      link.lastDailyAt.getTime() < now.getTime() - DAILY_STALE_MS);
  if (linkOld && (staleFinal || failing)) {
    out.add(
      "GSC_SYNC_STALE",
      "WARN",
      "Search Console data stopped updating",
      link.lastFinalDate
        ? `The latest complete day from Search Console is ${dayLabel(link.lastFinalDate)}.`
        : "No complete day has arrived from Search Console yet.",
    );
  } else {
    out.mark("GSC_SYNC_STALE");
  }

  // SH2 + SH23 düşüş (yalnız taze veriyle)
  if (gsc.days && !staleFinal && gsc.updates) {
    const verdict = dropVerdict(gsc.days);
    if (verdict) {
      const metric =
        verdict.metric === "nonBrand" ? "Non-brand clicks" : "Clicks";
      const update = overlappingUpdate(
        gsc.updates,
        addDays(verdict.days[0], -7),
        verdict.days[1],
        now,
      );
      const detail = [
        `${metric} from Google were at most ${percent(verdict.ratio)} of the usual level on ${dayLabel(verdict.days[0])} and ${dayLabel(verdict.days[1])} (usually about ${Math.round(verdict.baseline)} a day).`,
        ...(update ? [`Started during the ${update.name} rollout.`] : []),
      ].join(" ");
      out.add(
        "GSC_SEARCH_DROP",
        verdict.severity,
        verdict.severity === "CRITICAL"
          ? "Clicks from Google dropped sharply"
          : "Clicks from Google dropped",
        detail,
        {
          metric: verdict.metric,
          ratio: Math.round(verdict.ratio * 1000) / 1000,
          from: verdict.days[0],
          to: verdict.days[1],
        },
      );
      if (update) {
        out.add(
          "GSC_UPDATE_OVERLAP",
          "INFO",
          "A Google update overlaps the drop in clicks",
          `The ${update.name} rollout overlaps the drop that started on ${dayLabel(verdict.days[0])}.`,
        );
      } else {
        out.mark("GSC_UPDATE_OVERLAP");
      }
    } else {
      out.mark("GSC_SEARCH_DROP", "GSC_UPDATE_OVERLAP");
    }
  }

  // SH24 mülk alan adıyla uyuşmuyor
  if (link.domainMatch === false) {
    out.add(
      "GSC_SITE_MISMATCH",
      "WARN",
      "The Search Console property does not match your domain",
      "The selected Search Console property does not cover your project's domain.",
    );
  } else {
    out.mark("GSC_SITE_MISMATCH");
  }

  // SH25 bağlantı sağlığı
  const connection = CONNECTION_TITLES[link.health];
  if (connection) {
    out.add("GSC_CONNECTION", "WARN", connection.title, connection.detail);
  } else {
    out.mark("GSC_CONNECTION");
  }

  // SH7, SH6 (GSC), SH13, SH14 (GSC): kilit sayfaların URL Inspection sonuçları
  const pages = input.keyPages;
  if (pages) {
    const inspected = pages.filter(
      (page): page is KeyPageCheck & { inspection: KeyPageInspection } =>
        page.inspection !== null,
    );

    const lost = inspected.filter(
      (page) =>
        page.inspection.previousVerdict === "PASS" &&
        (page.inspection.verdict === "FAIL" ||
          page.inspection.verdict === "NEUTRAL"),
    );
    if (lost.length > 0) {
      out.add(
        "GSC_INDEX_LOST",
        "CRITICAL",
        lost.some((page) => page.isHomepage)
          ? "Your homepage dropped out of Google's index"
          : "A key page dropped out of Google's index",
        `Google no longer indexes: ${pathList(lost.map((page) => page.path))}.`,
      );
    } else {
      out.mark("GSC_INDEX_LOST");
    }

    const mismatched = inspected.filter((page) => {
      const google = page.inspection.googleCanonical;
      const user = page.inspection.userCanonical;
      if (!google || !user) return false;
      return (
        (normalizeCrawlUrl(google) ?? google) !==
        (normalizeCrawlUrl(user) ?? user)
      );
    });
    if (mismatched.length > 0) {
      out.add(
        "GSC_CANONICAL_MISMATCH",
        "WARN",
        "Google picked a different canonical page",
        `Google chose another page as canonical for: ${pathList(mismatched.map((page) => page.path))}.`,
      );
    } else {
      out.mark("GSC_CANONICAL_MISMATCH");
    }

    const staleCrawl = inspected.filter(
      (page) =>
        page.inspection.lastCrawlTime !== null &&
        now.getTime() - page.inspection.lastCrawlTime.getTime() >
          STALE_CRAWL_MS,
    );
    if (staleCrawl.length > 0) {
      out.add(
        "GSC_STALE_CRAWL",
        "INFO",
        "Google has not crawled a key page for a long time",
        `Google last crawled these key pages more than two months ago: ${pathList(staleCrawl.map((page) => page.path))}.`,
      );
    } else {
      out.mark("GSC_STALE_CRAWL");
    }

    const rich = inspected.filter(
      (page) => page.inspection.richResultErrors > 0,
    );
    if (rich.length > 0) {
      out.add(
        "GSC_RICH_RESULTS",
        "WARN",
        "Google found rich result errors",
        `Rich result errors on: ${pathList(rich.map((page) => page.path))}.`,
      );
    } else {
      out.mark("GSC_RICH_RESULTS");
    }
  }

  // GSC sitemap görünümü (SH11 GSC)
  const gscSitemaps = gsc.sitemaps;
  if (gscSitemaps && fresh(gscSitemaps.checkedAt, now, SITEMAPS_FRESH_MS)) {
    const problems = gscSitemaps.rows.filter(
      (row) =>
        row.errors > 0 ||
        (row.isPending &&
          row.lastSubmitted !== null &&
          now.getTime() - row.lastSubmitted.getTime() > SITEMAP_PENDING_MS) ||
        (row.lastDownloaded !== null &&
          now.getTime() - row.lastDownloaded.getTime() > SITEMAP_DOWNLOAD_MS),
    );
    if (problems.length > 0) {
      out.add(
        "GSC_SITEMAP_ERRORS",
        "WARN",
        "Search Console reports sitemap problems",
        `Search Console reports errors, a long pending status or an old download for: ${pathList(problems.map((row) => pathOf(row.path)))}.`,
      );
    } else {
      out.mark("GSC_SITEMAP_ERRORS");
    }
  }

  // Tarayıcı envanterine dayanan GSC türleri: tarama kapalıyken üstte
  // taslaksız değerlendirilir.
  if (!input.crawlEnabled) return;

  // SH8 yeni sayfalar indekslenmiyor
  const fresher = gsc.newSitemapUrls;
  if (fresher) {
    const share =
      fresher.inspected > 0 ? fresher.notIndexed / fresher.inspected : 0;
    if (fresher.inspected >= 5 && share > 0.3) {
      out.add(
        "GSC_NEW_PAGES_NOT_INDEXED",
        "WARN",
        "New pages are not getting indexed",
        `${fresher.notIndexed} of ${fresher.inspected} pages added to your sitemap two to six weeks ago are not indexed.`,
      );
    } else {
      out.mark("GSC_NEW_PAGES_NOT_INDEXED");
    }
  }

  // SH9 ve SH10 kapsam
  const coverage = gsc.coverage;
  if (coverage) {
    const current = coverage.current;
    if (
      current &&
      current.sampled >= 20 &&
      (current.point < 0.7 || coverage.dropped)
    ) {
      out.add(
        "GSC_COVERAGE_DROP",
        "WARN",
        coverage.dropped
          ? "Fewer of your sitemap pages are indexed"
          : "Many sitemap pages are not indexed",
        `About ${percent(current.point)} of the sitemap pages we sampled are indexed.`,
      );
    } else {
      out.mark("GSC_COVERAGE_DROP");
    }

    const earlier = coverage.earlier;
    if (current && earlier && current.sampled >= 20 && earlier.sampled >= 20) {
      const share = current.crawledNotIndexed / current.sampled;
      const before = earlier.crawledNotIndexed / earlier.sampled;
      if (share >= 0.1 && share >= 2 * before) {
        out.add(
          "GSC_CRAWLED_NOT_INDEXED",
          "WARN",
          "Google crawls more pages without indexing them",
          `About ${percent(share)} of sampled pages are crawled but not indexed, up from ${percent(before)} four weeks earlier.`,
        );
      } else {
        out.mark("GSC_CRAWLED_NOT_INDEXED");
      }
    } else if (current) {
      out.mark("GSC_CRAWLED_NOT_INDEXED");
    }
  }

  const crawlFresh = fresh(input.lastFullCrawlAt, now, CRAWL_FRESH_MS);

  // SH19 (GSC) tık alan ama iç linki olmayan sayfalar
  if (crawlFresh && input.lastFull?.status === "DONE" && gsc.orphanPaths) {
    if (gsc.orphanPaths.length > 0) {
      out.add(
        "GSC_ORPHAN_PAGES",
        "INFO",
        "Pages that get search clicks have no internal links",
        `Pages that get clicks from Google but are not linked from your site: ${pathList(gsc.orphanPaths)}.`,
      );
    } else {
      out.mark("GSC_ORPHAN_PAGES");
    }
  }

  // SH27 (GSC) kaybolan URL'ler ve 301 haritası
  const lost = gsc.lostUrls;
  if (crawlFresh && lost) {
    if (lost.rows.length > 0) {
      const critical =
        lost.rows.some((row) => row.keyPage) ||
        (lost.lostClicksShare ?? 0) > 0.1;
      out.add(
        "GSC_LOST_URLS",
        critical ? "CRITICAL" : "WARN",
        "Pages that used to get clicks are lost",
        `${lost.rows.length} pages that got clicks from Google now fail, redirect to an unrelated page or are set to noindex: ${pathList(lost.rows.map((row) => row.fromPath))}. Open the redirect map to fix them.`,
      );
    } else {
      out.mark("GSC_LOST_URLS");
    }
  }
}

function emptyEvaluated(): Record<SearchAlertSource, SearchAlertKind[]> {
  return { GSC: [], SEO: [] };
}

function bySource(
  kinds: ReadonlySet<SearchAlertKind>,
): Record<SearchAlertSource, SearchAlertKind[]> {
  const result = emptyEvaluated();
  for (const kind of SEARCH_ALERT_KIND_NAMES) {
    if (kinds.has(kind)) result[SEARCH_ALERT_KINDS[kind].source].push(kind);
  }
  return result;
}

const NO_PARTS: Record<ScorePartKey, boolean> = {
  indexing: false,
  technical: false,
  sitemap_robots: false,
  cwv: false,
  data: false,
};

export function evaluateSearchHealth(
  input: SearchHealthInput,
): SearchHealthEvaluation {
  // Durdurulan proje: her şey taslaksız değerlendirilir (hepsi kapanır).
  if (input.projectStatus === "PAUSED" || input.projectStatus === "CLOSED") {
    return {
      drafts: [],
      evaluated: {
        GSC: kindsForSource("GSC"),
        SEO: kindsForSource("SEO"),
      },
      available: { ...NO_PARTS },
      technicalCleanShare: null,
      coveragePoint: null,
    };
  }

  const out = new Collector();
  const crawlOn = input.crawlEnabled && input.scope !== null;

  if (!crawlOn) {
    out.mark(...CRAWLER_KINDS);
  } else {
    if (input.keyPages) evaluateKeyPages(out, input, input.keyPages);
    evaluateRobots(out, input, input.keyPages);
    evaluateOwnSitemaps(out, input);
    evaluateCrawl(out, input);
    // CRAWL: sitemiz taramamızı engelliyor
    if (input.crawlBlocked) {
      out.add(
        "SEO_CRAWL_BLOCKED",
        "INFO",
        "The site is blocking our site audit",
        "Your site refused or throttled our site audit, so the weekly crawl is paused. Key pages are still checked every few hours.",
      );
    } else {
      out.mark("SEO_CRAWL_BLOCKED");
    }
  }

  // CWV de kapsama bağlı (köken adresi SeoSite'tan gelir).
  if (input.scope === null) {
    out.mark("SEO_CWV_POOR");
  } else {
    evaluateCwv(out, input);
  }

  if (input.gsc === null) {
    out.mark(...kindsForSource("GSC"));
  } else {
    evaluateGsc(out, { ...input, crawlEnabled: crawlOn }, input.gsc);
  }

  const gsc = input.gsc;
  const coverageCurrent = gsc?.coverage?.current ?? null;
  // Kapsam tahmini tarayıcının sitemap envanterine dayanır.
  const coveragePoint =
    crawlOn && coverageCurrent && coverageCurrent.sampled >= 20
      ? coverageCurrent.point
      : null;
  const keyInspected = (input.keyPages ?? []).some(
    (page) => page.inspection !== null,
  );
  const available: Record<ScorePartKey, boolean> = {
    indexing: gsc !== null && (coveragePoint !== null || keyInspected),
    technical:
      crawlOn &&
      (input.lastFullCrawlAt !== null || input.lastRegressionAt !== null),
    sitemap_robots: crawlOn && (input.robots?.fetchedAt ?? null) !== null,
    cwv: (input.cwv?.enabled ?? false) && (input.cwv?.hasOrigin ?? false),
    data: gsc !== null,
  };

  return {
    drafts: out.drafts,
    evaluated: bySource(out.evaluated),
    available,
    technicalCleanShare: crawlOn ? input.technicalCleanShare : null,
    coveragePoint,
  };
}
