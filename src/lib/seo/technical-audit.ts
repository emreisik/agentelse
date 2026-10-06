import { normalizeCrawlUrl } from "@/lib/seo/crawl-url";
import { simhashDistance, type PageFacts } from "@/lib/seo/html-audit";

// Teknik denetim kataloğu TA1–TA24 (docs/google-search-console-plan.md §6.3).
// auditPage tek sayfanın kendi olgularından, auditSite bütün taramadan
// (kopya başlık, kırık link, yetim sayfa, benzer içerik...) sorun üretir.
// Önemler planın tablosuyla birebir aynıdır; TA7 ve TA10 kilit sayfada
// CRITICAL olur. Saf modül.

export type IssueSeverity = "INFO" | "WARN" | "CRITICAL";
export type TaCode =
  | "TA1"
  | "TA2"
  | "TA3"
  | "TA4"
  | "TA5"
  | "TA6"
  | "TA7"
  | "TA8"
  | "TA9"
  | "TA10"
  | "TA11"
  | "TA12"
  | "TA13"
  | "TA14"
  | "TA15"
  | "TA16"
  | "TA17"
  | "TA18"
  | "TA19"
  | "TA20"
  | "TA21"
  | "TA22"
  | "TA23"
  | "TA24";
export type PageIssue = { code: TaCode; severity: IssueSeverity };

export const TA_CATALOG: Readonly<
  Record<TaCode, { title: string; severity: IssueSeverity; fix: string }>
> = {
  TA1: {
    title: "Missing page title",
    severity: "WARN",
    fix: "Write a title that is specific to this page.",
  },
  TA2: {
    title: "Duplicate page title",
    severity: "WARN",
    fix: "Give every page its own distinctive title.",
  },
  TA3: {
    title: "Page title too short or too long",
    severity: "INFO",
    fix: "Keep the title at around 30 to 60 characters.",
  },
  TA4: {
    title: "Missing meta description",
    severity: "INFO",
    fix: "Add a meta description that tells searchers what the page offers.",
  },
  TA5: {
    title: "Duplicate meta description",
    severity: "INFO",
    fix: "Write a meta description that is specific to each page.",
  },
  TA6: {
    title: "Missing or multiple H1 headings",
    severity: "INFO",
    fix: "Use one clear H1 heading per page.",
  },
  TA7: {
    title: "Page is set to noindex",
    severity: "WARN",
    fix: "Remove the noindex tag so the page can appear in search.",
  },
  TA8: {
    title: "Canonical tag missing or points elsewhere",
    severity: "WARN",
    fix: "Add an absolute canonical tag that points to the page itself.",
  },
  TA9: {
    title: "Page returns a 4xx error",
    severity: "WARN",
    fix: "Redirect the URL to a working page or fix the links that point to it.",
  },
  TA10: {
    title: "Page returns a server error",
    severity: "WARN",
    fix: "Fix the server error so the page loads again.",
  },
  TA11: {
    title: "Redirect chain",
    severity: "WARN",
    fix: "Redirect straight to the final address in a single step.",
  },
  TA12: {
    title: "Broken internal links",
    severity: "WARN",
    fix: "Update the links so they point to a working page.",
  },
  TA13: {
    title: "Orphan page",
    severity: "INFO",
    fix: "Link to this page from related pages on your site.",
  },
  TA14: {
    title: "Page is more than 4 clicks deep",
    severity: "INFO",
    fix: "Add the page to your navigation or link it from a hub page.",
  },
  TA15: {
    title: "Thin content",
    severity: "INFO",
    fix: "Expand the content, merge it into a related page or set it to noindex.",
  },
  TA16: {
    title: "Duplicate or near-duplicate content",
    severity: "WARN",
    fix: "Merge or differentiate the pages, or point the copies to one canonical URL.",
  },
  TA17: {
    title: "Images without alt text",
    severity: "INFO",
    fix: "Add descriptive alt text to the images.",
  },
  TA18: {
    title: "Heavy page or slow server response",
    severity: "WARN",
    fix: "Make the page lighter and speed up the server with optimised images and caching.",
  },
  TA19: {
    title: "Mixed content",
    severity: "WARN",
    fix: "Load every resource on the page over HTTPS.",
  },
  TA20: {
    title: "hreflang errors",
    severity: "WARN",
    fix: "Use valid language codes and make every hreflang page link back.",
  },
  TA21: {
    title: "Structured data errors",
    severity: "WARN",
    fix: "Fix the structured data so it is valid and complete.",
  },
  TA22: {
    title: "Content may need JavaScript to show",
    severity: "WARN",
    fix: "Render the main content on the server or pre-render the page.",
  },
  TA23: {
    title: "Indexable page missing from sitemap",
    severity: "INFO",
    fix: "Add the page to your sitemap.",
  },
  TA24: {
    title: "Too many URL parameter variants",
    severity: "WARN",
    fix: "Consolidate the parameter URLs with canonical tags, a robots rule or parameter cleanup.",
  },
};

export const SITE_LEVEL_CODES: readonly TaCode[] = [
  "TA2",
  "TA5",
  "TA12",
  "TA13",
  "TA14",
  "TA16",
  "TA20",
  "TA23",
  "TA24",
];

// Eşikler (plan §6.3; TA18'de 3 MB yerine 2 MB HTML sınırı, varlıklar
// indirilmediği için).
const TITLE_MIN = 20;
const TITLE_MAX = 65;
const THIN_WORDS = 200;
const MAX_REDIRECT_HOPS = 2;
const SLOW_TTFB_MS = 1_500;
const MAX_DEPTH = 4;
const DUPLICATE_MIN_WORDS = 50;
const NEAR_DUPLICATE_DISTANCE = 3;
const PARAM_VARIANTS = 20;
// Benzer içerik: bir kova içinde her sayfa sıralı komşularından en çok bu
// kadarıyla karşılaştırılır.
const BUCKET_FULL_COMPARE = 64;
const BUCKET_NEIGHBOURS = 32;

export type AuditPageInput = {
  url: string;
  status: number | null;
  fetchError: string | null;
  contentType: string | null;
  redirectHops: number;
  redirectLoop: boolean;
  facts: PageFacts | null;
  headerNoindex: boolean;
  ttfbMs: number | null;
  robotsBlocked: boolean;
  isKeyPage: boolean;
  shouldBeIndexed: boolean;
  isHomepage: boolean;
};

function issue(code: TaCode, keyPage = false): PageIssue {
  const severity = TA_CATALOG[code].severity;
  if ((code === "TA7" || code === "TA10") && keyPage)
    return { code, severity: "CRITICAL" };
  return { code, severity };
}

function isHtml(input: AuditPageInput): boolean {
  if (!input.contentType) return input.facts !== null;
  const type = input.contentType.toLowerCase();
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function sameUrl(a: string, b: string): boolean {
  return (normalizeCrawlUrl(a) ?? a) === (normalizeCrawlUrl(b) ?? b);
}

// Sorgulu adresin sorgusuz eşi ("/shoes?color=red" → "/shoes").
function queryTwin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.search) return null;
    return normalizeCrawlUrl(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return null;
  }
}

export function isIndexable(input: AuditPageInput): boolean {
  if (input.status !== 200 || input.fetchError !== null) return false;
  if (!isHtml(input) || input.robotsBlocked || input.headerNoindex)
    return false;
  if (input.facts?.noindex) return false;
  const canonical = input.facts?.canonicalResolved ?? null;
  return canonical === null || sameUrl(canonical, input.url);
}

export function isValidHreflangCode(code: string): boolean {
  const value = code.trim();
  if (value.toLowerCase() === "x-default") return true;
  return /^[a-z]{2}(-[a-z]{4})?(-[a-z]{2})?$/i.test(value);
}

export function auditPage(input: AuditPageInput): PageIssue[] {
  const issues: PageIssue[] = [];
  const status = input.status;
  if (status !== null && status >= 400 && status < 500)
    issues.push(issue("TA9"));
  if (status !== null && status >= 500 && status < 600)
    issues.push(issue("TA10", input.isKeyPage));
  if (input.redirectHops > MAX_REDIRECT_HOPS || input.redirectLoop)
    issues.push(issue("TA11"));
  const facts = input.facts;
  const ok =
    status !== null &&
    status >= 200 &&
    status < 300 &&
    input.fetchError === null;
  if (
    ok &&
    (facts?.truncated || (input.ttfbMs !== null && input.ttfbMs > SLOW_TTFB_MS))
  ) {
    issues.push(issue("TA18"));
  }
  const noindex = Boolean(facts?.noindex) || input.headerNoindex;
  if (ok && noindex && input.shouldBeIndexed)
    issues.push(issue("TA7", input.isKeyPage));
  if (!ok || !facts || !isHtml(input)) return issues;

  const indexable = isIndexable(input);
  if (indexable) {
    const title = facts.title?.trim() ?? "";
    if (!title) issues.push(issue("TA1"));
    else {
      const length = Array.from(title).length;
      if (length < TITLE_MIN || length > TITLE_MAX) issues.push(issue("TA3"));
    }
    if (!facts.metaDescription?.trim()) issues.push(issue("TA4"));
    if (facts.h1.length !== 1) issues.push(issue("TA6"));
  }

  // TA8: noindex sayfada canonical anlamsızdır; robots engelli sayfa da atlanır.
  if (!noindex && !input.robotsBlocked) {
    const resolved = facts.canonicalResolved;
    let canonicalIssue =
      facts.canonical === null ||
      facts.canonicalRelative ||
      facts.canonicalCount > 1 ||
      resolved === null;
    if (!canonicalIssue && resolved !== null && !sameUrl(resolved, input.url)) {
      // Sorgulu adresin sorgusuz eşine işaret etmesi doğrudur.
      canonicalIssue = queryTwin(input.url) !== resolved;
    }
    if (canonicalIssue) issues.push(issue("TA8"));
  }

  if (indexable && !input.isHomepage && facts.wordCount < THIN_WORDS)
    issues.push(issue("TA15"));
  if (indexable && facts.imagesNoAlt > 0) issues.push(issue("TA17"));
  if (facts.mixedContent.length > 0) issues.push(issue("TA19"));
  const canonicalElsewhere =
    facts.canonicalResolved !== null &&
    !sameUrl(facts.canonicalResolved, input.url);
  if (
    facts.hreflang.some((entry) => !isValidHreflangCode(entry.lang)) ||
    (facts.hreflang.length > 0 && canonicalElsewhere)
  ) {
    issues.push(issue("TA20"));
  }
  if (facts.jsonLd.errors.length > 0) issues.push(issue("TA21"));
  if (facts.renderRisk) issues.push(issue("TA22"));
  return issues;
}

export type SiteAuditPage = {
  id: string;
  url: string;
  urlHash: string;
  status: number | null;
  indexable: boolean;
  isHomepage: boolean;
  isKeyPage: boolean;
  title: string | null;
  metaDescription: string | null;
  textHash: string | null;
  textSimhash: string | null;
  wordCount: number | null;
  inlinks: number;
  depth: number | null;
  inSitemap: boolean;
  hreflang: { lang: string; href: string }[];
  issues: PageIssue[];
};

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  INFO: 0,
  WARN: 1,
  CRITICAL: 2,
};

function groupBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

// Benzer içerik (TA16). Tam kopya aynı textHash ile bulunur. Yakın kopya
// için bütün çiftleri karşılaştırmak O(n²) olurdu; bunun yerine simhash'in
// ilk 4 onaltılık hanesi (16 bit) aynı olan sayfalar bir kovaya girer ve
// yalnız kova içinde karşılaştırılır. Kova küçükse bütün çiftler, büyükse
// her sayfa simhash sırasındaki en yakın 32 komşusuyla karşılaştırılır;
// toplam O(n log n). Yaklaşıklık: farkı ilk 16 bitte olan çok benzer
// sayfalar kaçabilir (mesafe ≤ 3 için bu nadirdir; kabul edilen bedel).
function nearDuplicateIds(pages: readonly SiteAuditPage[]): Set<string> {
  const flagged = new Set<string>();
  const candidates = pages.filter(
    (page) => page.indexable && (page.wordCount ?? 0) >= DUPLICATE_MIN_WORDS,
  );
  for (const group of groupBy(candidates, (page) => page.textHash).values()) {
    if (group.length > 1) for (const page of group) flagged.add(page.id);
  }
  const hashed = candidates.filter(
    (page) => page.textSimhash && /^[0-9a-f]{16}$/i.test(page.textSimhash),
  );
  const buckets = groupBy(hashed, (page) =>
    (page.textSimhash ?? "").slice(0, 4).toLowerCase(),
  );
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) =>
      (a.textSimhash ?? "") < (b.textSimhash ?? "") ? -1 : 1,
    );
    const reach =
      bucket.length <= BUCKET_FULL_COMPARE ? bucket.length : BUCKET_NEIGHBOURS;
    for (let i = 0; i < bucket.length; i += 1) {
      const left = bucket[i];
      if (!left) continue;
      for (let j = i + 1; j < bucket.length && j <= i + reach; j += 1) {
        const right = bucket[j];
        if (!right) continue;
        if (
          simhashDistance(left.textSimhash ?? "", right.textSimhash ?? "") <=
          NEAR_DUPLICATE_DISTANCE
        ) {
          flagged.add(left.id);
          flagged.add(right.id);
        }
      }
    }
  }
  return flagged;
}

function withoutQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.search ? `${parsed.origin}${parsed.pathname}` : null;
  } catch {
    return null;
  }
}

export function auditSite(
  pages: readonly SiteAuditPage[],
  links: readonly { fromId: string; toUrlHash: string }[],
  options: { sitemapKnown: boolean; crawlComplete: boolean },
): Map<string, PageIssue[]> {
  const site = new Map<string, TaCode[]>();
  const add = (id: string, code: TaCode) => {
    const list = site.get(id);
    if (list) list.push(code);
    else site.set(id, [code]);
  };

  const indexable = pages.filter((page) => page.indexable);
  const duplicates = (
    keyOf: (page: SiteAuditPage) => string | null,
    code: TaCode,
  ) => {
    for (const group of groupBy(indexable, keyOf).values()) {
      if (group.length > 1) for (const page of group) add(page.id, code);
    }
  };
  duplicates((page) => page.title?.trim().toLowerCase() || null, "TA2");
  duplicates(
    (page) => page.metaDescription?.trim().toLowerCase() || null,
    "TA5",
  );

  // TA12: 4xx/5xx sayfaya giden iç link.
  const byHash = new Map(pages.map((page) => [page.urlHash, page]));
  for (const link of links) {
    const target = byHash.get(link.toUrlHash);
    if (
      target &&
      target.status !== null &&
      target.status >= 400 &&
      target.status < 600
    ) {
      add(link.fromId, "TA12");
    }
  }

  for (const page of pages) {
    if (
      options.crawlComplete &&
      page.indexable &&
      page.inlinks === 0 &&
      !page.isHomepage
    ) {
      add(page.id, "TA13");
    }
    if (page.depth !== null && page.depth > MAX_DEPTH) add(page.id, "TA14");
    if (options.sitemapKnown && page.indexable && !page.inSitemap)
      add(page.id, "TA23");
  }

  for (const id of nearDuplicateIds(pages)) add(id, "TA16");

  // TA20: hreflang hedefi taranmışsa geri dönüş linki olmalı.
  const byUrl = new Map(
    pages.map((page) => [normalizeCrawlUrl(page.url) ?? page.url, page]),
  );
  for (const page of pages) {
    const self = normalizeCrawlUrl(page.url) ?? page.url;
    for (const entry of page.hreflang) {
      const href = normalizeCrawlUrl(entry.href) ?? entry.href;
      if (href === self) continue;
      const target = byUrl.get(href);
      if (!target) continue;
      const linksBack = target.hreflang.some(
        (back) => (normalizeCrawlUrl(back.href) ?? back.href) === self,
      );
      if (!linksBack) {
        add(page.id, "TA20");
        break;
      }
    }
  }

  // TA24: aynı yolun ≥ 20 sorgulu varyantı.
  const variants = groupBy(pages, (page) => withoutQuery(page.url));
  for (const group of variants.values()) {
    if (group.length >= PARAM_VARIANTS)
      for (const page of group) add(page.id, "TA24");
  }

  const result = new Map<string, PageIssue[]>();
  for (const page of pages) {
    // Sayfa düzeyindeki sorunlar korunur; aynı kod bir kez, en yüksek önemle.
    const merged = new Map<TaCode, PageIssue>();
    const all = [
      ...page.issues,
      ...(site.get(page.id) ?? []).map((code) => issue(code)),
    ];
    for (const entry of all) {
      const current = merged.get(entry.code);
      if (
        !current ||
        SEVERITY_RANK[entry.severity] > SEVERITY_RANK[current.severity]
      ) {
        merged.set(entry.code, entry);
      }
    }
    result.set(page.id, [...merged.values()]);
  }
  return result;
}
