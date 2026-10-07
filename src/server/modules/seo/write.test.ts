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

import type { SeoPlan } from "@/lib/module-flows/seo/state";

import { runSeoWrite } from "./write";

const SCOPE = { workspaceId: "ws1", projectId: "p1", brandId: "b1" };
const BRIEF = {
  topic: "Running shoes",
  siteUrl: "https://example.com",
  language: "tr",
  audience: "",
};
const PLAN: SeoPlan = {
  primaryKeyword: "running shoes",
  secondaryKeywords: [],
  searchIntent: "informational",
  intentNote: "",
  titleOptions: ["Plan title"],
  titleIndex: 0,
  metaDescription: "Plan meta.",
  outline: [{ h2: "Fit", points: [] }],
  quickWins: { state: "not-connected" },
  researchedAt: "2026-10-05T09:00:00.000Z",
};
const BODY = Array.from({ length: 260 }, () => "word").join(" ");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getBrandTwin.mockResolvedValue(null);
  mocks.loadBrandRules.mockResolvedValue(null);
  mocks.ruleLanguage.mockResolvedValue("en");
  mocks.run.mockResolvedValue({
    output: { markdown: BODY, title: "New title", metaDescription: "New meta." },
    isMock: false,
    reasoningCallId: "r",
  });
});

describe("runSeoWrite", () => {
  it("keeps today's call for a new article while SEO_ACTIONS is off", async () => {
    const result = await runSeoWrite({
      scope: SCOPE,
      brief: BRIEF,
      plan: PLAN,
      mode: "write",
      language: "tr",
      learnings: ["x"],
    });
    expect(result).toMatchObject({
      ok: true,
      // Yazma kipinde model başlığı yok sayılır, plan başlığı kalır.
      draft: { title: "Plan title", metaDescription: "Plan meta." },
    });
    const [, call] = mocks.run.mock.calls[0]!;
    expect(call).not.toHaveProperty("language");
    expect(call.context.mode).toBe("write");
    expect(call.context.facts).not.toHaveProperty("seoLearnings");
    expect(call.context.facts).not.toHaveProperty("ruleLanguage");
    expect(mocks.ruleLanguage).toHaveBeenCalledTimes(1);
  });

  it("refreshes a page: current text in FACTS, model title and meta kept", async () => {
    vi.stubEnv("SEO_ACTIONS", "true");
    const result = await runSeoWrite({
      scope: SCOPE,
      brief: BRIEF,
      plan: PLAN,
      mode: "refresh",
      learnings: ["Titles helped."],
      current: {
        text: "t".repeat(7000),
        title: "Old title",
        h2: ["Fit"],
        missing: ["Width"],
        keep: ["Fit"],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      draft: { title: "New title", metaDescription: "New meta." },
    });
    const [, call] = mocks.run.mock.calls[0]!;
    expect(call.language).toBe("tr");
    expect(call.context.mode).toBe("refresh");
    expect(call.context.facts.current).toEqual({
      title: "Old title",
      h2: ["Fit"],
      text: "t".repeat(6000),
      missing: ["Width"],
      keep: ["Fit"],
    });
    expect(call.context.facts.ruleLanguage).toBe("en");
    expect(call.context.facts.seoLearnings).toEqual(["Titles helped."]);
    // Kural dili bir kez okunur.
    expect(mocks.ruleLanguage).toHaveBeenCalledTimes(1);
  });
});
