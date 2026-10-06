import { describe, expect, it } from "vitest";

import {
  AUTO_ACTIONS_PER_DAY,
  autopilotVerdict,
  daysLeftInMonth,
  fullPrerequisitesMet,
  isBoundedRaise,
  isRiskReducing,
  missingFullPrerequisites,
  onPlatformGoal,
  type AutoCandidate,
  type AutoGates,
} from "./autopilot";

const NOW = new Date("2026-10-06T10:00:00Z");

function gates(overrides: Partial<AutoGates> = {}): AutoGates {
  return {
    level: "GUARDED",
    flagOn: true,
    tokenHealthy: true,
    mirrorFresh: true,
    writesDisabled: false,
    actionsLast24h: 0,
    lastBudgetChangeAt: null,
    now: NOW,
    ...overrides,
  };
}

const runawayPause: AutoCandidate = { ruleKey: "G1_RUNAWAY", kind: "PAUSE" };
const cut: AutoCandidate = {
  ruleKey: "O2_HIGH_CPA",
  kind: "BUDGET_DOWN",
  fromBudgetMinor: 10_000,
  toBudgetMinor: 7_500,
};
const raise: AutoCandidate = {
  ruleKey: "O3_SCALE",
  kind: "BUDGET_UP",
  fromBudgetMinor: 10_000,
  toBudgetMinor: 12_000,
};
const fullGates = {
  prerequisitesMet: true,
  monthlyCapMinor: 1_000_000,
  monthToDateSpendMinor: 200_000,
  projectedExtraMinor: 50_000,
  accountLocalHour: 10,
};

describe("autopilotVerdict", () => {
  it("Suggest only and a closed flag never act on their own", () => {
    expect(autopilotVerdict(runawayPause, gates({ level: "SUGGEST" }))).toEqual(
      {
        auto: false,
        reason: "suggest_only",
      },
    );
    expect(autopilotVerdict(runawayPause, gates({ flagOn: false }))).toEqual({
      auto: false,
      reason: "suggest_only",
    });
  });

  it("Guarded pauses runaway spend and cuts budgets by at most 30%", () => {
    expect(autopilotVerdict(runawayPause, gates())).toEqual({
      auto: true,
      riskReducing: true,
    });
    expect(autopilotVerdict(cut, gates())).toEqual({
      auto: true,
      riskReducing: true,
    });
    expect(autopilotVerdict({ ...cut, toBudgetMinor: 6_000 }, gates())).toEqual(
      { auto: false, reason: "not_risk_reducing" },
    );
  });

  it("Guarded never raises a budget (defence in depth: only risk-reducing actions)", () => {
    expect(autopilotVerdict(raise, gates())).toEqual({
      auto: false,
      reason: "needs_full_auto",
    });
    // A "cut" whose numbers go up is not risk-reducing either.
    expect(
      autopilotVerdict({ ...cut, toBudgetMinor: 12_000 }, gates()),
    ).toEqual({ auto: false, reason: "not_risk_reducing" });
  });

  it("zero-result pauses act only on on-platform results (messages, instant forms)", () => {
    const zero: AutoCandidate = { ruleKey: "G3_ZERO_RESULTS", kind: "PAUSE" };
    expect(
      autopilotVerdict({ ...zero, onPlatformResult: true }, gates()).auto,
    ).toBe(true);
    expect(
      autopilotVerdict({ ...zero, onPlatformResult: false }, gates()),
    ).toEqual({
      auto: false,
      reason: "offsite_result",
    });
  });

  it("rules outside the list stay suggestions", () => {
    expect(
      autopilotVerdict({ ruleKey: "O5_LOSER_AD", kind: "PAUSE" }, gates()),
    ).toEqual({ auto: false, reason: "rule_not_automatic" });
  });

  it("stops at the daily limit, with an unhealthy token and with a stale mirror", () => {
    expect(
      autopilotVerdict(
        runawayPause,
        gates({ actionsLast24h: AUTO_ACTIONS_PER_DAY }),
      ),
    ).toEqual({ auto: false, reason: "daily_limit" });
    expect(
      autopilotVerdict(runawayPause, gates({ tokenHealthy: false })),
    ).toEqual({
      auto: false,
      reason: "token",
    });
    expect(
      autopilotVerdict(runawayPause, gates({ mirrorFresh: false })),
    ).toEqual({
      auto: false,
      reason: "stale_mirror",
    });
  });

  it("keeps 72 hours between automatic budget changes; the kill switch lets only pauses through", () => {
    const recent = new Date(NOW.getTime() - 24 * 60 * 60_000);
    expect(
      autopilotVerdict(cut, gates({ lastBudgetChangeAt: recent })),
    ).toEqual({
      auto: false,
      reason: "budget_changed_recently",
    });
    expect(autopilotVerdict(cut, gates({ writesDisabled: true }))).toEqual({
      auto: false,
      reason: "writes_disabled",
    });
    expect(
      autopilotVerdict(runawayPause, gates({ writesDisabled: true })).auto,
    ).toBe(true);
  });

  it("Full auto raises at most 20% within the monthly cap, never late in the day", () => {
    const full = gates({ level: "FULL", full: fullGates });
    expect(autopilotVerdict(raise, full)).toEqual({
      auto: true,
      riskReducing: false,
    });
    expect(autopilotVerdict({ ...raise, toBudgetMinor: 12_500 }, full)).toEqual(
      { auto: false, reason: "raise_too_large" },
    );
    expect(
      autopilotVerdict(
        raise,
        gates({ level: "FULL", full: { ...fullGates, accountLocalHour: 19 } }),
      ),
    ).toEqual({ auto: false, reason: "late_in_day" });
    expect(
      autopilotVerdict(
        raise,
        gates({
          level: "FULL",
          full: { ...fullGates, monthToDateSpendMinor: 990_000 },
        }),
      ),
    ).toEqual({ auto: false, reason: "over_monthly_cap" });
    expect(
      autopilotVerdict(
        raise,
        gates({ level: "FULL", full: { ...fullGates, monthlyCapMinor: null } }),
      ),
    ).toEqual({ auto: false, reason: "no_monthly_cap" });
    expect(
      autopilotVerdict(
        raise,
        gates({
          level: "FULL",
          full: { ...fullGates, prerequisitesMet: false },
        }),
      ),
    ).toEqual({ auto: false, reason: "full_prerequisites" });
  });
});

describe("helpers", () => {
  it("risk-reducing means pause or a cut of at most 30%", () => {
    expect(isRiskReducing(runawayPause)).toBe(true);
    expect(isRiskReducing(cut)).toBe(true);
    expect(isRiskReducing({ ...cut, toBudgetMinor: 7_000 })).toBe(true);
    expect(isRiskReducing({ ...cut, toBudgetMinor: 6_999 })).toBe(false);
    expect(isRiskReducing({ ...cut, toBudgetMinor: 10_000 })).toBe(false);
    expect(isRiskReducing(raise)).toBe(false);
  });

  it("a bounded raise is at most 20%", () => {
    expect(isBoundedRaise(raise)).toBe(true);
    expect(isBoundedRaise({ ...raise, toBudgetMinor: 12_001 })).toBe(false);
    expect(isBoundedRaise({ ...raise, toBudgetMinor: 9_000 })).toBe(false);
  });

  it("messages and instant forms are on-platform goals", () => {
    expect(onPlatformGoal("CONVERSATIONS")).toBe(true);
    expect(onPlatformGoal("LEAD_GENERATION")).toBe(true);
    expect(onPlatformGoal("OFFSITE_CONVERSIONS")).toBe(false);
    expect(onPlatformGoal(null)).toBe(false);
  });

  it("days left in the month include today", () => {
    expect(daysLeftInMonth("2026-10-06")).toBe(26);
    expect(daysLeftInMonth("2026-02-28")).toBe(1);
  });

  it("Full auto prerequisites list what is missing", () => {
    const ready = {
      standardAccess: true,
      permanentToken: true,
      trackingHealthy: true,
      historyDays: 45,
      monthlyCapSet: true,
    };
    expect(fullPrerequisitesMet(ready)).toBe(true);
    expect(missingFullPrerequisites(ready)).toEqual([]);
    const missing = missingFullPrerequisites({
      ...ready,
      historyDays: 12,
      monthlyCapSet: false,
    });
    expect(missing).toHaveLength(2);
    expect(fullPrerequisitesMet({ ...ready, permanentToken: false })).toBe(
      false,
    );
  });
});
