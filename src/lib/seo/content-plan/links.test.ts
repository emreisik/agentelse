import { describe, expect, it } from "vitest";

import { ANCHOR_MAX, anchorFor, planInternalLinks } from "./links";
import { pageFixture, pairFixture } from "./test-support";
import type { PlanPage } from "./types";

const PAGES: PlanPage[] = [
  pageFixture("home", "/", { title: "Acme Dental", impressions: 5000, inlinks: 80 }),
  pageFixture("pillar", "/services/dental-implants", {
    title: "Dental implants guide",
    h1: "Dental implants",
    impressions: 5400,
    inlinks: 25,
  }),
  pageFixture("care", "/blog/implant-care", {
    title: "Caring for new implants",
    impressions: 800,
    inlinks: 6,
  }),
  pageFixture("tips", "/blog/dental-tips", {
    title: "Dental tips for every week",
    impressions: 600,
    inlinks: 9,
  }),
  pageFixture("aftercare", "/blog/aftercare-basics", {
    title: "Aftercare basics",
    impressions: 400,
    inlinks: 3,
  }),
  pageFixture("recovery", "/blog/implants-recovery", {
    title: "Implants recovery timeline",
    impressions: 300,
    inlinks: 2,
  }),
  pageFixture("contact", "/contact", { title: "Contact us", impressions: 0, inlinks: 0 }),
];

const PAIRS = [
  pairFixture("q1", "pillar", 4, 3000),
  pairFixture("q3", "pillar", 35, 900),
  pairFixture("q3", "care", 40, 100),
];

function base(overrides: Partial<Parameters<typeof planInternalLinks>[0]> = {}) {
  return {
    keyword: "implants aftercare tips",
    queries: ["aftercare for implants"],
    kind: "SUPPORT" as const,
    clusterId: "c-strong",
    pillarPageId: "pillar",
    clusterQueryIds: ["q1", "q2", "q3"],
    pages: PAGES,
    pairs: PAIRS,
    hasCrawl: true,
    crawlComplete: true,
    ...overrides,
  };
}

describe("anchorFor", () => {
  it("uses the exact keyword first, then varies", () => {
    const taken = new Set<string>();
    const first = anchorFor("dental implants cost", "Costs", taken, ["implant prices"]);
    expect(first).toBe("dental implants cost");
    taken.add("dental implants cost");
    const second = anchorFor("dental implants cost", "Costs", taken, ["implant prices"]);
    expect(second).toBe("implant prices");
    taken.add("implant prices");
    const third = anchorFor("dental implants cost", "Costs", taken, ["implant prices"]);
    expect(third).toBe("implants cost");
  });

  it("clips long text to 60 characters and compares folded", () => {
    const long = "word ".repeat(30).trim();
    expect(Array.from(anchorFor(long, null, new Set())).length).toBeLessThanOrEqual(ANCHOR_MAX);
    expect(anchorFor("Diş Beyazlatma", "x", new Set(["dis beyazlatma"]))).toBe("x");
  });

  it("returns the keyword when everything is taken", () => {
    expect(anchorFor("alpha", null, new Set(["alpha"]))).toBe("alpha");
    expect(anchorFor("", null, new Set())).toBe("");
  });
});

describe("planInternalLinks", () => {
  it("puts a strong pillar first with the pillar role, in both directions", () => {
    const result = planInternalLinks(base());
    expect(result.linkFrom[0]).toMatchObject({ path: "/services/dental-implants", role: "pillar" });
    expect(result.linkTo[0]).toMatchObject({ path: "/services/dental-implants", role: "pillar" });
    expect(result.linkFrom.length).toBeLessThanOrEqual(4);
    expect(result.linkTo.length).toBeLessThanOrEqual(3);
    expect(result.linkFrom.filter((l) => l.role === "pillar")).toHaveLength(1);
    expect(result.verified).toBe(true);
  });

  it("links to related pages that are not already link sources", () => {
    const result = planInternalLinks(base());
    const fromPaths = new Set(result.linkFrom.map((l) => l.path));
    for (const link of result.linkTo.filter((l) => l.role === "related")) {
      expect(fromPaths.has(link.path)).toBe(false);
    }
    expect(result.linkTo.filter((l) => l.role === "related").length).toBeLessThanOrEqual(2);
  });

  it("without a pillar page there is no pillar link", () => {
    const result = planInternalLinks(base({ pillarPageId: null }));
    expect([...result.linkFrom, ...result.linkTo].some((l) => l.role === "pillar")).toBe(false);
  });

  it("a PILLAR article takes related pages only and ignores pillarPageId", () => {
    const result = planInternalLinks(base({ kind: "PILLAR" }));
    expect([...result.linkFrom, ...result.linkTo].some((l) => l.role === "pillar")).toBe(false);
    expect(result.linkFrom.length).toBeLessThanOrEqual(4);
    expect(result.linkTo.length).toBeLessThanOrEqual(3);
    expect(result.linkFrom.length).toBeGreaterThan(0);
  });

  it("is unverified without a crawl or with an incomplete one", () => {
    expect(planInternalLinks(base({ hasCrawl: false, crawlComplete: false })).verified).toBe(false);
    expect(planInternalLinks(base({ hasCrawl: true, crawlComplete: false })).verified).toBe(false);
  });

  it("works from search data only (no crawl facts)", () => {
    const gscOnly = PAGES.map((page) => ({ ...page, inlinks: null, indexable: null, status: null }));
    const result = planInternalLinks(base({ pages: gscOnly, hasCrawl: false, crawlComplete: false }));
    expect(result.verified).toBe(false);
    expect(result.linkFrom.length).toBeGreaterThan(0);
  });

  it("varies anchors: unique, within 60 characters, one exact match", () => {
    const result = planInternalLinks(base({ keyword: "implants aftercare tips" }));
    const anchors = result.linkFrom.map((l) => l.anchor);
    expect(new Set(anchors.map((a) => a.toLowerCase())).size).toBe(anchors.length);
    for (const anchor of [...anchors, ...result.linkTo.map((l) => l.anchor)]) {
      expect(Array.from(anchor).length).toBeLessThanOrEqual(ANCHOR_MAX);
      expect(anchor.length).toBeGreaterThan(0);
    }
    expect(anchors.filter((a) => a === "implants aftercare tips")).toHaveLength(1);
    expect(anchors[0]).toBe("implants aftercare tips");
  });

  it("anchors of linkTo describe the target page", () => {
    const result = planInternalLinks(base());
    expect(result.linkTo[0]!.anchor).toBe("Dental implants guide");
  });

  it("excludes the homepage unless it is the only page", () => {
    expect(planInternalLinks(base()).linkFrom.some((l) => l.path === "/")).toBe(false);
    const onlyHome = planInternalLinks(base({ pages: [PAGES[0]!], pillarPageId: null }));
    expect(onlyHome.linkFrom.map((l) => l.path)).toEqual(["/"]);
  });

  it("excludes noindex, non-indexable and non-200 pages", () => {
    const pages = PAGES.map((page) =>
      page.pageId === "care"
        ? { ...page, noindex: true }
        : page.pageId === "tips"
          ? { ...page, status: 404 }
          : page.pageId === "recovery"
            ? { ...page, indexable: false }
            : page,
    );
    const result = planInternalLinks(base({ pages }));
    const paths = [...result.linkFrom, ...result.linkTo].map((l) => l.path);
    for (const excluded of ["/blog/implant-care", "/blog/dental-tips", "/blog/implants-recovery"]) {
      expect(paths).not.toContain(excluded);
    }
  });

  it("drops pages with a score below the minimum", () => {
    const result = planInternalLinks(base());
    expect([...result.linkFrom, ...result.linkTo].map((l) => l.path)).not.toContain("/contact");
  });

  it("is deterministic and independent of the page order", () => {
    const forward = planInternalLinks(base());
    const reversed = planInternalLinks(base({ pages: [...PAGES].reverse() }));
    expect(reversed).toEqual(forward);
    expect(planInternalLinks(base())).toEqual(forward);
  });

  it("returns empty links for no pages", () => {
    expect(planInternalLinks(base({ pages: [] }))).toEqual({ linkFrom: [], linkTo: [], verified: true });
  });
});
