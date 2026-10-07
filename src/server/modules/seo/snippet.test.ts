import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  getBrandTwin: vi.fn(),
  loadBrandRules: vi.fn(),
  ruleLanguage: vi.fn(),
}));

vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run, isMockMode: () => false },
}));
vi.mock("@/server/brand-twin/brand-twin", () => ({
  getBrandTwin: mocks.getBrandTwin,
}));
vi.mock("@/server/brand/rule-language", () => ({
  brandRuleLanguageOf: mocks.ruleLanguage,
}));
vi.mock("@/server/works/brand-rule-loader", () => ({
  loadBrandRules: mocks.loadBrandRules,
}));
vi.mock("@/lib/seo/actions/learning-prompt", () => ({
  seoLearningsPromptLine: () => null,
}));

import type { SeoTarget } from "@/lib/module-flows/seo/state";
import { AgentelseError } from "@/server/security/errors";

import { SEO_SNIPPET_COPY, runSeoSnippet } from "./snippet";

const SCOPE = { workspaceId: "ws1", projectId: "p1", brandId: "b1" };
const BRIEF = {
  topic: "Running shoes",
  siteUrl: "https://example.com",
  language: "tr",
  audience: "",
};
const TARGET: SeoTarget = {
  url: "https://example.com/u/john.doe@mail.com/shoes?utm=1",
  path: "/u/john.doe@mail.com/shoes?utm=1",
  title: "Running shoes",
  metaDescription: "Old meta.",
  h1: "Running shoes",
  h2: Array.from({ length: 30 }, (_, i) => `H2 ${i}`),
  wordCount: 800,
  textHash: "h",
  fetchedAt: "2026-10-05T09:00:00.000Z",
  queryCount: 12,
};
const QUERIES = Array.from({ length: 14 }, (_, i) => ({
  text: i === 0 ? "reach me at a@b.co" : `query ${i}`,
  impressions: 100 - i,
  clicks: 5,
  position: i === 1 ? null : 7.26,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getBrandTwin.mockResolvedValue(null);
  mocks.loadBrandRules.mockResolvedValue(null);
  mocks.ruleLanguage.mockResolvedValue("en");
  mocks.run.mockResolvedValue({
    output: {
      variants: [
        { title: "Best running shoes", metaDescription: "m1", angle: "A" },
        { title: "Running shoes", metaDescription: "m2", angle: "B" },
        { title: "How to choose", metaDescription: "m3", angle: "C" },
      ],
    },
    isMock: false,
    reasoningCallId: "r",
  });
});

function input() {
  return {
    scope: SCOPE,
    brief: BRIEF,
    target: TARGET,
    queries: QUERIES,
    learnings: ["Titles helped."],
    now: new Date("2026-10-05T10:00:00.000Z"),
  };
}

describe("runSeoSnippet", () => {
  it("sends the masked path and at most ten masked queries, never more", async () => {
    const result = await runSeoSnippet(input());
    expect(result.ok).toBe(true);
    const [def, call] = mocks.run.mock.calls[0]!;
    expect(def).toMatchObject({ purpose: "seo.snippet" });
    const facts = call.context.facts;
    expect(facts.target.path).not.toContain("john.doe");
    expect(facts.target.path).not.toContain("utm");
    expect(facts.target.path).toContain("[email]");
    expect(facts.target.h2).toHaveLength(20);
    expect(facts.queries).toHaveLength(10);
    expect(facts.queries[0].text).toBe("reach me at [email]");
    expect(facts.queries[1].position).toBeNull();
    expect(facts.queries[2].position).toBe(7.3);
    expect(JSON.stringify(facts)).not.toContain("a@b.co");
    expect(facts.topic).toBe("Running shoes");
    expect(call).toMatchObject({
      workspaceId: "ws1",
      projectId: "p1",
      brandId: "b1",
    });
  });

  it("keeps the current behaviour while SEO_ACTIONS is off", async () => {
    await runSeoSnippet(input());
    const [, call] = mocks.run.mock.calls[0]!;
    expect(call).not.toHaveProperty("language");
    expect(call.context.facts).not.toHaveProperty("ruleLanguage");
    expect(call.context.facts).not.toHaveProperty("seoLearnings");
  });

  it("adds the language rule, rule language and learnings when SEO_ACTIONS is on", async () => {
    vi.stubEnv("SEO_ACTIONS", "true");
    await runSeoSnippet(input());
    const [, call] = mocks.run.mock.calls[0]!;
    expect(call.language).toBe("tr");
    expect(call.context.facts.ruleLanguage).toBe("en");
    expect(call.context.facts.seoLearnings).toEqual(["Titles helped."]);
  });

  it("cleans the variants into a snippet with nothing chosen", async () => {
    const result = await runSeoSnippet(input());
    expect(result).toEqual({
      ok: true,
      snippet: {
        // Mevcut başlığı olduğu gibi bırakan ikinci varyant atılır.
        variants: [
          { title: "Best running shoes", metaDescription: "m1", angle: "A" },
          { title: "How to choose", metaDescription: "m3", angle: "C" },
        ],
        chosen: null,
        edited: null,
        generatedAt: "2026-10-05T10:00:00.000Z",
      },
    });
  });

  it("fails with a retry message when nothing usable is left", async () => {
    mocks.run.mockResolvedValueOnce({
      output: {
        variants: [{ title: "Running shoes", metaDescription: "m", angle: "A" }],
      },
      isMock: false,
      reasoningCallId: "r",
    });
    expect(await runSeoSnippet(input())).toEqual({
      ok: false,
      code: "FAILED",
      message: SEO_SNIPPET_COPY.thin,
    });
    mocks.run.mockResolvedValueOnce({
      output: { variants: [] },
      isMock: false,
      reasoningCallId: "r",
    });
    expect(await runSeoSnippet(input())).toMatchObject({
      ok: false,
      message: SEO_SNIPPET_COPY.thin,
    });
  });

  it("maps a model error and a spent budget", async () => {
    mocks.run.mockRejectedValueOnce(new Error("boom"));
    expect(await runSeoSnippet(input())).toEqual({
      ok: false,
      code: "FAILED",
      message: SEO_SNIPPET_COPY.failed,
    });
    mocks.run.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "dailyBudgetUsd" },
      }),
    );
    expect(await runSeoSnippet(input())).toMatchObject({
      ok: false,
      code: "BUDGET",
    });
  });
});
