import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: SEO_INSIGHTS=on değilken çıktı adımı hiçbir şey
// yapmaz; süre bitmeden 20 sn kalmadıysa adımlar atlanır; hiçbir hata dışarı
// taşmaz; marka önerisi kendiliğinden yalnız bir kez ve 4 tam haftayla çalışır.

const mocks = vi.hoisted(() => ({
  explainWeek: vi.fn(),
  ingestOpportunitySignals: vi.fn(),
  suggestBrandTermsForLink: vi.fn(),
  readEngineState: vi.fn(),
  readPeriodCoverage: vi.fn(),
}));

vi.mock("./explain", () => ({ explainWeek: mocks.explainWeek }));
vi.mock("./signals", () => ({
  ingestOpportunitySignals: mocks.ingestOpportunitySignals,
}));
vi.mock("./brand-suggest", () => ({
  suggestBrandTermsForLink: mocks.suggestBrandTermsForLink,
}));
vi.mock("./state", () => ({
  OUTPUTS_MIN_REMAINING_MS: 20_000,
  readEngineState: mocks.readEngineState,
}));
vi.mock("@/server/seo/store", () => ({
  readPeriodCoverage: mocks.readPeriodCoverage,
}));

import type { GscSiteLink } from "@prisma/client";

import { maybeSuggestBrandTerms, publishOpportunityOutputs } from "./outputs";

const LINK = { id: "link-1", projectId: "p1", workspaceId: "ws1" };
const FULL_LINK = {
  ...LINK,
  isMock: false,
  lastWeeklyWeek: "2026-09-21",
} as GscSiteLink;
const NOW = new Date("2026-10-01T12:00:00Z");
const INPUT = {
  link: LINK,
  week: "2026-09-21",
  periodKey: "W:2026-09-27",
  now: NOW,
};

function on(): void {
  vi.stubEnv("SEO_INSIGHTS", "on");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.explainWeek.mockResolvedValue({ explained: 2, budgetHit: false });
  mocks.ingestOpportunitySignals.mockResolvedValue(1);
  mocks.suggestBrandTermsForLink.mockResolvedValue({
    ok: true,
    suggestions: [],
  });
  mocks.readEngineState.mockResolvedValue({ brandSuggestions: null });
  mocks.readPeriodCoverage.mockResolvedValue({
    periods: ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"],
    truncated: false,
    rowClicks: 0,
    rowImpressions: 0,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publishOpportunityOutputs", () => {
  it("is a no-op unless SEO_INSIGHTS is on", async () => {
    vi.stubEnv("SEO_INSIGHTS", "shadow");
    vi.stubEnv("GSC_SYNC", "true");
    expect(
      await publishOpportunityOutputs({
        ...INPUT,
        deadline: Date.now() + 60_000,
      }),
    ).toEqual({ explained: 0, signals: 0, budgetHit: false });
    vi.stubEnv("SEO_INSIGHTS", "on");
    vi.stubEnv("GSC_SYNC", "false");
    await publishOpportunityOutputs({
      ...INPUT,
      deadline: Date.now() + 60_000,
    });
    expect(mocks.explainWeek).not.toHaveBeenCalled();
    expect(mocks.ingestOpportunitySignals).not.toHaveBeenCalled();
  });

  it("explains, then ingests signals while time remains", async () => {
    on();
    expect(
      await publishOpportunityOutputs({
        ...INPUT,
        deadline: Date.now() + 60_000,
      }),
    ).toEqual({ explained: 2, signals: 1, budgetHit: false });
    expect(mocks.explainWeek).toHaveBeenCalledWith({
      link: LINK,
      week: "2026-09-21",
      now: NOW,
    });
    expect(mocks.ingestOpportunitySignals).toHaveBeenCalledWith({
      link: LINK,
      periodKey: "W:2026-09-27",
      now: NOW,
    });
  });

  it("skips steps when the deadline is near", async () => {
    on();
    expect(
      await publishOpportunityOutputs({
        ...INPUT,
        deadline: Date.now() + 10_000,
      }),
    ).toEqual({ explained: 0, signals: 0, budgetHit: false });
    expect(mocks.explainWeek).not.toHaveBeenCalled();
    expect(mocks.ingestOpportunitySignals).not.toHaveBeenCalled();
  });

  it("never throws and keeps going after a failed step", async () => {
    on();
    mocks.explainWeek.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      await publishOpportunityOutputs({
        ...INPUT,
        deadline: Date.now() + 60_000,
      }),
    ).toEqual({ explained: 0, signals: 1, budgetHit: false });
    mocks.ingestOpportunitySignals.mockRejectedValueOnce(new Error("db"));
    await expect(
      publishOpportunityOutputs({ ...INPUT, deadline: Date.now() + 60_000 }),
    ).resolves.toMatchObject({ signals: 0 });
    warn.mockRestore();
  });

  it("passes budgetHit through from explanations", async () => {
    on();
    mocks.explainWeek.mockResolvedValueOnce({ explained: 0, budgetHit: true });
    expect(
      await publishOpportunityOutputs({
        ...INPUT,
        deadline: Date.now() + 60_000,
      }),
    ).toMatchObject({ budgetHit: true });
  });
});

describe("maybeSuggestBrandTerms", () => {
  it("runs once automatically when on with 4 complete weeks", async () => {
    on();
    expect(
      await maybeSuggestBrandTerms({
        link: FULL_LINK,
        now: NOW,
        deadline: Date.now() + 60_000,
      }),
    ).toEqual({ ran: true, budgetHit: false });
    expect(mocks.suggestBrandTermsForLink).toHaveBeenCalledWith({
      link: FULL_LINK,
      now: NOW,
      auto: true,
    });
    expect(mocks.readPeriodCoverage).toHaveBeenCalledWith(
      "link-1",
      "WEEK",
      "query",
      "2026-08-31",
      "2026-09-21",
    );
  });

  it("skips when off, near the deadline, already suggested or short of weeks", async () => {
    const run = () =>
      maybeSuggestBrandTerms({
        link: FULL_LINK,
        now: NOW,
        deadline: Date.now() + 60_000,
      });
    expect(await run()).toEqual({ ran: false, budgetHit: false });
    on();
    expect(
      await maybeSuggestBrandTerms({
        link: FULL_LINK,
        now: NOW,
        deadline: Date.now() + 5_000,
      }),
    ).toEqual({ ran: false, budgetHit: false });
    mocks.readEngineState.mockResolvedValueOnce({
      brandSuggestions: {
        v: 1,
        items: [],
        dismissed: [],
        lastAt: null,
        auto: true,
      },
    });
    expect(await run()).toEqual({ ran: false, budgetHit: false });
    mocks.readPeriodCoverage.mockResolvedValueOnce({
      periods: ["2026-09-21"],
      truncated: false,
      rowClicks: 0,
      rowImpressions: 0,
    });
    expect(await run()).toEqual({ ran: false, budgetHit: false });
    expect(mocks.suggestBrandTermsForLink).not.toHaveBeenCalled();
  });

  it("reports a spent budget and never throws", async () => {
    on();
    mocks.suggestBrandTermsForLink.mockResolvedValueOnce({
      ok: false,
      reason: "budget",
    });
    expect(
      await maybeSuggestBrandTerms({
        link: FULL_LINK,
        now: NOW,
        deadline: Date.now() + 60_000,
      }),
    ).toEqual({ ran: false, budgetHit: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.suggestBrandTermsForLink.mockRejectedValueOnce(new Error("boom"));
    expect(
      await maybeSuggestBrandTerms({
        link: FULL_LINK,
        now: NOW,
        deadline: Date.now() + 60_000,
      }),
    ).toEqual({ ran: false, budgetHit: false });
    warn.mockRestore();
  });
});
