import { describe, expect, it } from "vitest";

import type { SeoEvidence } from "@/lib/seo/opportunity-types";

import {
  actionDraftFromFinding,
  actionDraftFromHealthIssue,
  originFor,
  usableUrl,
  type FindingForDraft,
} from "./drafts";
import { HEALTH_FIX_KINDS } from "./kinds";

// Bu dosyanın kanıtladığı: bulgu ve sağlık uyarısı → eylem taslağı eşlemesi;
// maskeli adres hedef olmaz, anahtar kelime yalnız primaryKeyword'de kalır,
// ana sayfa asla varsayılmaz.

const ORIGIN = "https://example.com";

function evidence(over: Partial<SeoEvidence> = {}): SeoEvidence {
  return {
    window: { from: "2026-08-01", to: "2026-08-28" },
    metrics: {},
    pages: [
      {
        pageId: "gp1",
        path: "/blog/widgets",
        url: "https://example.com/blog/widgets",
        clicks: 10,
        impressions: 100,
        position: 5,
      },
    ],
    queries: [
      { queryId: "q1", text: "blue widgets", clicks: 1, impressions: 10, position: 6 },
      { queryId: "q2", text: "red widgets", clicks: 1, impressions: 10, position: 7 },
    ],
    ...over,
  };
}

function finding(
  actionKind: string,
  over: Partial<FindingForDraft> = {},
): FindingForDraft {
  return {
    id: "f1",
    actionKind,
    evidence: evidence(),
    pageId: "gp1",
    queryId: "q1",
    keyword: "blue widgets",
    ...over,
  };
}

describe("originFor", () => {
  it("prefers the crawler's site origin", () => {
    expect(originFor({ siteOrigin: "https://shop.example.com/x", gscSiteUrl: null })).toBe(
      "https://shop.example.com",
    );
  });

  it("reads URL-prefix and sc-domain properties", () => {
    expect(
      originFor({ siteOrigin: null, gscSiteUrl: "https://example.com/blog/" }),
    ).toBe("https://example.com");
    expect(originFor({ siteOrigin: null, gscSiteUrl: "sc-domain:Example.com" })).toBe(
      "https://example.com",
    );
  });

  it("is null when nothing is usable", () => {
    expect(originFor({ siteOrigin: null, gscSiteUrl: null })).toBeNull();
    expect(originFor({ siteOrigin: "nonsense", gscSiteUrl: "sc-domain:" })).toBeNull();
    expect(originFor({ siteOrigin: "ftp://x.com", gscSiteUrl: null })).toBeNull();
  });
});

describe("usableUrl", () => {
  it("rejects masked paths and invalid addresses", () => {
    expect(usableUrl("https://example.com/user/[id]")).toBeNull();
    expect(usableUrl("not a url")).toBeNull();
    expect(usableUrl(null)).toBeNull();
    expect(usableUrl("https://Example.com/a?utm_source=x")).toBe("https://example.com/a");
  });
});

describe("actionDraftFromFinding", () => {
  it("INVESTIGATE and unknown kinds have no draft", () => {
    expect(actionDraftFromFinding(finding("INVESTIGATE"), ORIGIN)).toBeNull();
    expect(actionDraftFromFinding(finding("WHATEVER"), ORIGIN)).toBeNull();
  });

  it("TITLE_META opens in snippet mode", () => {
    const draft = actionDraftFromFinding(finding("TITLE_META"), ORIGIN);
    expect(draft).toMatchObject({
      kind: "TITLE_META",
      targetUrl: "https://example.com/blog/widgets",
      pageId: "gp1",
      targetQueries: ["q1", "q2"],
      managerMode: "snippet",
    });
    expect(draft?.proposal).toEqual({
      kind: "TITLE_META",
      before: null,
      after: null,
      variants: [],
      v: 1,
      note: null,
      alert: null,
    });
  });

  it("CONTENT_REFRESH opens in refresh mode with the keyword in the proposal", () => {
    const draft = actionDraftFromFinding(finding("CONTENT_REFRESH"), ORIGIN);
    expect(draft?.managerMode).toBe("refresh");
    expect(draft?.proposal).toMatchObject({
      kind: "CONTENT_REFRESH",
      primaryKeyword: "blue widgets",
      missing: [],
    });
  });

  it("NEW_CONTENT and LOCALIZE keep the keyword only in primaryKeyword", () => {
    for (const kind of ["NEW_CONTENT", "LOCALIZE"]) {
      const draft = actionDraftFromFinding(
        finding(kind, { evidence: evidence({ pages: [] }) }),
        ORIGIN,
      );
      expect(draft?.managerMode).toBe("article");
      expect(draft?.targetUrl).toBeNull();
      expect(draft?.proposal).toMatchObject({
        kind,
        title: "",
        primaryKeyword: "blue widgets",
        language: null,
        liveUrl: null,
      });
      const json = JSON.stringify({
        ...draft,
        proposal: { ...draft?.proposal, primaryKeyword: undefined },
      });
      expect(json).not.toContain("blue widgets");
    }
  });

  it("a masked page URL falls back to the origin plus path, then to null", () => {
    const masked = evidence({
      pages: [
        {
          pageId: "gp2",
          path: "/blog/widgets",
          url: "https://example.com/user/[id]",
          clicks: 1,
          impressions: 1,
          position: 1,
        },
      ],
    });
    expect(
      actionDraftFromFinding(finding("TITLE_META", { evidence: masked }), ORIGIN)?.targetUrl,
    ).toBe("https://example.com/blog/widgets");
    const maskedPath = evidence({
      pages: [
        { pageId: "gp3", path: "/user/[id]", url: null, clicks: 1, impressions: 1, position: 1 },
      ],
    });
    expect(
      actionDraftFromFinding(finding("TITLE_META", { evidence: maskedPath }), ORIGIN)
        ?.targetUrl,
    ).toBeNull();
    expect(
      actionDraftFromFinding(
        finding("TITLE_META", {
          evidence: evidence({
            pages: [{ pageId: null, path: "/p", url: null, clicks: 1, impressions: 1, position: 1 }],
          }),
        }),
        null,
      )?.targetUrl,
    ).toBeNull();
  });

  it("distinct target queries are capped at ten", () => {
    const queries = Array.from({ length: 14 }, (_, i) => ({
      queryId: i % 2 === 0 ? `q${i}` : "q0",
      text: "t",
      clicks: 1,
      impressions: 1,
      position: 1,
    }));
    const draft = actionDraftFromFinding(
      finding("TITLE_META", { evidence: evidence({ queries }), queryId: null }),
      ORIGIN,
    );
    expect(draft?.targetQueries).toHaveLength(7);
    expect(new Set(draft?.targetQueries).size).toBe(7);
    const many = Array.from({ length: 20 }, (_, i) => ({
      queryId: `x${i}`,
      text: "t",
      clicks: 1,
      impressions: 1,
      position: 1,
    }));
    expect(
      actionDraftFromFinding(finding("TITLE_META", { evidence: evidence({ queries: many }) }), ORIGIN)
        ?.targetQueries,
    ).toHaveLength(10);
  });

  it("INTERNAL_LINKS builds absolute links from evidence paths", () => {
    const draft = actionDraftFromFinding(
      finding("INTERNAL_LINKS", {
        evidence: evidence({
          links: [
            { fromPath: "/a", toPath: "/blog/widgets", anchor: "blue widgets guide" },
            { fromPath: "/user/[id]", toPath: "/blog/widgets", anchor: "skipped" },
          ],
        }),
      }),
      ORIGIN,
    );
    expect(draft?.managerMode).toBeNull();
    expect(draft?.proposal).toMatchObject({
      kind: "INTERNAL_LINKS",
      links: [
        {
          fromUrl: "https://example.com/a",
          toUrl: "https://example.com/blog/widgets",
          anchor: "blue widgets guide",
        },
      ],
    });
  });

  it("CONSOLIDATE targets the first page and merges up to four others", () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({
      pageId: `gp${i}`,
      path: `/p${i}`,
      url: `https://example.com/p${i}`,
      clicks: 1,
      impressions: 1,
      position: 1,
    }));
    const draft = actionDraftFromFinding(
      finding("CONSOLIDATE", { evidence: evidence({ pages }) }),
      ORIGIN,
    );
    expect(draft?.proposal).toMatchObject({
      kind: "CONSOLIDATE",
      to: "https://example.com/p0",
      from: [
        "https://example.com/p1",
        "https://example.com/p2",
        "https://example.com/p3",
        "https://example.com/p4",
      ],
      method: null,
    });
  });

  it("TECH_FIX maps the first issue code to an issue", () => {
    const cases: [string, string][] = [
      ["TA7", "NOINDEX"],
      ["TA9", "STATUS"],
      ["TA10", "STATUS"],
      ["TA8", "CANONICAL"],
      ["TA11", "REDIRECT"],
      ["TA20", "HREFLANG"],
      ["TA3", "OTHER"],
    ];
    for (const [code, issue] of cases) {
      const draft = actionDraftFromFinding(
        finding("TECH_FIX", { evidence: evidence({ issueCodes: [code, "TA1"] }) }),
        ORIGIN,
      );
      expect(draft?.proposal).toMatchObject({
        kind: "TECH_FIX",
        issue,
        issueCodes: [code, "TA1"],
      });
    }
    const none = actionDraftFromFinding(finding("TECH_FIX"), ORIGIN);
    expect(none?.proposal).toMatchObject({ issue: "OTHER", issueCodes: [] });
  });

  it("SCHEMA starts without types", () => {
    expect(actionDraftFromFinding(finding("SCHEMA"), ORIGIN)?.proposal).toMatchObject({
      kind: "SCHEMA",
      types: [],
    });
  });
});

describe("actionDraftFromHealthIssue", () => {
  const base = {
    alertSource: "SEO" as const,
    dedupeKey: "seo:key",
    origin: ORIGIN,
    alertPaths: [] as string[],
  };

  it("only handles the listed alert kinds", () => {
    expect(actionDraftFromHealthIssue({ ...base, alertKind: "SEO_NOT_A_THING" })).toBeNull();
    for (const alertKind of Object.keys(HEALTH_FIX_KINDS)) {
      expect(actionDraftFromHealthIssue({ ...base, alertKind })).not.toBeNull();
    }
  });

  it("one alert path becomes the target for TECH_FIX and SCHEMA", () => {
    const draft = actionDraftFromHealthIssue({
      ...base,
      alertKind: "SEO_KEY_PAGE_NOINDEX",
      alertPaths: ["/pricing"],
    });
    expect(draft?.targetUrl).toBe("https://example.com/pricing");
    expect(draft?.proposal).toMatchObject({ kind: "TECH_FIX", issue: "NOINDEX" });
    const schema = actionDraftFromHealthIssue({
      ...base,
      alertKind: "SEO_STRUCTURED_DATA",
      alertPaths: ["/faq"],
    });
    expect(schema?.targetUrl).toBe("https://example.com/faq");
  });

  it("several paths or none never fall back to the homepage", () => {
    for (const alertPaths of [[], ["/a", "/b"]]) {
      const draft = actionDraftFromHealthIssue({
        ...base,
        alertKind: "SEO_KEY_PAGE_ERROR",
        alertPaths,
      });
      expect(draft?.targetUrl).toBeNull();
    }
    expect(
      actionDraftFromHealthIssue({
        ...base,
        alertKind: "SEO_KEY_PAGE_ERROR",
        alertPaths: ["/a"],
        origin: null,
      })?.targetUrl,
    ).toBeNull();
  });

  it("CWV and sitemap fixes never take a target", () => {
    for (const alertKind of ["SEO_CWV_POOR", "GSC_SITEMAP_ERRORS", "SEO_SITEMAP_MISSING"]) {
      expect(
        actionDraftFromHealthIssue({ ...base, alertKind, alertPaths: ["/a"] })?.targetUrl,
      ).toBeNull();
    }
    expect(
      actionDraftFromHealthIssue({ ...base, alertKind: "SEO_CWV_POOR" })?.proposal,
    ).toMatchObject({ kind: "CWV_FIX", metric: null, formFactor: null });
    expect(
      actionDraftFromHealthIssue({ ...base, alertKind: "GSC_SITEMAP_ERRORS" })?.proposal,
    ).toMatchObject({ kind: "SITEMAP_FIX", sitemapUrls: [] });
  });

  it("carries the alert source, kind and dedupe key", () => {
    const draft = actionDraftFromHealthIssue({
      ...base,
      alertKind: "GSC_CANONICAL_MISMATCH",
      alertSource: "GSC",
      dedupeKey: "gsc:canon:1",
    });
    expect(draft?.proposal.alert).toEqual({
      kind: "GSC_CANONICAL_MISMATCH",
      dedupeKey: "gsc:canon:1",
      source: "GSC",
    });
    expect(draft?.proposal).toMatchObject({ kind: "TECH_FIX", issue: "CANONICAL" });
    expect(draft?.managerMode).toBeNull();
  });
});
