import { normalizeCrawlUrl, pathOf } from "@/lib/seo/crawl-url";
import type { PageFacts } from "@/lib/seo/html-audit";
import { textTokens, tokenSimilarity } from "@/lib/seo/redirect-map";

import { PROPOSAL_LIMITS } from "./types";
import type {
  PageSnapshot,
  SeoActionProposal,
  SeoVerification,
  VerificationCheck,
} from "./types";

// Eylem doğrulama denetimleri (docs/google-search-console-plan.md SC-F6):
// kendi tarayıcı yığınımızın gördüğü sayfa, kullanıcının söylediği değişiklikle
// uyuşuyor mu. Saf; ağ ve veritabanı yok. crawl-url (node:crypto) içe
// aktardığı için yalnız sunucu tarafında kullanılır; istemci bileşenleri
// bunu içe aktarmaz.

const TITLE_SIMILARITY_MIN = 0.85;
const WORDS_CHANGED_MIN = 0.15;
const CRUX_HOLD_MS = 7 * 86_400_000;
const LINKS_MAX = 1_000;

// Gözlenen sayfa: PageSnapshot + yönlendirme/hata bilgisi. links yalnız bellekte
// kalır, hiçbir yere yazılmaz.
export type ObservedPage = PageSnapshot & {
  finalUrl: string;
  // Yönlendirme adımı sayısı (SiteFetchResult.hops.length - 1, en az 0).
  hops: number;
  fetchError: string | null;
  robotsBlocked: boolean;
  links: string[];
};

export function observedFromFacts(input: {
  url: string;
  finalUrl: string;
  status: number | null;
  hops: number;
  facts: PageFacts | null;
  headerNoindex: boolean;
  fetchError: string | null;
  robotsBlocked: boolean;
  fetchedAt: Date;
}): ObservedPage {
  const { facts, finalUrl, status } = input;
  const canonical = facts?.canonicalResolved ?? null;
  const noindex = Boolean(facts?.noindex) || input.headerNoindex;
  const links: string[] = [];
  const seen = new Set<string>();
  for (const link of facts?.links ?? []) {
    const url = normalizeCrawlUrl(link.href, finalUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push(url);
    if (links.length >= LINKS_MAX) break;
  }
  return {
    url: input.url,
    status,
    title: facts?.title ?? null,
    metaDescription: facts?.metaDescription ?? null,
    h1: facts?.h1[0] ?? null,
    h2: (facts?.h2 ?? []).slice(0, PROPOSAL_LIMITS.h2),
    canonical,
    noindex,
    indexable: facts
      ? status === 200 &&
        !noindex &&
        (canonical === null || sameUrl(canonical, finalUrl))
      : null,
    wordCount: facts?.wordCount ?? null,
    textHash: facts?.textHash ?? null,
    schemaTypes: facts?.jsonLd.types ?? [],
    schemaErrors: facts?.jsonLd.errors.length ?? 0,
    fetchedAt: input.fetchedAt.toISOString(),
    source: "FETCH",
    finalUrl,
    hops: input.hops,
    fetchError: input.fetchError,
    robotsBlocked: input.robotsBlocked,
    links,
  };
}

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// İki metin de null ise eşit; yalnız biri null ise değil.
export function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return fold(a) === fold(b);
}

export function sameUrl(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = normalizeCrawlUrl(a);
  const right = normalizeCrawlUrl(b);
  return left !== null && left === right;
}

// Sondaki eğik çizgi farkını yok sayan karşılaştırma (bağlantı varlığı için).
function looseKey(url: string | null): string | null {
  if (url === null) return null;
  const normalized = normalizeCrawlUrl(url);
  if (normalized === null) return null;
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

export function textSimilarity(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0;
  return tokenSimilarity(textTokens(a), textTokens(b));
}

// P2'nin SeoPage'den hesapladığı tarayıcı değişim bayrakları.
export type CrawledChange = { titleChanged: boolean; contentChanged: boolean };

export type VerifyOutcome = {
  verified: boolean;
  checks: VerificationCheck[];
  fetchFailed: boolean;
  reason: SeoVerification["reason"];
};

function observedText(value: string | null): string | null {
  if (value === null) return null;
  return value.length > PROPOSAL_LIMITS.observed
    ? value.slice(0, PROPOSAL_LIMITS.observed)
    : value;
}

function check(
  key: string,
  label: string,
  ok: boolean,
  observed: string | null = null,
): VerificationCheck {
  return { key, label, ok, observed: observedText(observed) };
}

function fetchedOk(observed: ObservedPage | null): boolean {
  return (
    observed !== null &&
    observed.fetchError === null &&
    !observed.robotsBlocked &&
    observed.status === 200
  );
}

function unreachable(observed: ObservedPage | null): VerifyOutcome {
  const robots = observed?.robotsBlocked === true;
  return {
    verified: false,
    checks: [
      check(
        "page_loads",
        "Your page loads",
        false,
        observed
          ? (observed.fetchError ?? (observed.status ? `HTTP ${observed.status}` : null))
          : null,
      ),
    ],
    fetchFailed: !robots,
    reason: robots ? "ROBOTS" : "FETCH_FAILED",
  };
}

function outcome(checks: VerificationCheck[]): VerifyOutcome {
  return {
    verified: checks.length > 0 && checks.every((item) => item.ok),
    checks,
    fetchFailed: false,
    reason: null,
  };
}

function pathLabel(url: string): string {
  return pathOf(url);
}

export function verifyTitleMeta(input: {
  proposal: Extract<SeoActionProposal, { kind: "TITLE_META" }>;
  baseline: PageSnapshot | null;
  observed: ObservedPage | null;
  crawled: CrawledChange;
}): VerifyOutcome {
  const { proposal, baseline, observed, crawled } = input;
  if (!observed || !fetchedOk(observed)) return unreachable(observed);
  const checks: VerificationCheck[] = [check("page_loads", "Your page loads", true)];
  const after = proposal.after;
  if (after?.title) {
    const ok =
      sameText(observed.title, after.title) ||
      textSimilarity(observed.title, after.title) >= TITLE_SIMILARITY_MIN;
    checks.push(check("title_matches", "Title matches the new title", ok, observed.title));
  } else {
    const differs =
      baseline?.title != null &&
      observed.title !== null &&
      !sameText(observed.title, baseline.title);
    checks.push(
      check(
        "title_changed",
        "Title has changed",
        differs || crawled.titleChanged,
        observed.title,
      ),
    );
  }
  const metaChanged =
    after !== null &&
    after.metaDescription !== "" &&
    !sameText(after.metaDescription, proposal.before?.metaDescription ?? null);
  if (after && metaChanged) {
    const ok =
      sameText(observed.metaDescription, after.metaDescription) ||
      textSimilarity(observed.metaDescription, after.metaDescription) >=
        TITLE_SIMILARITY_MIN;
    checks.push(
      check(
        "meta_matches",
        "Meta description matches the new text",
        ok,
        observed.metaDescription,
      ),
    );
  }
  return outcome(checks);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(fold));
  const right = new Set(b.map(fold));
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

export function verifyContentRefresh(input: {
  baseline: PageSnapshot | null;
  observed: ObservedPage | null;
  crawled: CrawledChange;
}): VerifyOutcome {
  const { baseline, observed, crawled } = input;
  if (!observed || !fetchedOk(observed)) return unreachable(observed);
  const live = !observed.noindex;
  const hashChanged =
    baseline?.textHash != null &&
    observed.textHash !== null &&
    baseline.textHash !== observed.textHash;
  const wordsChanged =
    baseline?.wordCount != null &&
    baseline.wordCount > 0 &&
    observed.wordCount !== null &&
    Math.abs(observed.wordCount - baseline.wordCount) / baseline.wordCount >=
      WORDS_CHANGED_MIN;
  const headingsChanged =
    baseline !== null &&
    baseline.h2.length + observed.h2.length > 0 &&
    !sameSet(baseline.h2, observed.h2);
  const changed =
    hashChanged || wordsChanged || headingsChanged || crawled.contentChanged;
  return outcome([
    check("page_loads", "Your page loads", true),
    check("not_noindex", "The page can be indexed", live),
    check(
      "content_changed",
      "The page content has changed",
      changed,
      observed.wordCount === null ? null : `${observed.wordCount} words`,
    ),
  ]);
}

// Yeni/yerelleştirilmiş sayfa yayında mı.
export function verifyLive(input: { observed: ObservedPage | null }): VerifyOutcome {
  const { observed } = input;
  if (!observed || !fetchedOk(observed)) return unreachable(observed);
  return outcome([
    check("page_loads", "Your page loads", true),
    check("not_noindex", "The page can be indexed", !observed.noindex),
  ]);
}

// Bütün fetch'ler başarısızsa (en az bir sayfa) yeniden deneme anlamlıdır.
function allUnreachable(
  urls: readonly string[],
  observedByFrom: ReadonlyMap<string, ObservedPage | null>,
): boolean {
  return (
    urls.length > 0 &&
    urls.every((url) => {
      const observed = observedByFrom.get(url) ?? null;
      return observed === null || observed.fetchError !== null;
    })
  );
}

export function verifyInternalLinks(input: {
  proposal: Extract<SeoActionProposal, { kind: "INTERNAL_LINKS" }>;
  observedByFrom: ReadonlyMap<string, ObservedPage | null>;
}): VerifyOutcome {
  const { proposal, observedByFrom } = input;
  const links = proposal.links;
  const checks = links.map((link, index) => {
    const observed = observedByFrom.get(link.fromUrl) ?? null;
    const target = looseKey(link.toUrl);
    const present =
      fetchedOk(observed) &&
      target !== null &&
      (observed?.links ?? []).some((href) => looseKey(href) === target);
    return check(
      `link_${index + 1}`,
      "The link to the target page is on the page",
      present,
      pathLabel(link.fromUrl),
    );
  });
  const result = outcome(checks);
  const fetchFailed = allUnreachable(
    links.map((link) => link.fromUrl),
    observedByFrom,
  );
  return {
    ...result,
    fetchFailed,
    reason: result.verified ? null : fetchFailed ? "FETCH_FAILED" : "NOT_SEEN",
  };
}

export function verifyConsolidate(input: {
  proposal: Extract<SeoActionProposal, { kind: "CONSOLIDATE" }>;
  observedByFrom: ReadonlyMap<string, ObservedPage | null>;
}): VerifyOutcome {
  const { proposal, observedByFrom } = input;
  const checks = proposal.from.map((from, index) => {
    const observed = observedByFrom.get(from) ?? null;
    const redirected =
      fetchedOk(observed) &&
      observed !== null &&
      !sameUrl(observed.url, observed.finalUrl) &&
      looseKey(observed.finalUrl) === looseKey(proposal.to);
    const canonical =
      fetchedOk(observed) &&
      observed !== null &&
      observed.canonical !== null &&
      looseKey(observed.canonical) === looseKey(proposal.to);
    const ok =
      proposal.method === "REDIRECT"
        ? redirected
        : proposal.method === "CANONICAL"
          ? canonical
          : redirected || canonical;
    return check(
      `merged_${index + 1}`,
      "The page now points to the main page",
      ok,
      pathLabel(from),
    );
  });
  const result = outcome(checks);
  const fetchFailed = allUnreachable(proposal.from, observedByFrom);
  return {
    ...result,
    fetchFailed,
    reason: result.verified ? null : fetchFailed ? "FETCH_FAILED" : "NOT_SEEN",
  };
}

export function verifyTechFix(input: {
  proposal: Extract<SeoActionProposal, { kind: "TECH_FIX" }>;
  observed: ObservedPage | null;
  robotsAllowed: boolean;
}): VerifyOutcome {
  const { proposal, observed, robotsAllowed } = input;
  if (proposal.issue === "ROBOTS") {
    return outcome([
      check("robots_allow", "robots.txt allows crawling this page", robotsAllowed),
    ]);
  }
  if (observed === null || observed.fetchError !== null || observed.robotsBlocked) {
    return unreachable(observed);
  }
  const checks: VerificationCheck[] = [];
  switch (proposal.issue) {
    case "NOINDEX":
      // Sayfa artık 404/410/5xx ise noindex'in kalkması düzelme sayılmaz.
      checks.push(
        check(
          "not_noindex",
          "The page no longer has noindex",
          observed.status === 200 && !observed.noindex,
          observed.status === null ? null : `HTTP ${observed.status}`,
        ),
      );
      break;
    case "STATUS":
      checks.push(
        check(
          "status_ok",
          "The page returns a normal response",
          observed.status === 200,
          observed.status === null ? null : `HTTP ${observed.status}`,
        ),
      );
      break;
    case "CANONICAL":
      checks.push(
        check(
          "canonical_self",
          "The canonical points to this page",
          observed.canonical !== null && sameUrl(observed.canonical, observed.finalUrl),
          observed.canonical,
        ),
      );
      break;
    case "REDIRECT":
      checks.push(
        check(
          "redirect_short",
          "The page redirects at most once",
          // Zincir 404'e varıyorsa kısa olması düzelme sayılmaz.
          observed.hops <= 1 && observed.status === 200,
          `${observed.hops} redirect${observed.hops === 1 ? "" : "s"}${
            observed.status === null || observed.status === 200
              ? ""
              : `, HTTP ${observed.status}`
          }`,
        ),
      );
      break;
    case "HREFLANG":
    case "OTHER":
      checks.push(
        check(
          "page_ok",
          "The page loads and can be indexed",
          observed.status === 200 && observed.indexable !== false,
          observed.status === null ? null : `HTTP ${observed.status}`,
        ),
      );
      break;
  }
  return outcome(checks);
}

export function verifySchema(input: {
  proposal: Extract<SeoActionProposal, { kind: "SCHEMA" }>;
  observed: ObservedPage | null;
}): VerifyOutcome {
  const { proposal, observed } = input;
  if (!observed || !fetchedOk(observed)) return unreachable(observed);
  const present = new Set(observed.schemaTypes.map(fold));
  const hasTypes =
    proposal.types.length > 0
      ? proposal.types.every((type) => present.has(fold(type)))
      : present.size > 0;
  return outcome([
    check("page_loads", "Your page loads", true),
    check(
      "schema_present",
      "Structured data is on the page",
      hasTypes,
      observed.schemaTypes.join(", ") || null,
    ),
    check(
      "schema_clean",
      "Structured data has no errors",
      observed.schemaErrors === 0,
      `${observed.schemaErrors} error${observed.schemaErrors === 1 ? "" : "s"}`,
    ),
  ]);
}

// Uyarı kaynaklı düzeltme: uyarı uygulamadan sonra çözülmüş olmalı.
export function verifyAlertResolved(input: {
  alert: { status: string; resolvedAt: Date | null } | null;
  appliedAt: Date;
}): VerifyOutcome {
  const { alert, appliedAt } = input;
  const ok =
    alert !== null &&
    alert.status === "RESOLVED" &&
    alert.resolvedAt !== null &&
    alert.resolvedAt.getTime() >= appliedAt.getTime();
  return outcome([
    check("alert_resolved", "The issue is no longer reported", ok, alert?.status ?? null),
  ]);
}

// CrUX 28 günlük kayan p75'tir; değişiklikten en az 7 gün sonra biten bir
// dönem varsa ölçüm başlayabilir.
export function verifyCruxData(input: {
  latestPeriodEnd: Date | null;
  appliedAt: Date;
}): VerifyOutcome {
  const { latestPeriodEnd, appliedAt } = input;
  const ok =
    latestPeriodEnd !== null &&
    latestPeriodEnd.getTime() >= appliedAt.getTime() + CRUX_HOLD_MS;
  return outcome([
    check("crux_fresh", "Field data now covers a week after the change", ok),
  ]);
}

export function verifySitemaps(input: {
  ownOk: boolean | null;
  checkedAt: Date | null;
  appliedAt: Date;
  gsc: { errors: number; lastDownloaded: Date | null }[] | null;
}): VerifyOutcome {
  const { ownOk, checkedAt, appliedAt, gsc } = input;
  const checks: VerificationCheck[] = [
    check(
      "sitemap_clean",
      "Your sitemap checks out",
      ownOk === true &&
        checkedAt !== null &&
        checkedAt.getTime() >= appliedAt.getTime(),
    ),
  ];
  // GSC hatası yalnız değişiklikten sonra indirilmiş site haritasında sayılır.
  const stale = (gsc ?? []).filter(
    (sitemap) =>
      sitemap.errors > 0 &&
      sitemap.lastDownloaded !== null &&
      sitemap.lastDownloaded.getTime() >= appliedAt.getTime(),
  );
  if (gsc !== null && gsc.length > 0) {
    checks.push(
      check(
        "sitemap_no_errors",
        "Google reports no sitemap errors",
        stale.length === 0,
      ),
    );
  }
  return outcome(checks);
}

// Google, değişiklikten sonra sayfayı taradı mı?
export function googleStageOf(input: {
  inspection: { lastCrawlTime: Date | null; verdict: string | null } | null;
  appliedAt: Date;
}): "seen" | "pending" {
  const crawl = input.inspection?.lastCrawlTime ?? null;
  return crawl !== null && crawl.getTime() >= input.appliedAt.getTime()
    ? "seen"
    : "pending";
}
