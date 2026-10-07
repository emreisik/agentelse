import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  getBrandTwin: vi.fn(),
  loadBrandRules: vi.fn(),
}));

vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run, isMockMode: () => false },
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({
  getBrandTwin: mocks.getBrandTwin,
}));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: async () => "en",
}));
vi.mock("@/server/works/brand-rule-loader", () => ({
  loadBrandRules: mocks.loadBrandRules,
}));
vi.mock("@/lib/seo/actions/learning-prompt", () => ({
  seoLearningsPromptLine: () => null,
}));

import type { SeoTarget } from "@/lib/module-flows/seo/state";

import { SEO_REFRESH_COPY, runSeoRefreshResearch } from "./refresh";

const SCOPE = { workspaceId: "ws1", projectId: "p1", brandId: "b1" };
const BRIEF = {
  topic: "Running shoes",
  siteUrl: "https://example.com",
  language: "en",
  audience: "",
};
const TARGET: SeoTarget = {
  url: "https://example.com/blog/shoes",
  path: "/blog/shoes",
  title: "Running shoes",
  metaDescription: "Old meta.",
  h1: "Running shoes",
  h2: ["Fit", "Care"],
  wordCount: 800,
  textHash: "h",
  fetchedAt: "2026-10-05T09:00:00.000Z",
  queryCount: 12,
};
const ANSWER = {
  primaryKeyword: "running shoes",
  secondaryKeywords: ["best running shoes"],
  searchIntent: "commercial",
  intentNote: "They compare.",
  titleOptions: ["How to choose running shoes for your first race"],
  metaDescription: "Meta.",
  outline: [
    { h2: "Fit", points: [] },
    { h2: "Care", points: [] },
    { h2: "Sizing", points: [] },
  ],
  missingSubtopics: ["Sizing", " sizing ", "", "Width"],
  keep: ["Fit", "Care"],
};
const QUERIES = Array.from({ length: 13 }, (_, i) => ({
  text: `query ${i}`,
  impressions: 50,
  clicks: 2,
  position: 9,
}));

function input(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    brief: BRIEF,
    target: TARGET,
    pageText: "The page's own text.",
    queries: QUERIES,
    learnings: [],
    now: new Date("2026-10-05T10:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getBrandTwin.mockResolvedValue(null);
  mocks.loadBrandRules.mockResolvedValue(null);
  mocks.run.mockResolvedValue({
    output: ANSWER,
    isMock: false,
    reasoningCallId: "r",
  });
});

describe("runSeoRefreshResearch", () => {
  it("returns a plan with not-connected quick wins and the refresh lists", async () => {
    const result = await runSeoRefreshResearch(input());
    expect(result).toMatchObject({
      ok: true,
      plan: {
        primaryKeyword: "running shoes",
        quickWins: { state: "not-connected" },
        researchedAt: "2026-10-05T10:00:00.000Z",
      },
      refresh: { missing: ["Sizing", "Width"], keep: ["Fit", "Care"] },
    });
  });

  it("researches with web search and sends at most ten queries and one path", async () => {
    await runSeoRefreshResearch(input({ pageText: "x".repeat(9000) }));
    const [def, call] = mocks.run.mock.calls[0]!;
    expect(def).toMatchObject({
      purpose: "seo.refresh-research",
      webSearch: true,
    });
    const facts = call.context.facts;
    expect(facts.queries).toHaveLength(10);
    expect(facts.target.path).toBe("/blog/shoes");
    expect(facts.currentText).toHaveLength(6000);
    expect(facts.target.h2).toEqual(["Fit", "Care"]);
  });

  it("leaves the page text out when there is none", async () => {
    await runSeoRefreshResearch(input({ pageText: null }));
    expect(mocks.run.mock.calls[0]![1].context.facts).not.toHaveProperty(
      "currentText",
    );
  });

  it("passes the language only with SEO_ACTIONS on", async () => {
    await runSeoRefreshResearch(input());
    expect(mocks.run.mock.calls[0]![1]).not.toHaveProperty("language");
    expect(mocks.run.mock.calls[0]![1].context.facts).not.toHaveProperty(
      "seoLearnings",
    );
    vi.stubEnv("SEO_ACTIONS", "true");
    await runSeoRefreshResearch(input({ learnings: ["Refreshes helped."] }));
    const call = mocks.run.mock.calls[1]![1];
    expect(call.language).toBe("en");
    expect(call.context.facts.seoLearnings).toEqual(["Refreshes helped."]);
  });

  it("fails with a retry message on a thin answer or an error", async () => {
    mocks.run.mockResolvedValueOnce({
      output: { ...ANSWER, outline: [] },
      isMock: false,
      reasoningCallId: "r",
    });
    expect(await runSeoRefreshResearch(input())).toEqual({
      ok: false,
      code: "FAILED",
      message: SEO_REFRESH_COPY.thin,
    });
    mocks.run.mockRejectedValueOnce(new Error("boom"));
    expect(await runSeoRefreshResearch(input())).toEqual({
      ok: false,
      code: "FAILED",
      message: SEO_REFRESH_COPY.failed,
    });
  });
});
