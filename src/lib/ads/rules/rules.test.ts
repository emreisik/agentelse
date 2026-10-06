import { describe, expect, it } from "vitest";

import { addDays } from "../sync-plan";

import { explainDecision } from "./explain";
import { featuresOf, windowOf, type DayRow } from "./features";
import { floorBudget, learningBlocks, rateBlocks } from "./gates";
import { adRules, adSetRules, decisionFingerprint } from "./optimize-rules";
import { outcomeOf, significanceRatio } from "./stats";

const today = "2026-10-06";
const now = new Date("2026-10-06T10:00:00Z");

// n days ending yesterday, each with the same numbers.
function days(n: number, row: Partial<DayRow>, endOffset = -1): DayRow[] {
  return Array.from({ length: n }, (_, i) => ({
    date: addDays(today, endOffset - i),
    spendMinor: 0,
    impressions: 0,
    clicks: 0,
    linkClicks: 0,
    results: 0,
    video3s: null,
    thruplays: null,
    ...row,
  }));
}

function features(rows: DayRow[], extra: Partial<Parameters<typeof featuresOf>[0]> = {}) {
  return featuresOf({ rows, today, createdAt: new Date("2026-08-01T00:00:00Z"), now, ...extra });
}

describe("windows", () => {
  it("sums a window and derives the rates", () => {
    const w = windowOf(days(7, { spendMinor: 1_000, impressions: 1_000, linkClicks: 10, results: 2 }), addDays(today, -7), addDays(today, -1));
    expect(w).toMatchObject({ days: 7, spendMinor: 7_000, results: 14, cpaMinor: 500, linkCtr: 0.01, cpmMinor: 1_000 });
  });

  it("keeps unknown results unknown", () => {
    expect(windowOf(days(3, { results: null }), addDays(today, -3), addDays(today, -1)).results).toBeNull();
  });
});

describe("ad set rules", () => {
  const subject = (rows: DayRow[], extra: Partial<Parameters<typeof adSetRules>[0]> = {}) => ({
    externalId: "s1",
    name: "TR women",
    dailyBudgetMinor: 10_000,
    optimizationGoal: "LINK_CLICKS",
    offsite: false,
    features: features(rows),
    minDailyBudgetMinor: 3_500,
    newestAdAgeDays: 10,
    ...extra,
  });

  it("G3 pauses spend without results past 3 × target, from 1,000 impressions", () => {
    const rows = days(7, { spendMinor: 5_000, impressions: 1_000, results: 0 });
    const found = adSetRules(subject(rows), { targetCpaMinor: 10_000, accountLinkCtr: null });
    expect(found.map((c) => c.ruleKey)).toEqual(["G3_ZERO_RESULTS"]);
    expect(found[0]).toMatchObject({ kind: "PAUSE", urgent: true });
    // Under 1,000 impressions: no call.
    expect(
      adSetRules(subject(days(7, { spendMinor: 5_000, impressions: 100, results: 0 })), {
        targetCpaMinor: 10_000,
        accountLinkCtr: null,
      }),
    ).toEqual([]);
  });

  it("G3 falls back to half the weekly plan without a target and ignores unknown results", () => {
    const rows = days(7, { spendMinor: 5_000, impressions: 1_000, results: 0 });
    expect(adSetRules(subject(rows), { targetCpaMinor: null, accountLinkCtr: null })[0]?.evidence.thresholdMinor).toBe(35_000);
    expect(
      adSetRules(subject(days(7, { spendMinor: 9_000, impressions: 2_000, results: null })), {
        targetCpaMinor: 1_000,
        accountLinkCtr: null,
      }),
    ).toEqual([]);
  });

  it("O2 lowers a too-expensive ad set by 25% but never under today's spend × 1.1", () => {
    const rows = [
      ...days(7, { spendMinor: 10_000, impressions: 5_000, results: 2 }),
      { date: today, spendMinor: 8_000, impressions: 100, clicks: 0, linkClicks: 0, results: 0, video3s: null, thruplays: null },
    ];
    const found = adSetRules(subject(rows), { targetCpaMinor: 2_000, accountLinkCtr: null });
    const o2 = found.find((c) => c.ruleKey === "O2_HIGH_CPA");
    expect(o2?.change).toEqual({ field: "dailyBudgetMinor", from: 10_000, to: 8_800 });
  });

  it("O3 scales a cheap ad set with enough results and low frequency", () => {
    const rows = days(7, { spendMinor: 5_000, impressions: 5_000, results: 3 });
    const scale = adSetRules(subject(rows, { features: features(rows, { windowStats: { d7: { frequency: 1.8 } } }) }), {
      targetCpaMinor: 3_000,
      accountLinkCtr: null,
    }).find((c) => c.ruleKey === "O3_SCALE");
    expect(scale?.change).toEqual({ field: "dailyBudgetMinor", from: 10_000, to: 12_000 });
    // Saturated audience: no scaling.
    expect(
      adSetRules(subject(rows, { features: features(rows, { windowStats: { d7: { frequency: 2.6 } } }) }), {
        targetCpaMinor: 3_000,
        accountLinkCtr: null,
      }).some((c) => c.ruleKey === "O3_SCALE"),
    ).toBe(false);
  });

  it("O8 and O14 inform", () => {
    const rows = days(7, { spendMinor: 1_000, impressions: 500, results: 1 });
    const found = adSetRules(
      subject(rows, { features: features(rows, { learningStatus: "FAIL" }), newestAdAgeDays: 50 }),
      { targetCpaMinor: null, accountLinkCtr: null },
    );
    expect(found.map((c) => c.ruleKey).sort()).toEqual(["O14_CREATIVE_CADENCE", "O8_LEARNING_LIMITED"]);
  });
});

describe("ad rules", () => {
  const ad = (rows: DayRow[], extra: Partial<Parameters<typeof adRules>[0]> = {}) => ({
    externalId: "a1",
    name: "Spring",
    features: features(rows),
    siblingsActive: 2,
    adSetSpend7dMinor: 50_000,
    isVideo: false,
    ...extra,
  });

  it("O4 needs at least two fatigue signals", () => {
    const rows = [
      ...days(7, { spendMinor: 1_000, impressions: 1_000, linkClicks: 7 }),
      ...days(7, { spendMinor: 800, impressions: 1_000, linkClicks: 10 }, -8),
      ...days(14, { spendMinor: 800, impressions: 1_000, linkClicks: 10 }, -15),
    ];
    // CTR −30% and CPM +25%: fatigue.
    expect(adRules(ad(rows), { targetCpaMinor: null, accountLinkCtr: null }).map((c) => c.ruleKey)).toContain("O4_FATIGUE");
    // CTR only: not yet.
    const ctrOnly = [
      ...days(7, { spendMinor: 800, impressions: 1_000, linkClicks: 7 }),
      ...days(21, { spendMinor: 800, impressions: 1_000, linkClicks: 10 }, -8),
    ];
    expect(adRules(ad(ctrOnly), { targetCpaMinor: null, accountLinkCtr: null }).map((c) => c.ruleKey)).not.toContain("O4_FATIGUE");
  });

  it("O5 pauses a loser only when others carry the ad set and Meta still feeds it", () => {
    const rows = days(7, { spendMinor: 1_000, impressions: 300, results: 0 });
    const found = adRules(ad(rows), { targetCpaMinor: 2_000, accountLinkCtr: null });
    expect(found.find((c) => c.ruleKey === "O5_LOSER_AD")?.kind).toBe("PAUSE");
    // Meta already starves it (< 5% of the ad set's spend): leave it.
    expect(
      adRules(ad(rows, { adSetSpend7dMinor: 1_000_000 }), { targetCpaMinor: 2_000, accountLinkCtr: null }).some(
        (c) => c.ruleKey === "O5_LOSER_AD",
      ),
    ).toBe(false);
    // Alone in its ad set: leave it.
    expect(
      adRules(ad(rows, { siblingsActive: 1 }), { targetCpaMinor: 2_000, accountLinkCtr: null }).some(
        (c) => c.ruleKey === "O5_LOSER_AD",
      ),
    ).toBe(false);
  });

  it("O6, O7 and O13 watch clicks and video", () => {
    const rows = days(7, { spendMinor: 500, impressions: 500, linkClicks: 2, video3s: 50, thruplays: 5 });
    const found = adRules(ad(rows, { isVideo: true }), { targetCpaMinor: null, accountLinkCtr: 0.01 });
    expect(found.map((c) => c.ruleKey).sort()).toEqual(["O13_WEAK_HOLD", "O6_LOW_CTR", "O7_WEAK_HOOK"]);
  });
});

describe("gates", () => {
  it("protects learning for 72 hours after a significant edit", () => {
    expect(learningBlocks({ learningStatus: "LEARNING", lastSigEditAt: null }, now)).toBe(true);
    expect(learningBlocks({ learningStatus: "SUCCESS", lastSigEditAt: new Date("2026-10-04T12:00:00Z") }, now)).toBe(true);
    expect(learningBlocks({ learningStatus: "SUCCESS", lastSigEditAt: new Date("2026-10-01T00:00:00Z") }, now)).toBe(false);
  });

  it("allows one budget change a day and two edits a week", () => {
    const hourAgo = new Date(now.getTime() - 60 * 60_000);
    expect(rateBlocks("BUDGET_UP", [{ kind: "BUDGET_DOWN", at: hourAgo }], now)).toBe(true);
    expect(rateBlocks("PAUSE", [{ kind: "BUDGET_DOWN", at: hourAgo }], now)).toBe(false);
    const twoDays = new Date(now.getTime() - 2 * 24 * 60 * 60_000);
    expect(rateBlocks("BUDGET_UP", [{ kind: "BUDGET_DOWN", at: twoDays }, { kind: "PAUSE", at: twoDays }], now)).toBe(true);
  });

  it("floors a budget cut", () => {
    expect(floorBudget({ proposedMinor: 5_000, todaySpendMinor: 6_000, minDailyBudgetMinor: 3_500 })).toBe(6_600);
    expect(floorBudget({ proposedMinor: 5_000, todaySpendMinor: 100, minDailyBudgetMinor: 7_000 })).toBe(7_000);
  });
});

describe("stats and identity", () => {
  it("uses the Poisson gate", () => {
    expect(significanceRatio(25)).toBeCloseTo(1.74, 2);
    expect(significanceRatio(100)).toBeCloseTo(1.32, 2);
    expect(outcomeOf("BUDGET_DOWN", { spendMinor: 10_000, results: 50 }, { spendMinor: 5_000, results: 50 }).outcome).toBe("WORKED");
    expect(outcomeOf("BUDGET_UP", { spendMinor: 10_000, results: 20 }, { spendMinor: 30_000, results: 20 }).outcome).toBe("DIDNT");
    expect(outcomeOf("BUDGET_UP", { spendMinor: 10_000, results: 3 }, { spendMinor: 10_000, results: 3 }).outcome).toBe("INCONCLUSIVE");
  });

  it("keys a decision by rule, object and ISO week", () => {
    expect(decisionFingerprint("O2_HIGH_CPA", "s1", now)).toBe("O2_HIGH_CPA:s1:2026-W41");
    expect(decisionFingerprint("O2_HIGH_CPA", "s1", new Date("2026-10-11T23:00:00Z"))).toBe("O2_HIGH_CPA:s1:2026-W41");
    expect(decisionFingerprint("O2_HIGH_CPA", "s1", new Date("2026-10-12T01:00:00Z"))).toBe("O2_HIGH_CPA:s1:2026-W42");
  });

  it("explains with the evidence's own numbers", () => {
    const text = explainDecision(
      {
        ruleKey: "O2_HIGH_CPA",
        ruleVersion: 1,
        kind: "BUDGET_DOWN",
        severity: "WARN",
        urgent: false,
        change: { field: "dailyBudgetMinor", from: 20_000, to: 15_000 },
        evidence: { cpaMinor: 4_800, targetMinor: 3_000 },
      },
      { name: "TR women [agx:abc123]", currency: "TRY" },
    );
    expect(text).toBe(
      "TR women cost 48 TRY per result over 7 days, above the target of 30 TRY. Lowering the daily budget from 200 TRY to 150 TRY cuts the spend while Meta finds cheaper results.",
    );
  });
});
