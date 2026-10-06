import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findActiveGoogleConnections: vi.fn(),
  getFreshGoogleAccessToken: vi.fn(),
  fetchSearchConsoleQueryRows: vi.fn(),
  run: vi.fn(),
  getBrandTwin: vi.fn(),
  readQuickWinRows: vi.fn(),
  readSeoCurves: vi.fn(),
}));

vi.mock("@/server/seo/opportunities/state", () => ({
  readSeoCurves: mocks.readSeoCurves,
}));

vi.mock("@/server/integrations/google-connections", () => ({
  findActiveGoogleConnections: mocks.findActiveGoogleConnections,
}));
vi.mock("@/server/integrations/google-token", () => ({
  getFreshGoogleAccessToken: mocks.getFreshGoogleAccessToken,
}));
vi.mock("@/server/integrations/google-client", () => ({
  fetchSearchConsoleQueryRows: mocks.fetchSearchConsoleQueryRows,
}));
vi.mock("@/server/seo/readers", () => ({
  readQuickWinRows: mocks.readQuickWinRows,
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
  loadBrandRules: async () => null,
}));

import { priorCurve } from "@/lib/seo/ctr-curve";
import { AgentelseError } from "@/server/security/errors";

import {
  SEO_RESEARCH_COPY,
  loadSeoQuickWins,
  runSeoResearch,
} from "./research";

const SCOPE = { workspaceId: "ws1", projectId: "p1", brandId: "b1" };
const BRIEF = {
  topic: "Running shoes",
  siteUrl: "https://example.com",
  language: "en",
  audience: "",
};
const CONNECTED = {
  analytics: null,
  searchConsole: {
    credential: { id: "cred-1", encryptedSecret: "secret" },
    siteUrl: "sc-domain:example.com",
  },
};
const ANSWER = {
  primaryKeyword: "running shoes",
  secondaryKeywords: ["best running shoes"],
  searchIntent: "commercial",
  intentNote: "They compare.",
  titleOptions: ["How to choose running shoes for your first race"],
  metaDescription: "Meta.",
  outline: [
    { h2: "A", points: [] },
    { h2: "B", points: [] },
    { h2: "C", points: [] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SEO_INSIGHTS", "off");
  mocks.readSeoCurves.mockResolvedValue(null);
  mocks.getBrandTwin.mockResolvedValue(null);
  mocks.readQuickWinRows.mockResolvedValue(null);
  mocks.findActiveGoogleConnections.mockResolvedValue(CONNECTED);
  mocks.getFreshGoogleAccessToken.mockResolvedValue("token");
  mocks.fetchSearchConsoleQueryRows.mockResolvedValue([
    {
      keys: ["page one"],
      clicks: 40,
      impressions: 900,
      ctr: 0.04,
      position: 2,
    },
    {
      keys: ["close one"],
      clicks: 3,
      impressions: 700,
      ctr: 0,
      position: 11.3,
    },
    { keys: ["closer"], clicks: 1, impressions: 1500, ctr: 0, position: 8.4 },
  ]);
  mocks.run.mockResolvedValue({
    output: ANSWER,
    isMock: false,
    reasoningCallId: "r",
  });
});

describe("loadSeoQuickWins", () => {
  it("reads 28 days of the site's queries and keeps the close ones", async () => {
    expect(await loadSeoQuickWins("p1")).toEqual({
      state: "ok",
      items: [
        { query: "closer", impressions: 1500, clicks: 1, position: 8.4 },
        { query: "close one", impressions: 700, clicks: 3, position: 11.3 },
      ],
    });
    expect(mocks.getFreshGoogleAccessToken).toHaveBeenCalledWith(
      CONNECTED.searchConsole.credential,
    );
    expect(mocks.fetchSearchConsoleQueryRows).toHaveBeenCalledWith(
      "token",
      "sc-domain:example.com",
      ["query"],
      28,
      1000,
    );
  });

  it("says when Search Console is not connected, or could not be read", async () => {
    mocks.findActiveGoogleConnections.mockResolvedValueOnce({
      analytics: null,
      searchConsole: null,
    });
    expect(await loadSeoQuickWins("p1")).toEqual({ state: "not-connected" });
    mocks.getFreshGoogleAccessToken.mockRejectedValueOnce(
      new Error("invalid_grant"),
    );
    expect(await loadSeoQuickWins("p1")).toEqual({ state: "failed" });
  });

  it("reads the warehouse first and never calls Google when it has the weeks", async () => {
    mocks.readQuickWinRows.mockResolvedValueOnce([
      { keys: ["stored close"], clicks: 2, impressions: 800, position: 9.26 },
      { keys: ["stored top"], clicks: 90, impressions: 2000, position: 1.5 },
    ]);
    expect(await loadSeoQuickWins("p1")).toEqual({
      state: "ok",
      items: [
        { query: "stored close", impressions: 800, clicks: 2, position: 9.3 },
      ],
    });
    expect(mocks.readQuickWinRows).toHaveBeenCalledWith({
      projectId: "p1",
      siteUrl: "sc-domain:example.com",
    });
    expect(mocks.getFreshGoogleAccessToken).not.toHaveBeenCalled();
    expect(mocks.fetchSearchConsoleQueryRows).not.toHaveBeenCalled();
  });

  it("falls back to the live path when the warehouse has nothing or throws", async () => {
    expect(await loadSeoQuickWins("p1")).toMatchObject({ state: "ok" });
    expect(mocks.fetchSearchConsoleQueryRows).toHaveBeenCalledTimes(1);

    mocks.readQuickWinRows.mockRejectedValueOnce(new Error("db down"));
    expect(await loadSeoQuickWins("p1")).toEqual({
      state: "ok",
      items: [
        { query: "closer", impressions: 1500, clicks: 1, position: 8.4 },
        { query: "close one", impressions: 700, clicks: 3, position: 11.3 },
      ],
    });
    expect(mocks.fetchSearchConsoleQueryRows).toHaveBeenCalledTimes(2);
  });

  it("keeps today's pick and never reads curves while SEO_INSIGHTS is off", async () => {
    vi.stubEnv("GSC_SYNC", "true");
    mocks.readQuickWinRows.mockResolvedValueOnce([
      { keys: ["stored close"], clicks: 2, impressions: 800, position: 9.26 },
    ]);
    expect(await loadSeoQuickWins("p1")).toEqual({
      state: "ok",
      items: [
        { query: "stored close", impressions: 800, clicks: 2, position: 9.3 },
      ],
    });
    expect(mocks.readSeoCurves).not.toHaveBeenCalled();
  });

  it("ranks stored rows by the site's curve gain when SEO_INSIGHTS is on", async () => {
    vi.stubEnv("SEO_INSIGHTS", "on");
    vi.stubEnv("GSC_SYNC", "true");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
    vi.stubEnv("NODE_ENV", "production");
    mocks.readSeoCurves.mockResolvedValueOnce({
      nonBrand: priorCurve("non-brand"),
      brand: priorCurve("brand"),
    });
    mocks.readQuickWinRows.mockResolvedValueOnce([
      { keys: ["mid page"], clicks: 5, impressions: 4000, position: 5.2 },
      { keys: ["far page"], clicks: 0, impressions: 900, position: 14 },
      { keys: ["top page"], clicks: 90, impressions: 2000, position: 1.5 },
    ]);
    const result = await loadSeoQuickWins("p1");
    expect(mocks.readSeoCurves).toHaveBeenCalledWith("p1");
    expect(result.state).toBe("ok");
    const items = result.state === "ok" ? result.items : [];
    expect(items.map((item) => item.query)).toEqual(["mid page", "far page"]);
    expect(items[0]?.gain).toBeGreaterThan(items[1]?.gain ?? 0);
    expect(mocks.fetchSearchConsoleQueryRows).not.toHaveBeenCalled();
  });

  it("falls back to today's pick when curves are missing or fail", async () => {
    vi.stubEnv("SEO_INSIGHTS", "on");
    vi.stubEnv("GSC_SYNC", "true");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
    vi.stubEnv("NODE_ENV", "production");
    const stored = [
      { keys: ["stored close"], clicks: 2, impressions: 800, position: 9.26 },
    ];
    mocks.readQuickWinRows.mockResolvedValueOnce(stored);
    mocks.readSeoCurves.mockRejectedValueOnce(new Error("db down"));
    expect(await loadSeoQuickWins("p1")).toEqual({
      state: "ok",
      items: [
        { query: "stored close", impressions: 800, clicks: 2, position: 9.3 },
      ],
    });
  });

  it("leaves the live path untouched when SEO_INSIGHTS is on", async () => {
    vi.stubEnv("SEO_INSIGHTS", "on");
    vi.stubEnv("GSC_SYNC", "true");
    expect(await loadSeoQuickWins("p1")).toMatchObject({
      state: "ok",
      items: [{ query: "closer" }, { query: "close one" }],
    });
    expect(mocks.readSeoCurves).not.toHaveBeenCalled();
  });

  it("does not read the warehouse when Search Console is not connected", async () => {
    mocks.findActiveGoogleConnections.mockResolvedValueOnce({
      analytics: null,
      searchConsole: null,
    });
    expect(await loadSeoQuickWins("p1")).toEqual({ state: "not-connected" });
    expect(mocks.readQuickWinRows).not.toHaveBeenCalled();
  });
});

describe("runSeoResearch", () => {
  it("researches with web search and folds the quick wins into the plan", async () => {
    const result = await runSeoResearch({ scope: SCOPE, brief: BRIEF });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        primaryKeyword: "running shoes",
        quickWins: {
          state: "ok",
          items: [{ query: "closer" }, { query: "close one" }],
        },
      },
    });
    const [def, call] = mocks.run.mock.calls[0]!;
    expect(def).toMatchObject({ purpose: "seo.research", webSearch: true });
    expect(call).toMatchObject({
      workspaceId: "ws1",
      projectId: "p1",
      brandId: "b1",
      context: {
        facts: {
          topic: "Running shoes",
          siteUrl: "https://example.com",
          language: { code: "en", name: "English" },
        },
      },
    });
  });

  it("maps a spent budget to its notice and a thin answer to a retry", async () => {
    mocks.run.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "dailyBudgetUsd" },
      }),
    );
    const budget = await runSeoResearch({ scope: SCOPE, brief: BRIEF });
    expect(budget).toMatchObject({ ok: false, code: "BUDGET" });
    expect(budget.ok ? "" : budget.message).toMatch(/budget/i);

    mocks.run.mockResolvedValueOnce({
      output: { ...ANSWER, outline: [] },
      isMock: false,
      reasoningCallId: "r",
    });
    expect(await runSeoResearch({ scope: SCOPE, brief: BRIEF })).toEqual({
      ok: false,
      code: "FAILED",
      message: SEO_RESEARCH_COPY.thin,
    });

    mocks.run.mockRejectedValueOnce(new Error("boom"));
    expect(await runSeoResearch({ scope: SCOPE, brief: BRIEF })).toEqual({
      ok: false,
      code: "FAILED",
      message: SEO_RESEARCH_COPY.failed,
    });
  });
});
