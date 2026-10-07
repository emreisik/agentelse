import { describe, expect, it } from "vitest";

import { extractPageFacts } from "@/lib/seo/html-audit";

import {
  googleStageOf,
  observedFromFacts,
  sameText,
  sameUrl,
  textSimilarity,
  verifyAlertResolved,
  verifyConsolidate,
  verifyContentRefresh,
  verifyCruxData,
  verifyInternalLinks,
  verifyLive,
  verifySchema,
  verifySitemaps,
  verifyTechFix,
  verifyTitleMeta,
  type CrawledChange,
  type ObservedPage,
} from "./verify-checks";
import type { PageSnapshot, SeoActionProposal } from "./types";

// Bu dosyanın kabul testinin saf kısmı ("title change auto-verified"):
// başlık, içerik, bağlantı, birleştirme, teknik düzeltme, şema, uyarı, CrUX ve
// site haritası denetimleri.

const PAGE = "https://example.com/page";
const NO_CHANGE: CrawledChange = { titleChanged: false, contentChanged: false };

function observed(over: Partial<ObservedPage> = {}): ObservedPage {
  return {
    url: PAGE,
    finalUrl: PAGE,
    status: 200,
    hops: 0,
    fetchError: null,
    robotsBlocked: false,
    links: [],
    title: "Blue widgets for every home",
    metaDescription: "Shop blue widgets.",
    h1: "Blue widgets",
    h2: ["Sizes"],
    canonical: null,
    noindex: false,
    indexable: true,
    wordCount: 500,
    textHash: "hash-new",
    schemaTypes: [],
    schemaErrors: 0,
    fetchedAt: "2026-09-02T00:00:00.000Z",
    source: "FETCH",
    ...over,
  };
}

function baseline(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: PAGE,
    status: 200,
    title: "Widgets",
    metaDescription: "Widgets shop.",
    h1: "Widgets",
    h2: ["Sizes"],
    canonical: null,
    noindex: false,
    indexable: true,
    wordCount: 500,
    textHash: "hash-old",
    schemaTypes: [],
    schemaErrors: 0,
    fetchedAt: "2026-09-01T00:00:00.000Z",
    source: "CRAWL",
    ...over,
  };
}

type TitleProposal = Extract<SeoActionProposal, { kind: "TITLE_META" }>;
function titleProposal(over: Partial<TitleProposal> = {}): TitleProposal {
  return {
    kind: "TITLE_META",
    before: { title: "Widgets", metaDescription: "Widgets shop." },
    after: {
      title: "Blue widgets for every home",
      metaDescription: "Shop blue widgets.",
    },
    variants: [],
    ...over,
  };
}

describe("text helpers", () => {
  it("sameText folds case, width and whitespace", () => {
    expect(sameText("Blue  Widgets", " blue widgets ")).toBe(true);
    expect(sameText("ＡＢＣ", "abc")).toBe(true);
    expect(sameText(null, null)).toBe(true);
    expect(sameText("a", null)).toBe(false);
    expect(sameText("a", "b")).toBe(false);
  });

  it("sameUrl normalizes and never equates null", () => {
    expect(sameUrl("https://Example.com/a?utm_source=x", "https://example.com/a")).toBe(
      true,
    );
    expect(sameUrl("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(sameUrl(null, null)).toBe(false);
    expect(sameUrl("nope", "nope")).toBe(false);
  });

  it("textSimilarity is token based", () => {
    expect(textSimilarity("blue widgets shop", "blue widgets shop")).toBe(1);
    expect(textSimilarity(null, "x")).toBe(0);
    expect(textSimilarity("blue widgets", "red gadgets")).toBe(0);
  });
});

describe("observedFromFacts", () => {
  const html = `<!doctype html><html><head><title>Blue widgets</title>
    <meta name="description" content="Shop blue widgets.">
    <link rel="canonical" href="/page">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
    </head><body><h1>Blue widgets</h1><h2>Sizes</h2>
    <a href="/other">Other</a><a href="https://example.com/other?utm_source=x">Again</a>
    <a href="mailto:a@b.c">Mail</a><p>Some words here.</p></body></html>`;

  it("maps facts into an observed page", () => {
    const facts = extractPageFacts(html, PAGE);
    const page = observedFromFacts({
      url: PAGE,
      finalUrl: PAGE,
      status: 200,
      hops: 0,
      facts,
      headerNoindex: false,
      fetchError: null,
      robotsBlocked: false,
      fetchedAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    expect(page.title).toBe("Blue widgets");
    expect(page.metaDescription).toBe("Shop blue widgets.");
    expect(page.h1).toBe("Blue widgets");
    expect(page.h2).toEqual(["Sizes"]);
    expect(page.canonical).toBe(PAGE);
    expect(page.indexable).toBe(true);
    expect(page.source).toBe("FETCH");
    expect(page.schemaTypes).toContain("FAQPage");
    expect(page.links).toEqual(["https://example.com/other"]);
    expect(page.fetchedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("the header noindex wins and a foreign canonical is not indexable", () => {
    const facts = extractPageFacts(html, PAGE);
    const header = observedFromFacts({
      url: PAGE,
      finalUrl: PAGE,
      status: 200,
      hops: 0,
      facts,
      headerNoindex: true,
      fetchError: null,
      robotsBlocked: false,
      fetchedAt: new Date(),
    });
    expect(header.noindex).toBe(true);
    expect(header.indexable).toBe(false);
    const foreign = observedFromFacts({
      url: PAGE,
      finalUrl: "https://example.com/elsewhere",
      status: 200,
      hops: 1,
      facts,
      headerNoindex: false,
      fetchError: null,
      robotsBlocked: false,
      fetchedAt: new Date(),
    });
    expect(foreign.indexable).toBe(false);
    expect(foreign.hops).toBe(1);
  });

  it("handles a failed fetch without facts", () => {
    const page = observedFromFacts({
      url: PAGE,
      finalUrl: PAGE,
      status: null,
      hops: 0,
      facts: null,
      headerNoindex: false,
      fetchError: "TIMEOUT",
      robotsBlocked: false,
      fetchedAt: new Date(),
    });
    expect(page.title).toBeNull();
    expect(page.indexable).toBeNull();
    expect(page.links).toEqual([]);
    expect(page.fetchError).toBe("TIMEOUT");
  });
});

describe("verifyTitleMeta", () => {
  const run = (
    over: {
      proposal?: TitleProposal;
      baseline?: PageSnapshot | null;
      observed?: ObservedPage | null;
      crawled?: CrawledChange;
    } = {},
  ) =>
    verifyTitleMeta({
      proposal: over.proposal ?? titleProposal(),
      baseline: over.baseline === undefined ? baseline() : over.baseline,
      observed: over.observed === undefined ? observed() : over.observed,
      crawled: over.crawled ?? NO_CHANGE,
    });

  it("an equal title and meta verify", () => {
    const result = run();
    expect(result.verified).toBe(true);
    expect(result.fetchFailed).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.checks.map((c) => c.key)).toEqual([
      "page_loads",
      "title_matches",
      "meta_matches",
    ]);
  });

  it("a similar title (0.86) verifies", () => {
    const after = { title: "alpha beta gamma delta epsilon zeta eta", metaDescription: "" };
    const live = "alpha beta gamma delta epsilon zeta eta theta";
    expect(textSimilarity(after.title, live)).toBeGreaterThanOrEqual(0.85);
    const result = run({
      proposal: titleProposal({ after }),
      observed: observed({ title: live }),
    });
    expect(result.verified).toBe(true);
  });

  it("a dissimilar title does not verify", () => {
    const result = run({ observed: observed({ title: "Something else entirely" }) });
    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.key === "title_matches")?.ok).toBe(false);
  });

  it("the old title does not verify", () => {
    const result = run({ observed: observed({ title: "Widgets" }) });
    expect(result.verified).toBe(false);
  });

  it("a 404 or a fetch error is a failed fetch, not a negative result", () => {
    expect(run({ observed: observed({ status: 404 }) })).toMatchObject({
      verified: false,
      fetchFailed: true,
      reason: "FETCH_FAILED",
    });
    expect(run({ observed: observed({ status: null, fetchError: "DNS" }) }).fetchFailed).toBe(
      true,
    );
    expect(run({ observed: null }).fetchFailed).toBe(true);
  });

  it("a robots block is not retried", () => {
    const result = run({ observed: observed({ robotsBlocked: true, status: null }) });
    expect(result.fetchFailed).toBe(false);
    expect(result.reason).toBe("ROBOTS");
  });

  it("without an after, a differing baseline title verifies", () => {
    const proposal = titleProposal({ after: null, before: null });
    expect(run({ proposal, observed: observed({ title: "Brand new heading" }) }).verified).toBe(
      true,
    );
  });

  it("without an after, an unchanged title with only a content change does not verify", () => {
    const proposal = titleProposal({ after: null, before: null });
    const same = observed({ title: "Widgets" });
    expect(
      run({ proposal, observed: same, crawled: { titleChanged: false, contentChanged: true } })
        .verified,
    ).toBe(false);
    expect(
      run({ proposal, observed: same, crawled: { titleChanged: true, contentChanged: false } })
        .verified,
    ).toBe(true);
  });

  it("without an after and without a baseline, only a crawled title change verifies", () => {
    const proposal = titleProposal({ after: null, before: null });
    expect(run({ proposal, baseline: null }).verified).toBe(false);
    expect(
      run({ proposal, baseline: null, crawled: { titleChanged: true, contentChanged: false } })
        .verified,
    ).toBe(true);
  });

  it("meta is checked only when the proposal changed it", () => {
    const proposal = titleProposal({
      before: { title: "Widgets", metaDescription: "Same meta" },
      after: { title: "Blue widgets for every home", metaDescription: "Same meta" },
    });
    const result = run({
      proposal,
      observed: observed({ metaDescription: "Totally different" }),
    });
    expect(result.checks.some((c) => c.key === "meta_matches")).toBe(false);
    expect(result.verified).toBe(true);
    const changed = run({ observed: observed({ metaDescription: "Totally different" }) });
    expect(changed.checks.find((c) => c.key === "meta_matches")?.ok).toBe(false);
    expect(changed.verified).toBe(false);
  });

  it("observed values stay within 200 characters", () => {
    const result = run({ observed: observed({ title: "x".repeat(500) }) });
    const title = result.checks.find((c) => c.key === "title_matches");
    expect(title?.observed?.length).toBe(200);
  });
});

describe("verifyContentRefresh", () => {
  const run = (obs: ObservedPage | null, base: PageSnapshot | null, crawled = NO_CHANGE) =>
    verifyContentRefresh({ baseline: base, observed: obs, crawled });

  it("verifies on a text hash change", () => {
    expect(run(observed({ textHash: "new" }), baseline({ textHash: "old" })).verified).toBe(true);
  });

  it("verifies on a 15% word count change", () => {
    const base = baseline({ textHash: "same", wordCount: 1000 });
    expect(run(observed({ textHash: "same", wordCount: 1150 }), base).verified).toBe(true);
    expect(run(observed({ textHash: "same", wordCount: 1149 }), base).verified).toBe(false);
    expect(run(observed({ textHash: "same", wordCount: 850 }), base).verified).toBe(true);
  });

  it("verifies on a changed H2 set", () => {
    const base = baseline({ textHash: "same", h2: ["Sizes"] });
    const live = observed({ textHash: "same", h2: ["Sizes", "Pricing"] });
    expect(run(live, base).verified).toBe(true);
    expect(run(observed({ textHash: "same", h2: ["sizes"] }), base).verified).toBe(false);
  });

  it("verifies on the crawler's content change flag", () => {
    const base = baseline({ textHash: "same" });
    const live = observed({ textHash: "same" });
    expect(run(live, base, { titleChanged: false, contentChanged: true }).verified).toBe(true);
    expect(run(live, base).verified).toBe(false);
  });

  it("does not verify a noindex page or a failed fetch", () => {
    const base = baseline({ textHash: "old" });
    expect(run(observed({ textHash: "new", noindex: true }), base).verified).toBe(false);
    expect(run(observed({ status: 500 }), base).fetchFailed).toBe(true);
    expect(run(null, base).fetchFailed).toBe(true);
  });
});

describe("verifyLive", () => {
  it("needs a 200 without noindex", () => {
    expect(verifyLive({ observed: observed() }).verified).toBe(true);
    expect(verifyLive({ observed: observed({ noindex: true }) }).verified).toBe(false);
    expect(verifyLive({ observed: observed({ status: 404 }) }).fetchFailed).toBe(true);
    expect(verifyLive({ observed: null }).fetchFailed).toBe(true);
  });
});

describe("verifyInternalLinks", () => {
  const proposal: Extract<SeoActionProposal, { kind: "INTERNAL_LINKS" }> = {
    kind: "INTERNAL_LINKS",
    links: [
      { fromUrl: "https://example.com/a", toUrl: "https://example.com/target", anchor: "x" },
      { fromUrl: "https://example.com/b", toUrl: "https://example.com/target", anchor: "y" },
    ],
  };

  it("verifies when every source page links to the target", () => {
    const map = new Map<string, ObservedPage | null>([
      ["https://example.com/a", observed({ links: ["https://example.com/target"] })],
      ["https://example.com/b", observed({ links: ["https://example.com/target/"] })],
    ]);
    const result = verifyInternalLinks({ proposal, observedByFrom: map });
    expect(result.verified).toBe(true);
    expect(result.checks).toHaveLength(2);
  });

  it("does not verify when one link is missing", () => {
    const map = new Map<string, ObservedPage | null>([
      ["https://example.com/a", observed({ links: ["https://example.com/target"] })],
      ["https://example.com/b", observed({ links: [] })],
    ]);
    const result = verifyInternalLinks({ proposal, observedByFrom: map });
    expect(result.verified).toBe(false);
    expect(result.fetchFailed).toBe(false);
    expect(result.checks.map((c) => c.ok)).toEqual([true, false]);
  });

  it("reports a failed fetch when no page could be read", () => {
    const result = verifyInternalLinks({ proposal, observedByFrom: new Map() });
    expect(result).toMatchObject({ verified: false, fetchFailed: true, reason: "FETCH_FAILED" });
  });

  it("an empty proposal never verifies", () => {
    const empty = { kind: "INTERNAL_LINKS" as const, links: [] };
    expect(verifyInternalLinks({ proposal: empty, observedByFrom: new Map() }).verified).toBe(
      false,
    );
  });
});

describe("verifyConsolidate", () => {
  const to = "https://example.com/main";
  const base = (method: "REDIRECT" | "CANONICAL" | null) => ({
    kind: "CONSOLIDATE" as const,
    from: ["https://example.com/old"],
    to,
    method,
  });
  const redirected = observed({
    url: "https://example.com/old",
    finalUrl: to,
    hops: 1,
  });
  const canonicalized = observed({
    url: "https://example.com/old",
    finalUrl: "https://example.com/old",
    canonical: to,
  });
  const check = (method: "REDIRECT" | "CANONICAL" | null, page: ObservedPage) =>
    verifyConsolidate({
      proposal: base(method),
      observedByFrom: new Map([["https://example.com/old", page]]),
    });

  it("accepts a redirect to the main page", () => {
    expect(check("REDIRECT", redirected).verified).toBe(true);
    expect(check(null, redirected).verified).toBe(true);
    expect(check("CANONICAL", redirected).verified).toBe(false);
  });

  it("accepts a canonical to the main page", () => {
    expect(check("CANONICAL", canonicalized).verified).toBe(true);
    expect(check(null, canonicalized).verified).toBe(true);
    expect(check("REDIRECT", canonicalized).verified).toBe(false);
  });

  it("rejects an untouched page", () => {
    const untouched = observed({ url: "https://example.com/old", finalUrl: "https://example.com/old" });
    expect(check(null, untouched).verified).toBe(false);
  });
});

describe("verifyTechFix", () => {
  const tech = (issue: Extract<SeoActionProposal, { kind: "TECH_FIX" }>["issue"]) => ({
    kind: "TECH_FIX" as const,
    issue,
    issueCodes: [],
  });
  const run = (
    issue: Parameters<typeof tech>[0],
    page: ObservedPage | null,
    robotsAllowed = true,
  ) => verifyTechFix({ proposal: tech(issue), observed: page, robotsAllowed });

  it("NOINDEX", () => {
    expect(run("NOINDEX", observed()).verified).toBe(true);
    expect(run("NOINDEX", observed({ noindex: true })).verified).toBe(false);
    // Sayfa bozulduysa (404/5xx) noindex'in görünmemesi düzelme değildir.
    expect(run("NOINDEX", observed({ status: 404 })).verified).toBe(false);
    expect(run("NOINDEX", observed({ status: 503 })).verified).toBe(false);
  });

  it("STATUS", () => {
    expect(run("STATUS", observed()).verified).toBe(true);
    const gone = run("STATUS", observed({ status: 404 }));
    expect(gone.verified).toBe(false);
    expect(gone.fetchFailed).toBe(false);
  });

  it("CANONICAL needs a non-null canonical equal to the final URL", () => {
    expect(run("CANONICAL", observed({ canonical: PAGE })).verified).toBe(true);
    expect(run("CANONICAL", observed({ canonical: null })).verified).toBe(false);
    expect(run("CANONICAL", observed({ canonical: "https://example.com/other" })).verified).toBe(
      false,
    );
  });

  it("ROBOTS depends only on the robots verdict", () => {
    expect(run("ROBOTS", null, true).verified).toBe(true);
    expect(run("ROBOTS", null, false).verified).toBe(false);
    expect(run("ROBOTS", null, false).fetchFailed).toBe(false);
  });

  it("REDIRECT allows at most one hop", () => {
    expect(run("REDIRECT", observed({ hops: 1 })).verified).toBe(true);
    expect(run("REDIRECT", observed({ hops: 0 })).verified).toBe(true);
    expect(run("REDIRECT", observed({ hops: 2 })).verified).toBe(false);
    expect(run("REDIRECT", observed({ hops: 1, status: 404 })).verified).toBe(false);
  });

  it("HREFLANG and OTHER need a loading, indexable page", () => {
    expect(run("HREFLANG", observed()).verified).toBe(true);
    expect(run("OTHER", observed({ indexable: false })).verified).toBe(false);
    expect(run("OTHER", observed({ status: 500 })).verified).toBe(false);
  });

  it("a missing observation is a failed fetch", () => {
    expect(run("NOINDEX", null).fetchFailed).toBe(true);
    expect(run("NOINDEX", observed({ fetchError: "TIMEOUT", status: null })).fetchFailed).toBe(
      true,
    );
  });
});

describe("verifySchema", () => {
  const proposal = { kind: "SCHEMA" as const, types: ["FAQPage"] };
  it("needs the types and no errors", () => {
    expect(
      verifySchema({ proposal, observed: observed({ schemaTypes: ["FAQPage"] }) }).verified,
    ).toBe(true);
    expect(
      verifySchema({ proposal, observed: observed({ schemaTypes: ["faqpage"] }) }).verified,
    ).toBe(true);
    expect(verifySchema({ proposal, observed: observed() }).verified).toBe(false);
    expect(
      verifySchema({
        proposal,
        observed: observed({ schemaTypes: ["FAQPage"], schemaErrors: 2 }),
      }).verified,
    ).toBe(false);
  });

  it("without named types any structured data counts", () => {
    const open = { kind: "SCHEMA" as const, types: [] };
    expect(verifySchema({ proposal: open, observed: observed({ schemaTypes: ["Product"] }) }).verified).toBe(
      true,
    );
    expect(verifySchema({ proposal: open, observed: observed() }).verified).toBe(false);
    expect(verifySchema({ proposal, observed: null }).fetchFailed).toBe(true);
  });
});

describe("verifyAlertResolved", () => {
  const appliedAt = new Date("2026-09-01T10:00:00.000Z");
  it("is resolved only after the action was applied", () => {
    expect(
      verifyAlertResolved({
        alert: { status: "RESOLVED", resolvedAt: new Date("2026-09-02T00:00:00.000Z") },
        appliedAt,
      }).verified,
    ).toBe(true);
    expect(
      verifyAlertResolved({
        alert: { status: "RESOLVED", resolvedAt: new Date("2026-08-30T00:00:00.000Z") },
        appliedAt,
      }).verified,
    ).toBe(false);
    expect(
      verifyAlertResolved({ alert: { status: "OPEN", resolvedAt: null }, appliedAt }).verified,
    ).toBe(false);
    expect(verifyAlertResolved({ alert: null, appliedAt }).verified).toBe(false);
    expect(
      verifyAlertResolved({ alert: { status: "RESOLVED", resolvedAt: null }, appliedAt }).verified,
    ).toBe(false);
  });
});

describe("verifyCruxData", () => {
  const appliedAt = new Date("2026-09-01T00:00:00.000Z");
  it("needs a period ending at least 7 days after the change", () => {
    expect(verifyCruxData({ latestPeriodEnd: null, appliedAt }).verified).toBe(false);
    expect(
      verifyCruxData({ latestPeriodEnd: new Date("2026-09-07T23:59:59.000Z"), appliedAt })
        .verified,
    ).toBe(false);
    expect(
      verifyCruxData({ latestPeriodEnd: new Date("2026-09-08T00:00:00.000Z"), appliedAt })
        .verified,
    ).toBe(true);
  });
});

describe("verifySitemaps", () => {
  const appliedAt = new Date("2026-09-01T00:00:00.000Z");
  const after = new Date("2026-09-02T00:00:00.000Z");
  const before = new Date("2026-08-30T00:00:00.000Z");
  it("needs our own check after the change", () => {
    expect(
      verifySitemaps({ ownOk: true, checkedAt: after, appliedAt, gsc: null }).verified,
    ).toBe(true);
    expect(
      verifySitemaps({ ownOk: true, checkedAt: before, appliedAt, gsc: null }).verified,
    ).toBe(false);
    expect(
      verifySitemaps({ ownOk: false, checkedAt: after, appliedAt, gsc: null }).verified,
    ).toBe(false);
    expect(
      verifySitemaps({ ownOk: null, checkedAt: null, appliedAt, gsc: null }).verified,
    ).toBe(false);
  });

  it("counts GSC errors only for sitemaps downloaded after the change", () => {
    expect(
      verifySitemaps({
        ownOk: true,
        checkedAt: after,
        appliedAt,
        gsc: [{ errors: 3, lastDownloaded: before }],
      }).verified,
    ).toBe(true);
    const failing = verifySitemaps({
      ownOk: true,
      checkedAt: after,
      appliedAt,
      gsc: [{ errors: 3, lastDownloaded: after }],
    });
    expect(failing.verified).toBe(false);
    expect(failing.checks.find((c) => c.key === "sitemap_no_errors")?.ok).toBe(false);
  });
});

describe("googleStageOf", () => {
  const appliedAt = new Date("2026-09-01T00:00:00.000Z");
  it("is seen once Google crawled after the change", () => {
    expect(
      googleStageOf({
        inspection: { lastCrawlTime: new Date("2026-09-03T00:00:00.000Z"), verdict: "PASS" },
        appliedAt,
      }),
    ).toBe("seen");
    expect(
      googleStageOf({
        inspection: { lastCrawlTime: new Date("2026-08-20T00:00:00.000Z"), verdict: "PASS" },
        appliedAt,
      }),
    ).toBe("pending");
    expect(googleStageOf({ inspection: null, appliedAt })).toBe("pending");
    expect(
      googleStageOf({ inspection: { lastCrawlTime: null, verdict: null }, appliedAt }),
    ).toBe("pending");
  });
});
