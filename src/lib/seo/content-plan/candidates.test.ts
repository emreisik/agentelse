import { describe, expect, it } from "vitest";

import {
  crawlPage,
  idMetric,
  page,
  pair,
  query,
  snapshotFixture,
} from "@/lib/seo/rules/test-support";

import {
  buildCandidates,
  CONFIDENCE_FACTOR,
  GAP_WEIGHT,
  INTENT_WEIGHT,
  LOW_DATA_WEB_IMPRESSIONS,
  pillarIsWeak,
  planInputFromSnapshot,
} from "./candidates";
import { keywordKey } from "./doorway";
import {
  clusterFixture,
  FIXTURE_MONTH,
  pageFixture,
  pairFixture,
  planInputFixture,
  queryFixture,
} from "./test-support";
import type { ContentPlanInput, PlanFindingRef, PlanPage } from "./types";

const byKeyword = (input: ContentPlanInput, keyword: string, kind?: string) =>
  buildCandidates(input).candidates.find(
    (candidate) => candidate.keyword === keyword && (kind === undefined || candidate.kind === kind),
  );

function finding(overrides: Partial<PlanFindingRef> = {}): PlanFindingRef {
  return {
    id: "f1",
    ruleKey: "SO5_CONTENT_GAP",
    queryId: "x1",
    clusterId: null,
    status: "OPEN",
    confidence: "DIRECTIONAL",
    ...overrides,
  };
}

// Tek kümeli küçük girdi: pillarIsWeak tablosu için.
function mini(options: {
  pillarPageId: string | null;
  pairPosition?: number | null;
  pairOnPillar?: boolean;
  pages?: PlanPage[];
  topQuery?: string;
}): ContentPlanInput {
  const pairs =
    options.pairOnPillar === false
      ? []
      : [pairFixture("m1", options.pillarPageId ?? "pp", options.pairPosition === undefined ? 5 : options.pairPosition, 800)];
  return planInputFixture({
    queries: [
      queryFixture("m1", options.topQuery ?? "alpha beta", { impressions: 800, clusterId: "cm" }),
      queryFixture("m2", "unrelated thing", { impressions: 200, clusterId: "cm" }),
    ],
    pairs,
    pages: options.pages ?? [],
    clusters: [clusterFixture("cm", "Mini", ["m1", "m2"], options.pillarPageId, { impressions: 1000 })],
  });
}

describe("lowData", () => {
  it("returns no candidates under 1,000 web impressions", () => {
    const low = buildCandidates(planInputFixture({ webImpressions28d: LOW_DATA_WEB_IMPRESSIONS - 1 }));
    expect(low).toEqual({ candidates: [], filtered: [], lowData: true, strongPillarClusterIds: [] });
    expect(buildCandidates(planInputFixture({ webImpressions28d: LOW_DATA_WEB_IMPRESSIONS })).lowData).toBe(false);
  });
});

describe("which queries never become candidates", () => {
  it("drops brand, fuzzy-brand, local, navigational and low-impression queries", () => {
    const input = planInputFixture({
      brandTerms: ["acme", "acmedental"],
      queries: [
        ...planInputFixture().queries,
        queryFixture("f1", "acmedentl prices", { impressions: 400, position: 0 }),
        queryFixture("n1", "gadget login portal", { impressions: 400, position: 0, intent: "navigational" }),
        queryFixture("e1", "scalloped garden edging", { impressions: 99, position: 0 }),
      ],
    });
    const result = buildCandidates(input);
    const keywords = result.candidates.flatMap((c) => [c.keyword, ...c.queries]);
    for (const text of ["acme dental", "dentist near me", "acmedentl prices", "gadget login portal", "scalloped garden edging"]) {
      expect(keywords).not.toContain(text);
    }
    const reasons = Object.fromEntries(result.filtered.map((item) => [item.candidateId, item.reason]));
    expect(reasons["query:b1"]).toBe("BRAND_QUERY");
    expect(reasons["query:f1"]).toBe("BRAND_QUERY");
    expect(reasons["query:l1"]).toBe("LOCAL_INTENT");
    expect(reasons["query:n1"]).toBeUndefined();
    expect(reasons["query:e1"]).toBeUndefined();
  });

  it("keeps a query at exactly 100 impressions", () => {
    const input = planInputFixture({
      queries: [queryFixture("e1", "scalloped garden edging", { impressions: 100, position: 0 })],
      pairs: [],
      clusters: [],
    });
    expect(byKeyword(input, "scalloped garden edging")).toBeDefined();
  });

  it("never makes a candidate of a query that carries an email or a phone number", () => {
    const input = planInputFixture({
      queries: [
        queryFixture("p1", "scalloped edging jane.doe@example.com", { impressions: 400, position: 0 }),
        queryFixture("p2", "scalloped edging call +1 415 555 0123", { impressions: 400, position: 0 }),
        queryFixture("p3", "scalloped garden edging", { impressions: 400, position: 0 }),
      ],
      pairs: [],
      clusters: [],
    });
    const texts = buildCandidates(input).candidates.flatMap((c) => [c.keyword, ...c.queries]);
    expect(texts).toContain("scalloped garden edging");
    expect(texts.some((text) => text.includes("@") || text.includes("+1"))).toBe(false);
  });

  it("resolves a missing intent by rule: navigational is never produced for non-brand", () => {
    const input = planInputFixture({
      queries: [queryFixture("e1", "scalloped garden edging price", { impressions: 400 })],
      pairs: [],
      clusters: [],
    });
    expect(byKeyword(input, "scalloped garden edging price")?.intent).toBe("transactional");
  });

  it("excludes subjects of a DISMISSED finding (query or cluster) and earlier rejections", () => {
    const base = planInputFixture();
    const dismissedQuery = planInputFixture({
      findings: [finding({ id: "d1", queryId: "x1", status: "DISMISSED" })],
    });
    expect(byKeyword(dismissedQuery, "invisalign vs braces")).toBeUndefined();
    expect(buildCandidates(dismissedQuery).filtered).toContainEqual({
      candidateId: "query:x1",
      reason: "DISMISSED_FINDING",
    });
    const dismissedCluster = planInputFixture({
      findings: [finding({ id: "d2", queryId: null, clusterId: "c-weak", status: "DISMISSED" })],
    });
    const clusterResult = buildCandidates(dismissedCluster);
    expect(clusterResult.candidates.some((c) => c.clusterId === "c-weak")).toBe(false);
    expect(clusterResult.filtered.filter((f) => f.reason === "DISMISSED_FINDING")).toHaveLength(3);
    expect(byKeyword(base, "invisalign vs braces")).toBeDefined();

    const rejected = planInputFixture({ rejectedKeys: [keywordKey("invisalign vs braces")] });
    expect(byKeyword(rejected, "invisalign vs braces")).toBeUndefined();
    expect(buildCandidates(rejected).filtered).toContainEqual({
      candidateId: "query:x1",
      reason: "REJECTED_BEFORE",
    });
  });
});

describe("topics that already have a page", () => {
  it("never makes a candidate of a topic ranking in the top 20", () => {
    const result = buildCandidates(planInputFixture());
    const keywords = result.candidates.map((c) => c.keyword);
    expect(keywords).not.toContain("dental implants cost");
    expect(keywords).not.toContain("dental implants price");
    expect(result.filtered).toContainEqual({ candidateId: "query:q1", reason: "EXISTING_PAGE" });
    const at20 = planInputFixture({
      queries: [queryFixture("e1", "scalloped garden edging", { impressions: 400 })],
      pairs: [pairFixture("e1", "p-strong", 20)],
      clusters: [],
    });
    expect(byKeyword(at20, "scalloped garden edging")).toBeUndefined();
    const at21 = planInputFixture({
      queries: [queryFixture("e1", "scalloped garden edging", { impressions: 400 })],
      pairs: [pairFixture("e1", "p-strong", 21)],
      clusters: [],
    });
    expect(byKeyword(at21, "scalloped garden edging")).toBeDefined();
  });

  it("treats a pair without a position as no page", () => {
    const input = planInputFixture({
      queries: [queryFixture("e1", "scalloped garden edging", { impressions: 400 })],
      pairs: [pairFixture("e1", "p-strong", null)],
      clusters: [],
    });
    expect(byKeyword(input, "scalloped garden edging")).toBeDefined();
  });

  it("skips a topic whose page title or H1 already covers it", () => {
    const input = planInputFixture({
      pages: [
        ...planInputFixture().pages,
        pageFixture("p-brace", "/orthodontics", { title: "Invisalign vs braces compared", h1: null }),
      ],
    });
    expect(byKeyword(input, "invisalign vs braces")).toBeUndefined();
  });
});

describe("pillarIsWeak", () => {
  const strongPage = pageFixture("pp", "/pillar", { title: "Alpha beta guide", h1: null });

  it("is weak without a pillar page id", () => {
    expect(pillarIsWeak(mini({ pillarPageId: null }).clusters[0]!, mini({ pillarPageId: null }))).toBe(true);
  });

  it("is weak when the weighted position is worse than 20, not at 20", () => {
    for (const [position, weak] of [[20, false], [20.5, true], [21, true], [5, false]] as const) {
      const input = mini({ pillarPageId: "pp", pairPosition: position, pages: [strongPage] });
      expect(pillarIsWeak(input.clusters[0]!, input)).toBe(weak);
    }
  });

  it("is weak with no query-page pair on the pillar", () => {
    const input = mini({ pillarPageId: "pp", pairOnPillar: false, pages: [strongPage] });
    expect(pillarIsWeak(input.clusters[0]!, input)).toBe(true);
    const nullPosition = mini({ pillarPageId: "pp", pairPosition: null, pages: [strongPage] });
    expect(pillarIsWeak(nullPosition.clusters[0]!, nullPosition)).toBe(true);
  });

  it("weights the position by impressions", () => {
    const input = planInputFixture({
      queries: [
        queryFixture("m1", "alpha beta", { impressions: 900, clusterId: "cm" }),
        queryFixture("m2", "alpha gamma", { impressions: 100, clusterId: "cm" }),
      ],
      pairs: [pairFixture("m1", "pp", 3, 900), pairFixture("m2", "pp", 90, 100)],
      pages: [strongPage],
      clusters: [clusterFixture("cm", "Mini", ["m1", "m2"], "pp", { impressions: 1000 })],
    });
    // (3*900 + 90*100) / 1000 = 11.7
    expect(pillarIsWeak(input.clusters[0]!, input)).toBe(false);
  });

  it("is weak when fewer than half of the top query's tokens are in title and H1", () => {
    const half = mini({
      pillarPageId: "pp",
      topQuery: "alpha beta gamma delta",
      pages: [pageFixture("pp", "/pillar", { title: "Alpha beta", h1: null })],
    });
    expect(pillarIsWeak(half.clusters[0]!, half)).toBe(false);
    const third = mini({
      pillarPageId: "pp",
      topQuery: "alpha beta gamma",
      pages: [pageFixture("pp", "/pillar", { title: "Alpha only", h1: null })],
    });
    expect(pillarIsWeak(third.clusters[0]!, third)).toBe(true);
    const viaH1 = mini({
      pillarPageId: "pp",
      topQuery: "alpha beta gamma delta",
      pages: [pageFixture("pp", "/pillar", { title: "Alpha", h1: "Beta" })],
    });
    expect(pillarIsWeak(viaH1.clusters[0]!, viaH1)).toBe(false);
  });

  it("unknown facts never make a pillar weak by the coverage test", () => {
    const noPage = mini({ pillarPageId: "pp", pages: [] });
    expect(pillarIsWeak(noPage.clusters[0]!, noPage)).toBe(false);
    const noTitle = mini({ pillarPageId: "pp", pages: [pageFixture("pp", "/pillar", { title: null, h1: null })] });
    expect(pillarIsWeak(noTitle.clusters[0]!, noTitle)).toBe(false);
  });
});

describe("pillar and support candidates", () => {
  it("gives a weak-pillar cluster exactly one PILLAR plus its sub-topics", () => {
    const result = buildCandidates(planInputFixture());
    const weak = result.candidates.filter((c) => c.clusterId === "c-weak");
    expect(weak.filter((c) => c.kind === "PILLAR")).toHaveLength(1);
    const pillar = weak.find((c) => c.kind === "PILLAR")!;
    expect(pillar).toMatchObject({
      keyword: "teeth whitening at home",
      gap: "NO_PILLAR",
      impressions: 3700,
      clusterName: "Teeth whitening",
    });
    expect(pillar.queries).toEqual(["whitening strips review", "how to whiten teeth fast"]);
    expect(weak.filter((c) => c.kind === "SUPPORT").map((c) => c.keyword).sort()).toEqual([
      "how to whiten teeth fast",
      "teeth whitening at home",
      "whitening strips review",
    ]);
    expect(result.candidates.every((c) => c.kind === "SUPPORT" || c.clusterId === "c-weak")).toBe(true);
  });

  it("gives a strong cluster SUPPORT candidates only and lists it as strong", () => {
    const result = buildCandidates(planInputFixture());
    expect(result.strongPillarClusterIds).toEqual(["c-strong"]);
    const strong = result.candidates.filter((c) => c.clusterId === "c-strong");
    expect(strong.map((c) => c.kind)).toEqual(["SUPPORT"]);
    expect(strong[0]).toMatchObject({ keyword: "implants aftercare tips", gap: "NO_PAGE", position: 35 });
  });

  it("makes clusterless queries their own SUPPORT candidates", () => {
    const candidate = byKeyword(planInputFixture(), "invisalign vs braces")!;
    expect(candidate).toMatchObject({
      kind: "SUPPORT",
      clusterId: null,
      clusterName: null,
      position: null,
      bestPageId: null,
      intent: "commercial",
    });
    expect(candidate.id).toBe("SUPPORT:q:braces invisalign");
  });

  it("skips the PILLAR when its top query already has a page", () => {
    const input = planInputFixture({
      pairs: planInputFixture().pairs.map((p) => (p.queryId === "w1" ? { ...p, position: 8 } : p)),
      clusters: [
        clusterFixture("c-weak", "Teeth whitening", ["w1", "w2", "w3"], null, { impressions: 3700 }),
      ],
    });
    expect(buildCandidates(input).candidates.some((c) => c.kind === "PILLAR")).toBe(false);
  });

  it("groups sub-topics at Jaccard >= 0.6, greedily by impressions", () => {
    const input = planInputFixture({
      queries: [
        queryFixture("g1", "alpha beta gamma delta", { impressions: 900, clusterId: "cg" }),
        queryFixture("g2", "alpha beta gamma delta epsilon", { impressions: 500, clusterId: "cg" }),
        queryFixture("g3", "alpha beta gamma delta zeta", { impressions: 400, clusterId: "cg" }),
        queryFixture("g4", "alpha beta gamma delta eta", { impressions: 300, clusterId: "cg" }),
        queryFixture("g5", "alpha beta gamma delta theta", { impressions: 200, clusterId: "cg" }),
        queryFixture("g6", "omega sigma tau", { impressions: 250, clusterId: "cg" }),
      ],
      pairs: [],
      pages: [],
      clusters: [clusterFixture("cg", "Group", ["g1", "g2", "g3", "g4", "g5", "g6"], "none", { impressions: 2550 })],
    });
    const result = buildCandidates(input).candidates.filter((c) => c.kind === "SUPPORT");
    expect(result).toHaveLength(2);
    const main = result.find((c) => c.keyword === "alpha beta gamma delta")!;
    expect(main.impressions).toBe(900 + 500 + 400 + 300 + 200);
    expect(main.queries).toEqual([
      "alpha beta gamma delta epsilon",
      "alpha beta gamma delta zeta",
      "alpha beta gamma delta eta",
    ]);
    expect(main.queryIds).toEqual(["g1", "g2", "g3", "g4"]);
    expect(result.find((c) => c.keyword === "omega sigma tau")?.impressions).toBe(250);
  });

  it("does not group sub-topics just below 0.6", () => {
    const input = planInputFixture({
      queries: [
        queryFixture("g1", "alpha beta gamma delta", { impressions: 900, clusterId: "cg" }),
        // 4 ortak / 7 birleşim = 0.571
        queryFixture("g2", "alpha beta gamma delta epsilon zeta eta", { impressions: 500, clusterId: "cg" }),
      ],
      pairs: [],
      pages: [],
      clusters: [clusterFixture("cg", "Group", ["g1", "g2"], "none", { impressions: 1400 })],
    });
    expect(buildCandidates(input).candidates.filter((c) => c.kind === "SUPPORT")).toHaveLength(2);
  });

  it("uses a query's own clusterId when the cluster list omits it", () => {
    const input = planInputFixture({
      queries: [queryFixture("g1", "alpha beta gamma delta", { impressions: 900, clusterId: "cg" })],
      pairs: [],
      pages: [],
      clusters: [clusterFixture("cg", "Group", [], "none")],
    });
    expect(byKeyword(input, "alpha beta gamma delta")?.clusterId).toBe("cg");
  });
});

describe("scoring", () => {
  it("scores a clusterless query without a finding as share x gap x intent x 0.8", () => {
    const candidate = byKeyword(planInputFixture(), "invisalign vs braces")!;
    const share = 600 / 45_000;
    expect(candidate.share).toBeCloseTo(share, 12);
    expect(candidate.score).toBe(Math.round(share * GAP_WEIGHT.NO_PAGE * INTENT_WEIGHT.commercial * CONFIDENCE_FACTOR.NONE * 1e6) / 1e6);
    expect(candidate.score).toBe(0.0128);
    // 0.64 değil: ek kümesiz çarpanı yok
    expect(candidate.score).not.toBeCloseTo(0.0102, 3);
  });

  it("scores a PILLAR with the 1.3 gap weight", () => {
    const pillar = buildCandidates(planInputFixture()).candidates.find((c) => c.kind === "PILLAR")!;
    expect(pillar.score).toBeCloseTo((3700 / 45_000) * 1.3 * 1.0 * 0.8, 6);
  });

  it("uses the non-brand impressions for the share", () => {
    const half = byKeyword(planInputFixture({ nonBrandImpressions: 90_000 }), "invisalign vs braces")!;
    expect(half.share).toBeCloseTo(600 / 90_000, 12);
    expect(half.score).toBe(0.0064);
  });

  it("applies the finding confidence factor and annotates the finding", () => {
    const directional = byKeyword(planInputFixture({ findings: [finding()] }), "invisalign vs braces")!;
    expect(directional).toMatchObject({ findingId: "f1", findingConfidence: "DIRECTIONAL" });
    expect(directional.score).toBe(Math.round((600 / 45_000) * 1.2 * 0.85 * 1e6) / 1e6);
    const significant = byKeyword(
      planInputFixture({ findings: [finding({ confidence: "SIGNIFICANT" })] }),
      "invisalign vs braces",
    )!;
    expect(significant.score).toBe(Math.round((600 / 45_000) * 1.2 * 1e6) / 1e6);
  });

  it("matches a cluster-level finding to the cluster's candidates and prefers SIGNIFICANT", () => {
    const input = planInputFixture({
      findings: [
        finding({ id: "fa", queryId: null, clusterId: "c-strong" }),
        finding({ id: "fb", queryId: null, clusterId: "c-strong", confidence: "SIGNIFICANT" }),
        finding({ id: "fc", queryId: null, clusterId: "c-strong", status: "ACCEPTED" }),
        finding({ id: "fd", queryId: "x1", ruleKey: "SO6_RISING_QUERY", status: "ACCEPTED" }),
      ],
    });
    expect(byKeyword(input, "implants aftercare tips")?.findingId).toBe("fb");
    expect(byKeyword(input, "invisalign vs braces")?.findingId).toBe("fd");
  });

  it("flags rising queries and applies the 1.25 bonus", () => {
    const week = "2026-09-21";
    const mk = (overrides: Parameters<typeof queryFixture>[2]) =>
      byKeyword(
        planInputFixture({
          queries: [queryFixture("e1", "scalloped garden edging", { impressions: 400, ...overrides })],
          pairs: [],
          clusters: [],
          week,
        }),
        "scalloped garden edging",
      )!;
    expect(mk({ previousImpressions: 200 }).rising).toBe(true);
    expect(mk({ previousImpressions: 201 }).rising).toBe(false);
    expect(mk({ previousImpressions: 0 }).rising).toBe(false);
    expect(mk({ previousImpressions: null }).rising).toBe(false);
    // week - 27 gün = 2026-08-25
    expect(mk({ firstSeenWeek: "2026-08-25" }).rising).toBe(true);
    expect(mk({ firstSeenWeek: "2026-08-24" }).rising).toBe(false);
    const rising = mk({ previousImpressions: 100 });
    expect(rising.score).toBe(Math.round((400 / 45_000) * 1.25 * 0.8 * 1e6) / 1e6);
  });

  it("deprioritises earlier plan keywords by half", () => {
    const normal = byKeyword(planInputFixture(), "invisalign vs braces")!;
    const deprioritised = byKeyword(
      planInputFixture({ deprioritizedKeys: [keywordKey("invisalign vs braces")] }),
      "invisalign vs braces",
    )!;
    expect(deprioritised.score).toBeCloseTo(normal.score / 2, 6);
  });

  it("rounds the score to six decimals", () => {
    for (const candidate of buildCandidates(planInputFixture()).candidates) {
      expect(candidate.score).toBe(Math.round(candidate.score * 1e6) / 1e6);
    }
  });
});

describe("reuse of pool ideas", () => {
  const idea = (keyword: string) => ({
    id: "idea-1",
    keyword,
    title: keyword,
    angle: "",
    description: "",
    intent: null,
  });
  const input = (poolKeyword: string) =>
    planInputFixture({
      queries: [queryFixture("e1", "alpha beta gamma delta", { impressions: 400 })],
      pairs: [],
      clusters: [],
      poolIdeas: [idea(poolKeyword)],
    });

  it("reuses at Jaccard 0.8 and not below", () => {
    expect(byKeyword(input("alpha beta gamma delta epsilon"), "alpha beta gamma delta")?.reuseIdeaId).toBe("idea-1");
    expect(byKeyword(input("alpha beta gamma delta epsilon zeta"), "alpha beta gamma delta")?.reuseIdeaId).toBeNull();
  });

  it("picks the closest idea, ties by id", () => {
    const both = planInputFixture({
      queries: [queryFixture("e1", "alpha beta gamma delta", { impressions: 400 })],
      pairs: [],
      clusters: [],
      poolIdeas: [
        { ...idea("alpha beta gamma delta epsilon"), id: "b" },
        { ...idea("alpha beta gamma delta"), id: "z" },
        { ...idea("alpha beta gamma delta"), id: "a" },
      ],
    });
    expect(byKeyword(both, "alpha beta gamma delta")?.reuseIdeaId).toBe("a");
  });
});

describe("ordering and stability", () => {
  it("sorts by score then id and is stable across runs and input order", () => {
    const input = planInputFixture();
    const first = buildCandidates(input);
    const scores = first.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(buildCandidates(planInputFixture())).toEqual(first);
    const shuffled = planInputFixture({ queries: [...input.queries].reverse(), pairs: [...input.pairs].reverse() });
    expect(buildCandidates(shuffled).candidates.map((c) => c.id)).toEqual(first.candidates.map((c) => c.id));
  });

  it("builds ids from kind, cluster and the keyword key", () => {
    const ids = buildCandidates(planInputFixture()).candidates.map((c) => c.id);
    expect(ids).toContain("PILLAR:c-weak:home teeth whitening");
    expect(ids).toContain("SUPPORT:c-strong:aftercare implants tips");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not mutate the input", () => {
    const input = planInputFixture();
    const copy = JSON.parse(JSON.stringify(input));
    buildCandidates(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(copy);
  });
});

describe("planInputFromSnapshot", () => {
  const snapshot = snapshotFixture({
    queries: [
      query("q1", "blue widget repair", { impressions: 400, clicks: 4, position: 30, clusterId: "c1" }),
      query("q2", "widget repair cost", { impressions: 300, position: 8, clusterId: "c1" }),
      query("q3", "acme widgets", { impressions: 900, isBrand: true, intent: "navigational", position: 1 }),
      query("q4", "odd intent", { impressions: 100, intent: "weird" }),
    ],
    previousQueries: [idMetric("q1", { impressions: 150 })],
    pages: [page("p1", "/repair", { impressions: 700, clicks: 9, position: 8 })],
    pairs: [pair("q2", "p1", { impressions: 300, position: 8, clicks: 3 })],
    clusters: [{ clusterId: "c1", name: "Widget repair", queryIds: ["q1", "q2", "gone"], pillarPageId: "p1" }],
    crawl: {
      complete: false,
      pages: [
        crawlPage("p1", "/repair", { title: "Widget repair", h1: ["Repair"], h2: ["How"], inlinks: 7 }),
        crawlPage(null, "/about", { title: "About" }),
      ],
      links: [
        { fromPageId: "p1", fromPath: "/repair", toPageId: "p9", toPath: "/x" },
        { fromPageId: null, fromPath: "/a", toPageId: "p1", toPath: "/repair" },
      ],
    },
  });
  const extras = {
    month: FIXTURE_MONTH,
    findings: [],
    existingTitles: ["T"],
    existingKeywords: ["K"],
    poolIdeas: [],
    rejectedKeys: ["r"],
    deprioritizedKeys: ["d"],
  };

  it("maps queries, pairs, clusters and totals", () => {
    const input = planInputFromSnapshot(snapshot, extras);
    expect(input).toMatchObject({
      week: "2026-09-21",
      month: "2026-10",
      webImpressions28d: 50_000,
      nonBrandImpressions: 45_000,
      brandTerms: ["acme"],
      hasCrawl: true,
      crawlComplete: false,
      existingTitles: ["T"],
      existingKeywords: ["K"],
      rejectedKeys: ["r"],
      deprioritizedKeys: ["d"],
    });
    const q1 = input.queries.find((q) => q.queryId === "q1")!;
    expect(q1).toMatchObject({ position: 30, previousImpressions: 150, clusterId: "c1", intent: null });
    expect(input.queries.find((q) => q.queryId === "q2")!.previousImpressions).toBe(0);
    expect(input.queries.find((q) => q.queryId === "q3")).toMatchObject({ isBrand: true, intent: "navigational" });
    expect(input.queries.find((q) => q.queryId === "q4")!.intent).toBeNull();
    expect(input.pairs).toEqual([{ queryId: "q2", pageId: "p1", impressions: 300, clicks: 3, position: 8 }]);
    expect(input.clusters).toEqual([
      { id: "c1", name: "Widget repair", pillarPageId: "p1", queryIds: ["q1", "q2", "gone"], impressions: 700, clicks: 4 },
    ]);
  });

  it("merges crawl facts into pages and keeps crawl-only pages", () => {
    const input = planInputFromSnapshot(snapshot, extras);
    const repair = input.pages.find((p) => p.pageId === "p1")!;
    expect(repair).toMatchObject({
      url: "https://example.com/repair",
      title: "Widget repair",
      h1: "Repair",
      h2: ["How"],
      inlinks: 7,
      impressions: 700,
      indexable: true,
      status: 200,
      isHomepage: false,
    });
    const about = input.pages.find((p) => p.path === "/about")!;
    expect(about).toMatchObject({ pageId: null, impressions: 0, title: "About" });
    expect(input.pages).toHaveLength(2);
  });

  it("keeps only crawl links whose pages are both known", () => {
    expect(planInputFromSnapshot(snapshot, extras).links).toEqual([{ fromPageId: "p1", toPageId: "p9" }]);
  });

  it("handles no crawl and incomplete history", () => {
    const bare = planInputFromSnapshot(
      snapshotFixture({
        previousComplete: false,
        crawl: null,
        pages: [page("p1", "/", { impressions: 10 })],
        queries: [query("q1", "alpha beta", { impressions: 400 })],
        totals: { clicks: 1, impressions: 5000, nonBrandClicks: null, nonBrandImpressions: null },
      }),
      extras,
    );
    expect(bare.hasCrawl).toBe(false);
    expect(bare.crawlComplete).toBe(false);
    expect(bare.queries[0]!.previousImpressions).toBeNull();
    expect(bare.nonBrandImpressions).toBe(5000);
    expect(bare.pages[0]).toMatchObject({ title: null, h1: null, inlinks: null, indexable: null, isHomepage: true });
  });

  it("feeds buildCandidates", () => {
    const input = planInputFromSnapshot(
      snapshotFixture({
        queries: [query("q1", "blue widget repair", { impressions: 300, position: 30 })],
      }),
      extras,
    );
    expect(buildCandidates(input).candidates.map((c) => c.keyword)).toEqual(["blue widget repair"]);
  });
});
