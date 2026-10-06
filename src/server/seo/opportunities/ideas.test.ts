import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdeaConceptSchema, type SeoIdeaConcept } from "@/lib/ideas/concept";
import { SEO_RULE_LABEL } from "@/lib/seo/rules/copy";

import type { SeoFindingView } from "./findings-store";

// Bu dosyanın kanıtladığı: bayrak on değilken fırsat listesi sorgusuz boştur;
// istem satırları quick win'lerle birlikte en çok 20 farklı dizgi taşır;
// katlanmış eşleşen fikir "search" kaynağı, sabit gerekçe, güç ve şemadan
// geçen kanıt alır, eşleşmeyen değişmez; fikir bağları tekrarsız yazılır.

const mocks = vi.hoisted(() => ({
  findingFindMany: vi.fn(),
  ideaFindMany: vi.fn(),
  primaryGscLink: vi.fn(),
  setFindingOutputs: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoFinding: { findMany: mocks.findingFindMany },
    idea: { findMany: mocks.ideaFindMany },
  },
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
}));
vi.mock("./findings-store", () => ({
  findingViewOf: (row: unknown) => row,
  setFindingOutputs: mocks.setFindingOutputs,
}));
vi.mock("@/lib/app-url", () => ({
  appUrl: (path: string) => new URL(path, "https://app.example.com"),
}));

import {
  applySeoOpportunity,
  attachIdeasToFindings,
  loadSeoIdeaOpportunities,
  opportunityPromptRows,
  SEO_IDEA_OPPORTUNITY_LIMIT,
  SEO_IDEA_REASON,
  type SeoIdeaOpportunity,
} from "./ideas";

const NOW = new Date("2026-10-01T12:00:00Z");

function on(): void {
  vi.stubEnv("SEO_INSIGHTS", "on");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
}

function finding(overrides: Partial<SeoFindingView>): SeoFindingView {
  return {
    id: "f1",
    ruleKey: "SO5_CONTENT_GAP",
    kind: "OPPORTUNITY",
    status: "OPEN",
    severity: "INFO",
    confidence: "SIGNIFICANT",
    effort: "M",
    actionKind: "NEW_CONTENT",
    impact: { kind: "reach", impressionsPerMonth: 1300 },
    priority: 26,
    title: "t",
    summary: "s",
    explanation: null,
    evidence: {
      window: { from: "2026-08-31", to: "2026-09-27" },
      metrics: { impressions: 1234, clicks: 3, position: 14.26 },
    },
    periodStart: "2026-08-31",
    periodEnd: "2026-09-27",
    periodKey: "W:2026-09-27",
    pageId: null,
    queryId: "q1",
    clusterId: null,
    keyword: "Trail Running Shoes",
    ideaIds: [],
    signalId: null,
    shadow: false,
    review: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function opportunity(
  keyword: string,
  overrides: Partial<SeoIdeaOpportunity> = {},
): SeoIdeaOpportunity {
  return {
    findingId: `f-${keyword}`,
    ruleKey: "SO5_CONTENT_GAP",
    keyword,
    impressions: 900,
    position: 12.3,
    why: SEO_IDEA_REASON.SO5_CONTENT_GAP,
    strength: 3,
    evidence: [
      {
        title: "900 impressions in 4 weeks · position 12.3 (Search Console)",
        url: `https://app.example.com/projects/p1/arama?opportunity=f-${encodeURIComponent(keyword)}#opportunities`,
      },
    ],
    ...overrides,
  };
}

function seoConcept(keyword: string): SeoIdeaConcept {
  return {
    v: 2,
    module: "seo",
    source: "brand",
    draft: {
      keyword,
      intent: "informational",
      title: "A title",
      description: "A description",
      angle: "An angle",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.primaryGscLink.mockResolvedValue({ id: "link-1" });
  mocks.setFindingOutputs.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadSeoIdeaOpportunities", () => {
  it("returns [] without a database read when off or in shadow", async () => {
    vi.stubEnv("SEO_INSIGHTS", "off");
    vi.stubEnv("GSC_SYNC", "true");
    expect(await loadSeoIdeaOpportunities("p1", NOW)).toEqual([]);
    vi.stubEnv("SEO_INSIGHTS", "shadow");
    expect(await loadSeoIdeaOpportunities("p1", NOW)).toEqual([]);
    vi.stubEnv("SEO_INSIGHTS", "on");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other-project");
    expect(await loadSeoIdeaOpportunities("p1", NOW)).toEqual([]);
    expect(mocks.primaryGscLink).not.toHaveBeenCalled();
    expect(mocks.findingFindMany).not.toHaveBeenCalled();
  });

  it("reads the primary link's idea-worthy findings and builds evidence", async () => {
    on();
    mocks.findingFindMany.mockResolvedValueOnce([
      finding({}),
      finding({
        id: "f2",
        ruleKey: "SO3_CONTENT_DECAY",
        confidence: "DIRECTIONAL",
        keyword: "shoe care",
        evidence: {
          window: { from: "2026-08-31", to: "2026-09-27" },
          metrics: { recentClicks: 10, priorClicks: 40 },
          pages: [
            {
              pageId: "pg1",
              path: "/care",
              url: null,
              clicks: 10,
              impressions: 800,
              position: null,
            },
          ],
        },
      }),
    ]);
    const result = await loadSeoIdeaOpportunities("p1", NOW);
    const args = mocks.findingFindMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({
      linkId: "link-1",
      status: "OPEN",
      shadow: false,
      ideaWorthy: true,
      keyword: { not: null },
      ideaIds: { isEmpty: true },
      lastSeenAt: { gte: new Date(NOW.getTime() - 14 * 86_400_000) },
    });
    expect(args.where.ruleKey.in).toEqual([
      "SO3_CONTENT_DECAY",
      "SO5_CONTENT_GAP",
      "SO6_RISING_QUERY",
      "SO11_LOCAL_INTENT",
    ]);
    expect(args.take).toBe(SEO_IDEA_OPPORTUNITY_LIMIT);
    expect(result).toEqual([
      {
        findingId: "f1",
        ruleKey: "SO5_CONTENT_GAP",
        keyword: "Trail Running Shoes",
        impressions: 1234,
        position: 14.3,
        why: SEO_IDEA_REASON.SO5_CONTENT_GAP,
        strength: 3,
        evidence: [
          {
            title:
              "1,234 impressions in 4 weeks · position 14.3 (Search Console)",
            url: "https://app.example.com/projects/p1/arama?opportunity=f1#opportunities",
          },
        ],
      },
      {
        findingId: "f2",
        ruleKey: "SO3_CONTENT_DECAY",
        keyword: "shoe care",
        impressions: 800,
        position: null,
        why: SEO_IDEA_REASON.SO3_CONTENT_DECAY,
        strength: 2,
        evidence: [
          {
            title: "800 impressions in 4 weeks (Search Console)",
            url: "https://app.example.com/projects/p1/arama?opportunity=f2#opportunities",
          },
        ],
      },
    ]);
    for (const why of Object.values(SEO_IDEA_REASON)) {
      expect(why).not.toMatch(/\d/);
    }
  });
});

describe("opportunityPromptRows", () => {
  it("keeps distinct quick wins and keywords within 20 strings", () => {
    const alreadySent = Array.from({ length: 15 }, (_, i) => `quick ${i}`);
    const opportunities = [
      opportunity("quick 3"),
      ...Array.from({ length: 8 }, (_, i) => opportunity(`new ${i}`)),
    ];
    const rows = opportunityPromptRows(opportunities, alreadySent);
    const distinct = new Set([...alreadySent, ...rows.map((row) => row[0])]);
    expect(distinct.size).toBeLessThanOrEqual(20);
    expect(rows.map((row) => row[0])).toEqual([
      "quick 3",
      "new 0",
      "new 1",
      "new 2",
      "new 3",
      "new 4",
    ]);
    expect(rows[0]).toEqual([
      "quick 3",
      SEO_RULE_LABEL.SO5_CONTENT_GAP,
      900,
      12.3,
    ]);
  });

  it("returns no rows when the quick wins already fill the budget", () => {
    const alreadySent = Array.from({ length: 20 }, (_, i) => `quick ${i}`);
    expect(opportunityPromptRows([opportunity("new")], alreadySent)).toEqual(
      [],
    );
    expect(opportunityPromptRows([], [])).toEqual([]);
  });
});

describe("applySeoOpportunity", () => {
  it("marks a folded match as search-backed with evidence", () => {
    const opportunities = [
      opportunity("TRAİL running shoes"),
      opportunity("trail running", {
        strength: 2,
        findingId: "f-two",
      }),
    ];
    const applied = applySeoOpportunity(
      seoConcept("trail running shoes for beginners"),
      opportunities,
    );
    expect(applied).toMatchObject({
      source: "search",
      why: SEO_IDEA_REASON.SO5_CONTENT_GAP,
      strength: 3,
    });
    expect(applied.evidence).toHaveLength(2);
    expect(IdeaConceptSchema.safeParse(applied).success).toBe(true);

    // Ters yön: fikrin anahtar sözcüğü fırsatınkinin içinde.
    expect(
      applySeoOpportunity(seoConcept("Running Shoes"), [
        opportunity("best running shoes 2026"),
      ]).source,
    ).toBe("search");
  });

  it("leaves a concept without a match unchanged", () => {
    const concept = seoConcept("garden furniture");
    expect(applySeoOpportunity(concept, [opportunity("running shoes")])).toBe(
      concept,
    );
  });
});

describe("attachIdeasToFindings", () => {
  it("writes each finding's idea ids once", async () => {
    const evidence = (id: string) => [
      {
        title: "Search Console",
        url: `https://app.example.com/projects/p1/arama?opportunity=${id}#opportunities`,
      },
    ];
    mocks.ideaFindMany.mockResolvedValueOnce([
      { id: "i1", concept: { ...seoConcept("a"), evidence: evidence("f1") } },
      { id: "i2", concept: { ...seoConcept("b"), evidence: evidence("f1") } },
      { id: "i3", concept: { ...seoConcept("c"), evidence: evidence("f2") } },
      { id: "i4", concept: seoConcept("d") },
    ]);
    mocks.findingFindMany.mockResolvedValueOnce([
      { id: "f1", ideaIds: ["i1"] },
      { id: "f2", ideaIds: ["i3"] },
    ]);
    expect(
      await attachIdeasToFindings("p1", ["i1", "i2", "i3", "i4", "i1"]),
    ).toBe(1);
    expect(mocks.ideaFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["i1", "i2", "i3", "i4"] }, projectId: "p1" },
      select: { id: true, concept: true },
    });
    expect(mocks.findingFindMany.mock.calls[0]![0].where).toEqual({
      id: { in: ["f1", "f2"] },
      projectId: "p1",
    });
    expect(mocks.setFindingOutputs).toHaveBeenCalledTimes(1);
    expect(mocks.setFindingOutputs).toHaveBeenCalledWith("f1", {
      ideaIds: ["i1", "i2"],
    });
  });

  it("does nothing for no ideas", async () => {
    expect(await attachIdeasToFindings("p1", [])).toBe(0);
    expect(mocks.ideaFindMany).not.toHaveBeenCalled();
  });
});
