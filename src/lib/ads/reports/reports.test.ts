import { describe, expect, it } from "vitest";

import { learningText } from "@/server/ads/reports/learnings";

import { diagnose } from "./diagnose";
import { adLibraryUrl, monthlyReportText, shadowLine, weeklyReportText } from "./report-text";

describe("diagnose", () => {
  it("splits the cost change into CPM, CTR and conversion", () => {
    // CPM 10 → 13 (+30%), CTR flat, CVR 10% → 9.5% (−5%).
    const before = { spendMinor: 10_000, impressions: 1_000_000, linkClicks: 10_000, results: 1_000 };
    const after = { spendMinor: 13_000, impressions: 1_000_000, linkClicks: 10_000, results: 950 };
    const result = diagnose(after, before)!;
    expect(result.cpm).toBeCloseTo(0.3, 5);
    expect(result.ctr).toBeCloseTo(0, 5);
    expect(result.cvr).toBeCloseTo(-0.05, 5);
    // The parts add up (in logs) to the cost change.
    expect(Math.exp(result.shares.cpm + result.shares.ctr + result.shares.cvr) - 1).toBeCloseTo(result.cpa, 10);
    expect(result.text).toBe(
      "Cost per result +37%: CPM +30% (auction or season), link CTR flat, conversion −5% (page, offer or form).".replace("−", "-"),
    );
  });

  it("needs clicks and results on both sides", () => {
    expect(diagnose({ spendMinor: 1, impressions: 1, linkClicks: 0, results: 1 }, { spendMinor: 1, impressions: 1, linkClicks: 1, results: 1 })).toBeNull();
  });
});

describe("report texts", () => {
  const totals = {
    spendMinor: 120_000,
    results: 40,
    resultLabel: "Conversations started",
    impressions: 50_000,
    linkClicks: 900,
    reach: 21_000,
    frequency: 2.4,
  };

  it("labels attribution and immature days, and takes reach from the period read", () => {
    const text = weeklyReportText({
      periodLabel: "2026-09-28 – 2026-10-04",
      currency: "TRY",
      current: totals,
      previous: { ...totals, spendMinor: 100_000, results: 30, reach: null, frequency: null },
      target: { label: "cost per conversation", valueMinor: 3_500 },
      diagnosis: null,
      creatives: [{ name: "Spring [agx:abc123]", spendMinor: 50_000, results: 20 }],
      decisions: [{ text: "Lowered the budget", outcome: "WORKED" }],
      pending: 1,
      metaSuggests: ["Use Advantage+ placements"],
      attribution: "7-day click, 1-day view",
    });
    expect(text).toContain("Spent 1,200 TRY (+20% vs the week before).");
    expect(text).toContain("40 conversations started at 30 TRY each.");
    expect(text).toContain("On target: cost per conversation 35 TRY or less.");
    expect(text).toContain("Reached 21,000 people, each about 2.4 times.");
    expect(text).toContain("• Spring: 500 TRY, 20 results");
    expect(text).toContain("never applied by itself");
    expect(text).toContain("attribution 7-day click, 1-day view, account time. Recent days may still change.");
  });

  it("asks for the reconciliation in the monthly report", () => {
    const text = monthlyReportText({
      monthLabel: "2026-09",
      currency: "TRY",
      totals,
      goals: [{ title: "Keep the cost per lead under 30 TRY", current: 27, target: 30 }],
      decisionsWorked: 2,
      decisionsTotal: 3,
      learnings: 1,
      nextEnvelopeMinor: 310_000,
      adLibraryUrl: adLibraryUrl("TR"),
    });
    expect(text).toContain("How many new customers did you get from ads last month?");
    expect(text).toContain("2 of 3 changes clearly worked.");
    expect(text).toContain("country=TR");
  });
});

describe("learnings", () => {
  it("states n and marks small samples directional", () => {
    expect(learningText({ ruleKey: "O2_HIGH_CPA", kind: "BUDGET_DOWN", outcome: "WORKED", ratio: 0.72, n: 34 })).toBe(
      "Lowering the budget of an expensive ad set cut the cost per result by 28% (n=34).",
    );
    expect(learningText({ ruleKey: "O3_SCALE", kind: "BUDGET_UP", outcome: "DIDNT", ratio: 1.45, n: 12 })).toBe(
      "A 20% budget increase pushed the cost per result up 45% (n=12, directional).",
    );
  });
});

describe("shadowLine", () => {
  const card = {
    kinds: [],
    total: 24,
    persistence: 0.75,
    agreement: 0.5,
    exposureMinor: 12_000,
    readiness: "READY" as const,
  };

  it("says how many were judged, how many held, and whether you agreed", () => {
    const line = shadowLine(card, "EUR");
    expect(line).toContain("24 judged");
    expect(line).toContain("75% still pointed at a real problem");
    expect(line).toContain("same change on 50%");
    expect(line).toContain("Enough evidence");
  });

  it("is honest when it is not ready", () => {
    expect(shadowLine({ ...card, readiness: "NOT_YET" }, "EUR")).toContain(
      "Not enough judged suggestions yet",
    );
    expect(shadowLine({ ...card, readiness: "NOISY" }, "EUR")).toContain(
      "not ready to act",
    );
  });

  it("is added to the weekly text only when there is a card", () => {
    const totals = {
      spendMinor: 0,
      impressions: 0,
      linkClicks: 0,
      results: null,
      resultLabel: "Results",
      reach: null,
      frequency: null,
    };
    const base = {
      periodLabel: "w",
      currency: "EUR",
      current: totals,
      previous: totals,
      target: null,
      diagnosis: null,
      creatives: [],
      decisions: [],
      pending: 0,
      metaSuggests: [],
      attribution: null,
    };
    expect(weeklyReportText({ ...base, shadow: card })).toContain("Optimizer test run");
    expect(weeklyReportText({ ...base, shadow: null })).not.toContain("Optimizer test run");
  });
});
