import { describe, expect, it } from "vitest";

import { extractPageFacts, simhash64, type PageFacts } from "./html-audit";
import {
  SITE_LEVEL_CODES,
  TA_CATALOG,
  auditPage,
  auditSite,
  isIndexable,
  isValidHreflangCode,
  type AuditPageInput,
  type PageIssue,
  type SiteAuditPage,
  type TaCode,
} from "./technical-audit";

// Bu dosyanın kanıtladığı: her TA kuralı eşiğinde doğru tetiklenir, katalog
// önemleri plan §6.3 tablosuyla aynıdır, TA7/TA10 kilit sayfada CRITICAL
// olur, site düzeyi kurallar (TA2, TA5, TA12, TA13, TA14, TA16, TA20, TA23,
// TA24) koşullarına uyar.

const URL_ = "https://x.com/page";

function facts(overrides: Partial<PageFacts> = {}): PageFacts {
  const base = extractPageFacts(
    `<html><head><title>A good descriptive page title</title><meta name="description" content="About"><link rel="canonical" href="${URL_}"></head><body><h1>Head</h1><p>${"word ".repeat(250)}</p></body></html>`,
    URL_,
  );
  return { ...base, ...overrides };
}

function input(overrides: Partial<AuditPageInput> = {}): AuditPageInput {
  return {
    url: URL_,
    status: 200,
    fetchError: null,
    contentType: "text/html; charset=utf-8",
    redirectHops: 0,
    redirectLoop: false,
    facts: facts(),
    headerNoindex: false,
    ttfbMs: 200,
    robotsBlocked: false,
    isKeyPage: false,
    shouldBeIndexed: true,
    isHomepage: false,
    ...overrides,
  };
}

function codes(issues: PageIssue[]): TaCode[] {
  return issues.map((entry) => entry.code);
}

describe("TA_CATALOG", () => {
  it("severities equal the plan table", () => {
    const warn: TaCode[] = [
      "TA1",
      "TA2",
      "TA7",
      "TA8",
      "TA9",
      "TA10",
      "TA11",
      "TA12",
      "TA16",
      "TA18",
      "TA19",
      "TA20",
      "TA21",
      "TA22",
      "TA24",
    ];
    const info: TaCode[] = [
      "TA3",
      "TA4",
      "TA5",
      "TA6",
      "TA13",
      "TA14",
      "TA15",
      "TA17",
      "TA23",
    ];
    for (const code of warn) expect(TA_CATALOG[code].severity).toBe("WARN");
    for (const code of info) expect(TA_CATALOG[code].severity).toBe("INFO");
    expect(Object.keys(TA_CATALOG)).toHaveLength(24);
    expect(TA_CATALOG.TA14.title).toBe("Page is more than 4 clicks deep");
    for (const entry of Object.values(TA_CATALOG)) {
      expect(entry.fix.endsWith(".")).toBe(true);
    }
    expect(SITE_LEVEL_CODES).toEqual([
      "TA2",
      "TA5",
      "TA12",
      "TA13",
      "TA14",
      "TA16",
      "TA20",
      "TA23",
      "TA24",
    ]);
  });
});

describe("auditPage", () => {
  it("a healthy page has no issues", () => {
    expect(auditPage(input())).toEqual([]);
  });

  it("TA1 / TA3 title boundaries 19/20/65/66", () => {
    expect(
      codes(auditPage(input({ facts: facts({ title: null }) }))),
    ).toContain("TA1");
    expect(
      codes(auditPage(input({ facts: facts({ title: "x".repeat(19) }) }))),
    ).toContain("TA3");
    expect(
      codes(auditPage(input({ facts: facts({ title: "x".repeat(20) }) }))),
    ).not.toContain("TA3");
    expect(
      codes(auditPage(input({ facts: facts({ title: "x".repeat(65) }) }))),
    ).not.toContain("TA3");
    expect(
      codes(auditPage(input({ facts: facts({ title: "x".repeat(66) }) }))),
    ).toContain("TA3");
  });

  it("TA4, TA6, TA17 only on indexable pages", () => {
    const broken = facts({
      metaDescription: null,
      h1: ["a", "b"],
      imagesNoAlt: 2,
    });
    expect(codes(auditPage(input({ facts: broken })))).toEqual([
      "TA4",
      "TA6",
      "TA17",
    ]);
    expect(codes(auditPage(input({ facts: { ...broken, h1: [] } })))).toContain(
      "TA6",
    );
    const noindexed = auditPage(
      input({ facts: { ...broken, noindex: true }, shouldBeIndexed: false }),
    );
    expect(codes(noindexed)).toEqual([]);
  });

  it("TA15 thin content 199/200, not on the homepage", () => {
    expect(
      codes(auditPage(input({ facts: facts({ wordCount: 199 }) }))),
    ).toContain("TA15");
    expect(
      codes(auditPage(input({ facts: facts({ wordCount: 200 }) }))),
    ).not.toContain("TA15");
    expect(
      codes(
        auditPage(input({ facts: facts({ wordCount: 10 }), isHomepage: true })),
      ),
    ).not.toContain("TA15");
  });

  it("TA7 noindex on a page that should be indexed; CRITICAL on key pages", () => {
    expect(auditPage(input({ facts: facts({ noindex: true }) }))).toEqual([
      { code: "TA7", severity: "WARN" },
    ]);
    expect(
      auditPage(input({ facts: facts({ noindex: true }), isKeyPage: true })),
    ).toEqual([{ code: "TA7", severity: "CRITICAL" }]);
    expect(
      auditPage(
        input({
          headerNoindex: true,
          facts: null,
          contentType: "application/pdf",
        }),
      ),
    ).toEqual([{ code: "TA7", severity: "WARN" }]);
    expect(
      auditPage(
        input({ facts: facts({ noindex: true }), shouldBeIndexed: false }),
      ),
    ).toEqual([]);
  });

  it("TA8 canonical missing, relative, multiple or elsewhere; query twin exception", () => {
    expect(
      codes(
        auditPage(
          input({
            facts: facts({
              canonical: null,
              canonicalResolved: null,
              canonicalCount: 0,
            }),
          }),
        ),
      ),
    ).toContain("TA8");
    expect(
      codes(auditPage(input({ facts: facts({ canonicalRelative: true }) }))),
    ).toContain("TA8");
    expect(
      codes(auditPage(input({ facts: facts({ canonicalCount: 2 }) }))),
    ).toContain("TA8");
    expect(
      codes(
        auditPage(
          input({
            facts: facts({
              canonical: "https://x.com/other",
              canonicalResolved: "https://x.com/other",
            }),
          }),
        ),
      ),
    ).toContain("TA8");
    const twin = auditPage(
      input({
        url: "https://x.com/page?color=red",
        facts: facts({ canonical: URL_, canonicalResolved: URL_ }),
      }),
    );
    expect(codes(twin)).not.toContain("TA8");
    const notTwin = auditPage(
      input({
        url: "https://x.com/page?color=red",
        facts: facts({
          canonical: "https://x.com/",
          canonicalResolved: "https://x.com/",
        }),
      }),
    );
    expect(codes(notTwin)).toContain("TA8");
  });

  it("TA9 / TA10 status errors; TA10 CRITICAL on key pages", () => {
    expect(auditPage(input({ status: 404, facts: null }))).toEqual([
      { code: "TA9", severity: "WARN" },
    ]);
    expect(auditPage(input({ status: 503, facts: null }))).toEqual([
      { code: "TA10", severity: "WARN" },
    ]);
    expect(
      auditPage(input({ status: 500, facts: null, isKeyPage: true })),
    ).toEqual([{ code: "TA10", severity: "CRITICAL" }]);
  });

  it("TA11 redirect hops 2/3 and loops", () => {
    expect(codes(auditPage(input({ redirectHops: 2 })))).not.toContain("TA11");
    expect(codes(auditPage(input({ redirectHops: 3 })))).toContain("TA11");
    expect(
      codes(
        auditPage(
          input({
            redirectLoop: true,
            status: null,
            facts: null,
            fetchError: "LOOP",
          }),
        ),
      ),
    ).toEqual(["TA11"]);
  });

  it("TA18 ttfb 1500/1501 and truncated HTML", () => {
    expect(codes(auditPage(input({ ttfbMs: 1500 })))).not.toContain("TA18");
    expect(codes(auditPage(input({ ttfbMs: 1501 })))).toContain("TA18");
    expect(
      codes(auditPage(input({ facts: facts({ truncated: true }) }))),
    ).toContain("TA18");
  });

  it("TA19 mixed content, TA21 JSON-LD errors, TA22 render risk", () => {
    expect(
      codes(
        auditPage(
          input({ facts: facts({ mixedContent: ["http://a/x.png"] }) }),
        ),
      ),
    ).toEqual(["TA19"]);
    expect(
      codes(
        auditPage(
          input({
            facts: facts({
              jsonLd: { types: [], errors: ["Missing @context"], items: [] },
            }),
          }),
        ),
      ),
    ).toEqual(["TA21"]);
    expect(
      codes(auditPage(input({ facts: facts({ renderRisk: true }) }))),
    ).toEqual(["TA22"]);
  });

  it("TA20 invalid hreflang code or hreflang with a canonical elsewhere", () => {
    expect(
      codes(
        auditPage(
          input({
            facts: facts({ hreflang: [{ lang: "english", href: URL_ }] }),
          }),
        ),
      ),
    ).toContain("TA20");
    expect(
      codes(
        auditPage(
          input({
            facts: facts({ hreflang: [{ lang: "en-GB", href: URL_ }] }),
          }),
        ),
      ),
    ).not.toContain("TA20");
    const elsewhere = facts({
      hreflang: [{ lang: "en", href: URL_ }],
      canonical: "https://x.com/other",
      canonicalResolved: "https://x.com/other",
    });
    expect(codes(auditPage(input({ facts: elsewhere })))).toContain("TA20");
  });
});

describe("isIndexable", () => {
  it("needs 200 HTML, no robots block, no noindex and a self or absent canonical", () => {
    expect(isIndexable(input())).toBe(true);
    expect(isIndexable(input({ status: 301 }))).toBe(false);
    expect(isIndexable(input({ contentType: "application/pdf" }))).toBe(false);
    expect(isIndexable(input({ robotsBlocked: true }))).toBe(false);
    expect(isIndexable(input({ headerNoindex: true }))).toBe(false);
    expect(isIndexable(input({ facts: facts({ noindex: true }) }))).toBe(false);
    expect(
      isIndexable(input({ facts: facts({ canonicalResolved: null }) })),
    ).toBe(true);
    expect(
      isIndexable(
        input({ facts: facts({ canonicalResolved: "https://x.com/other" }) }),
      ),
    ).toBe(false);
    expect(isIndexable(input({ fetchError: "TIMEOUT", status: 200 }))).toBe(
      false,
    );
  });

  it("validates hreflang codes", () => {
    for (const code of [
      "en",
      "en-GB",
      "zh-Hant",
      "zh-Hant-TW",
      "x-default",
      "X-Default",
    ]) {
      expect(isValidHreflangCode(code)).toBe(true);
    }
    for (const code of [
      "english",
      "e",
      "en_GB",
      "en-",
      "eng-US",
      "en-GBR",
      "",
    ]) {
      expect(isValidHreflangCode(code)).toBe(false);
    }
  });
});

let counter = 0;
function sitePage(overrides: Partial<SiteAuditPage> = {}): SiteAuditPage {
  counter += 1;
  const id = overrides.id ?? `p${counter}`;
  const url = overrides.url ?? `https://x.com/${id}`;
  return {
    id,
    url,
    urlHash: overrides.urlHash ?? `h-${url}`,
    status: 200,
    indexable: true,
    isHomepage: false,
    isKeyPage: false,
    title: `Title ${id}`,
    metaDescription: `Description ${id}`,
    textHash: `hash-${id}`,
    textSimhash: null,
    wordCount: 300,
    inlinks: 3,
    depth: 1,
    inSitemap: true,
    hreflang: [],
    issues: [],
    ...overrides,
  };
}

const FULL = { sitemapKnown: true, crawlComplete: true };

function siteCodes(result: Map<string, PageIssue[]>, id: string): TaCode[] {
  return codes(result.get(id) ?? []);
}

describe("auditSite", () => {
  it("TA2 / TA5 duplicates among indexable pages only", () => {
    const a = sitePage({ id: "a", title: "Same", metaDescription: "Same d" });
    const b = sitePage({ id: "b", title: "same ", metaDescription: "Other" });
    const c = sitePage({
      id: "c",
      title: "Same",
      metaDescription: "Same d",
      indexable: false,
    });
    const result = auditSite([a, b, c], [], FULL);
    expect(siteCodes(result, "a")).toEqual(["TA2"]);
    expect(siteCodes(result, "b")).toEqual(["TA2"]);
    expect(siteCodes(result, "c")).toEqual([]);
  });

  it("TA12 links to 4xx/5xx pages", () => {
    const from = sitePage({ id: "from" });
    const broken = sitePage({ id: "gone", status: 404, indexable: false });
    const error = sitePage({ id: "err", status: 500, indexable: false });
    const result = auditSite(
      [from, broken, error],
      [
        { fromId: "from", toUrlHash: broken.urlHash },
        { fromId: "from", toUrlHash: error.urlHash },
      ],
      FULL,
    );
    expect(siteCodes(result, "from")).toEqual(["TA12"]);
  });

  it("TA13 only when the crawl is complete", () => {
    const orphan = sitePage({ id: "orphan", inlinks: 0 });
    const home = sitePage({ id: "home", inlinks: 0, isHomepage: true });
    expect(siteCodes(auditSite([orphan, home], [], FULL), "orphan")).toEqual([
      "TA13",
    ]);
    expect(siteCodes(auditSite([orphan, home], [], FULL), "home")).toEqual([]);
    expect(
      siteCodes(
        auditSite([orphan], [], { ...FULL, crawlComplete: false }),
        "orphan",
      ),
    ).toEqual([]);
  });

  it("TA14 depth 4/5", () => {
    const result = auditSite(
      [sitePage({ id: "d4", depth: 4 }), sitePage({ id: "d5", depth: 5 })],
      [],
      FULL,
    );
    expect(siteCodes(result, "d4")).toEqual([]);
    expect(siteCodes(result, "d5")).toEqual(["TA14"]);
  });

  it("TA16 exact copies and simhash distance 3/4 within a bucket", () => {
    const exactA = sitePage({ id: "ea", textHash: "same" });
    const exactB = sitePage({ id: "eb", textHash: "same" });
    const short = sitePage({ id: "short", textHash: "same", wordCount: 49 });
    const near = sitePage({ id: "n1", textSimhash: "abcd000000000000" });
    const near3 = sitePage({ id: "n2", textSimhash: "abcd000000000007" });
    const far4 = sitePage({ id: "n3", textSimhash: "abcd0000000f0000" });
    const result = auditSite(
      [exactA, exactB, short, near, near3, far4],
      [],
      FULL,
    );
    expect(siteCodes(result, "ea")).toEqual(["TA16"]);
    expect(siteCodes(result, "eb")).toEqual(["TA16"]);
    expect(siteCodes(result, "short")).toEqual([]);
    expect(siteCodes(result, "n1")).toEqual(["TA16"]);
    expect(siteCodes(result, "n2")).toEqual(["TA16"]);
    expect(siteCodes(result, "n3")).toEqual([]);
  });

  it("TA16 with real simhashes from near-identical pages", () => {
    const words = Array.from({ length: 3_000 }, (_, index) => `w${index}`);
    const tweaked = [...words];
    tweaked[10] = "changed";
    const a = sitePage({ id: "ra", textSimhash: simhash64(words) });
    const b = sitePage({ id: "rb", textSimhash: simhash64(tweaked) });
    const result = auditSite([a, b], [], FULL);
    const sameBucket =
      (a.textSimhash ?? "").slice(0, 4) === (b.textSimhash ?? "").slice(0, 4);
    expect(siteCodes(result, "ra").includes("TA16")).toBe(sameBucket);
  });

  it("handles a large bucket in bounded time", () => {
    const pages = Array.from({ length: 3_000 }, (_, index) =>
      sitePage({
        id: `b${index}`,
        textSimhash: `abcd${index.toString(16).padStart(12, "0")}`,
      }),
    );
    const started = performance.now();
    auditSite(pages, [], FULL);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("TA20 missing return links", () => {
    const en = sitePage({
      id: "en",
      url: "https://x.com/en",
      hreflang: [{ lang: "tr", href: "https://x.com/tr" }],
    });
    const tr = sitePage({ id: "tr", url: "https://x.com/tr", hreflang: [] });
    expect(siteCodes(auditSite([en, tr], [], FULL), "en")).toEqual(["TA20"]);
    const trBack = {
      ...tr,
      hreflang: [{ lang: "en", href: "https://x.com/en" }],
    };
    expect(siteCodes(auditSite([en, trBack], [], FULL), "en")).toEqual([]);
    const notCrawled = sitePage({
      id: "solo",
      hreflang: [{ lang: "de", href: "https://x.com/de" }],
    });
    expect(siteCodes(auditSite([notCrawled], [], FULL), "solo")).toEqual([]);
  });

  it("TA23 only when the sitemap is known", () => {
    const missing = sitePage({ id: "nosm", inSitemap: false });
    expect(siteCodes(auditSite([missing], [], FULL), "nosm")).toEqual(["TA23"]);
    expect(
      siteCodes(
        auditSite([missing], [], { ...FULL, sitemapKnown: false }),
        "nosm",
      ),
    ).toEqual([]);
  });

  it("TA24 at 20 query variants of one path", () => {
    const make = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        sitePage({
          id: `v${count}-${index}`,
          url: `https://x.com/list?page=${index}`,
        }),
      );
    const nineteen = make(19);
    expect(
      siteCodes(auditSite(nineteen, [], FULL), nineteen[0]?.id ?? ""),
    ).toEqual([]);
    const twenty = make(20);
    expect(siteCodes(auditSite(twenty, [], FULL), twenty[0]?.id ?? "")).toEqual(
      ["TA24"],
    );
  });

  it("keeps page-level issues and removes duplicates", () => {
    const page = sitePage({
      id: "merged",
      depth: 9,
      issues: [
        { code: "TA1", severity: "WARN" },
        { code: "TA14", severity: "INFO" },
        { code: "TA7", severity: "CRITICAL" },
      ],
    });
    expect(auditSite([page], [], FULL).get("merged")).toEqual([
      { code: "TA1", severity: "WARN" },
      { code: "TA14", severity: "INFO" },
      { code: "TA7", severity: "CRITICAL" },
    ]);
  });
});
