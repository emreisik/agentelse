import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GaDailyAnalysisInput,
  GaFindingCandidate,
  GaRuleKey,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";
import { emptyWindowTables } from "./window";

// Bu dosyanın kanıtladığı: patlayan kural atlanır, diğerleri yine döner;
// AN10 yalnız ay turunda koşar; AN1 patlarsa günlük hedefler "skipped"
// olur; kalite kapıları 20 temiz günde 28 günlük pencere adayını düşürür,
// 21'de tutar, kapsam < usedDays ve ölçüm sorunu DIRECTIONAL yapar;
// canlı modda haftalık öneriler 3 ile sınırlanır, gölgede hepsi kalır.

const rules = vi.hoisted(() => ({
  evaluateDailyAnomalies: vi.fn(),
  evaluateWeeklyAnomaly: vi.fn(),
  evaluateGoalPace: vi.fn(),
  evaluateChanges: vi.fn(),
  evaluateReturningShare: vi.fn(),
  evaluateAiReferrals: vi.fn(),
  evaluateLandingPages: vi.fn(),
  evaluateChannelQuality: vi.fn(),
  evaluateCampaigns: vi.fn(),
  evaluateDeviceGap: vi.fn(),
  evaluateSiteSearch: vi.fn(),
  evaluateNotFound: vi.fn(),
  evaluateContentEngagement: vi.fn(),
  evaluateFunnel: vi.fn(),
}));

vi.mock("./anomaly", () => ({
  evaluateDailyAnomalies: rules.evaluateDailyAnomalies,
  evaluateWeeklyAnomaly: rules.evaluateWeeklyAnomaly,
}));
vi.mock("./goals", () => ({ evaluateGoalPace: rules.evaluateGoalPace }));
vi.mock("./changes", () => ({ evaluateChanges: rules.evaluateChanges }));
vi.mock("./audience", () => ({
  evaluateReturningShare: rules.evaluateReturningShare,
}));
vi.mock("./ai-referrals", () => ({
  evaluateAiReferrals: rules.evaluateAiReferrals,
}));
vi.mock("./landing-pages", () => ({
  evaluateLandingPages: rules.evaluateLandingPages,
}));
vi.mock("./channels", () => ({
  evaluateChannelQuality: rules.evaluateChannelQuality,
  evaluateCampaigns: rules.evaluateCampaigns,
}));
vi.mock("./devices", () => ({ evaluateDeviceGap: rules.evaluateDeviceGap }));
vi.mock("./site-search", () => ({
  evaluateSiteSearch: rules.evaluateSiteSearch,
}));
vi.mock("./content", () => ({
  evaluateNotFound: rules.evaluateNotFound,
  evaluateContentEngagement: rules.evaluateContentEngagement,
}));
vi.mock("./ecommerce", () => ({ evaluateFunnel: rules.evaluateFunnel }));

const {
  applyQualityGates,
  limitLiveOpportunities,
  runDailyRules,
  runWeeklyRules,
} = await import("./run-rules");

const WINDOW = { from: "2026-09-07", to: "2026-10-04" };

function window28(usedDays: number, landing = usedDays): GaWindowTables {
  return {
    ...emptyWindowTables(WINDOW),
    usedDays,
    missingDays: 28 - usedDays,
    coverage: {
      landing,
      channel: usedDays,
      device: usedDays,
      campaign: usedDays,
    },
  };
}

function candidate(
  ruleKey: GaRuleKey,
  partial: Partial<GaFindingCandidate> = {},
): GaFindingCandidate {
  return {
    ruleKey,
    kind: "OPPORTUNITY",
    subject: `page:/${ruleKey.toLowerCase()}`,
    period: {
      grain: "WINDOW28",
      from: WINDOW.from,
      to: WINDOW.to,
      key: "2026-W40:28d",
    },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    evidence: {
      v: 1,
      rule: ruleKey,
    } as unknown as GaFindingCandidate["evidence"],
    impact: null,
    impactShare: 0.2,
    ...partial,
  };
}

function weeklyInput(
  partial: Partial<GaWeeklyAnalysisInput> = {},
): GaWeeklyAnalysisInput {
  const empty = emptyWindowTables(WINDOW);
  return {
    linkId: "link-1",
    today: "2026-10-06",
    week: { monday: "2026-09-28", sunday: "2026-10-04" },
    country: null,
    days: [],
    suspect: new Set(),
    holidays: new Set(),
    current: empty,
    previous: empty,
    lastYear: null,
    window28: window28(28),
    window28Previous: window28(28),
    weeks: [],
    month: null,
    siteSearch: null,
    currency: null,
    measurementDegraded: false,
    ...partial,
  };
}

function dailyInput(): GaDailyAnalysisInput {
  return {
    linkId: "link-1",
    today: "2026-10-06",
    targets: ["2026-10-03", "2026-10-04", "2026-10-05"],
    country: null,
    days: [],
    suspect: new Set(),
    holidays: new Set(),
    channelDays: [],
    goals: [],
    measurementDegraded: false,
  };
}

beforeEach(() => {
  for (const mock of Object.values(rules)) mock.mockReset();
  rules.evaluateWeeklyAnomaly.mockReturnValue(null);
  rules.evaluateChanges.mockReturnValue([]);
  rules.evaluateLandingPages.mockReturnValue([]);
  rules.evaluateChannelQuality.mockReturnValue([]);
  rules.evaluateCampaigns.mockReturnValue([]);
  rules.evaluateDeviceGap.mockReturnValue(null);
  rules.evaluateReturningShare.mockReturnValue(null);
  rules.evaluateAiReferrals.mockReturnValue(null);
  rules.evaluateSiteSearch.mockReturnValue(null);
  rules.evaluateNotFound.mockReturnValue(null);
  rules.evaluateContentEngagement.mockReturnValue(null);
  rules.evaluateFunnel.mockReturnValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("runWeeklyRules", () => {
  it("skips a throwing rule and still returns the others", () => {
    rules.evaluateLandingPages.mockImplementation(() => {
      throw new Error("boom /secret-path 123");
    });
    rules.evaluateDeviceGap.mockReturnValue(candidate("AN5"));
    const result = runWeeklyRules(weeklyInput());
    expect(result.map((c) => c.ruleKey)).toEqual(["AN5"]);
    expect(console.warn).toHaveBeenCalledWith("[ga-analyze] rule AN3 failed");
  });

  it("runs AN10 only on a month run", () => {
    rules.evaluateContentEngagement.mockReturnValue(
      candidate("AN10", {
        period: {
          grain: "MONTH",
          from: "2026-09-01",
          to: "2026-09-30",
          key: "2026-09",
        },
      }),
    );
    expect(runWeeklyRules(weeklyInput())).toEqual([]);
    expect(rules.evaluateContentEngagement).not.toHaveBeenCalled();
    const month = {
      month: "2026-09",
      current: emptyWindowTables({ from: "2026-09-01", to: "2026-09-30" }),
      previous: emptyWindowTables({ from: "2026-08-01", to: "2026-08-31" }),
    };
    expect(
      runWeeklyRules(weeklyInput({ month })).map((c) => c.ruleKey),
    ).toEqual(["AN10"]);
  });
});

describe("runDailyRules", () => {
  it("marks every target skipped when AN1 fails and keeps AN15", () => {
    rules.evaluateDailyAnomalies.mockImplementation(() => {
      throw new Error("boom");
    });
    rules.evaluateGoalPace.mockReturnValue({
      candidates: [
        candidate("AN15", {
          period: {
            grain: "MONTH",
            from: "2026-10-01",
            to: "2026-10-31",
            key: "2026-10",
          },
        }),
      ],
      evaluated: [{ goalId: "g1", month: "2026-10" }],
    });
    const result = runDailyRules(dailyInput());
    expect(result.an1Days).toEqual([
      { day: "2026-10-03", outcome: "skipped" },
      { day: "2026-10-04", outcome: "skipped" },
      { day: "2026-10-05", outcome: "skipped" },
    ]);
    expect(result.candidates.map((c) => c.ruleKey)).toEqual(["AN15"]);
    expect(result.an15Evaluated).toEqual([{ goalId: "g1", month: "2026-10" }]);
  });

  it("reports no evaluated goals when AN15 fails", () => {
    rules.evaluateDailyAnomalies.mockReturnValue({
      candidates: [],
      days: [{ day: "2026-10-05", outcome: "not_anomalous" }],
    });
    rules.evaluateGoalPace.mockImplementation(() => {
      throw new Error("boom");
    });
    const result = runDailyRules(dailyInput());
    expect(result.an15Evaluated).toEqual([]);
    expect(result.an1Days).toEqual([
      { day: "2026-10-05", outcome: "not_anomalous" },
    ]);
  });
});

describe("applyQualityGates", () => {
  it("drops a 28-day window candidate at 20 used days and keeps it at 21", () => {
    const an3 = candidate("AN3");
    expect(
      applyQualityGates([an3], {
        measurementDegraded: false,
        window28: window28(20),
      }),
    ).toEqual([]);
    expect(
      applyQualityGates([an3], {
        measurementDegraded: false,
        window28: window28(21),
      }),
    ).toEqual([an3]);
  });

  it("forces DIRECTIONAL when landing coverage is below the used days", () => {
    const [gated] = applyQualityGates([candidate("AN3")], {
      measurementDegraded: false,
      window28: window28(26, 20),
    });
    expect(gated).toMatchObject({
      confidence: "DIRECTIONAL",
      severity: "INFO",
    });
    // Başka raporun kapsamı bu adayı etkilemez.
    const [an4] = applyQualityGates([candidate("AN4")], {
      measurementDegraded: false,
      window28: window28(26, 20),
    });
    expect(an4).toMatchObject({ confidence: "SIGNIFICANT", severity: "WARN" });
  });

  it("forces DIRECTIONAL on every candidate when measurement is degraded", () => {
    const gated = applyQualityGates(
      [
        candidate("AN1", {
          period: {
            grain: "DAY",
            from: "2026-10-05",
            to: "2026-10-05",
            key: "2026-10-05",
          },
        }),
        candidate("AN3"),
      ],
      { measurementDegraded: true, window28: window28(28) },
    );
    expect(gated.map((c) => c.confidence)).toEqual([
      "DIRECTIONAL",
      "DIRECTIONAL",
    ]);
    expect(gated.map((c) => c.severity)).toEqual(["INFO", "INFO"]);
  });
});

describe("limitLiveOpportunities", () => {
  const opportunities = [
    candidate("AN3", { subject: "page:/a", impactShare: 0.1 }),
    candidate("AN3", { subject: "page:/b", impactShare: 0.9 }),
    candidate("AN4", { subject: "channel:Email:engagement", impactShare: 0.5 }),
    candidate("AN5", { subject: "device:mobile", impactShare: 0.4 }),
    candidate("AN12", { subject: "campaign:x|y|z", impactShare: 0.05 }),
  ];
  const change = candidate("AN2", {
    kind: "CHANGE",
    subject: "site:keyEvents:wow",
  });

  it("keeps the three highest-priority weekly opportunities in live mode", () => {
    const kept = limitLiveOpportunities([...opportunities, change], "live");
    expect(kept.map((c) => c.subject)).toEqual([
      "page:/b",
      "channel:Email:engagement",
      "device:mobile",
      "site:keyEvents:wow",
    ]);
  });

  it("keeps everything in shadow mode", () => {
    expect(
      limitLiveOpportunities([...opportunities, change], "shadow"),
    ).toHaveLength(6);
  });
});
