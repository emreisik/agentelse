import { describe, expect, it } from "vitest";

import {
  humanAgreed,
  scorecardOf,
  shadowVerdict,
  type ShadowRow,
} from "./shadow-score";

const side = (spendMinor: number, results: number) => ({ spendMinor, results });

describe("shadowVerdict (risk-reducing kinds)", () => {
  it("persisted: still spending with no results", () => {
    const out = shadowVerdict("PAUSE", side(5_000, 0), side(4_000, 0));
    expect(out).toMatchObject({ verdict: "PERSISTED", exposureMinor: 4_000 });
  });

  it("persisted: the cost per result did not improve", () => {
    const out = shadowVerdict("BUDGET_DOWN", side(10_000, 20), side(10_000, 19));
    expect(out.verdict).toBe("PERSISTED");
    expect(out.exposureMinor).toBe(10_000);
  });

  it("resolved: the cost per result fell clearly by itself", () => {
    const out = shadowVerdict("BUDGET_DOWN", side(10_000, 10), side(10_000, 40));
    expect(out.verdict).toBe("RESOLVED");
    expect(out.exposureMinor).toBe(0);
  });

  it("resolved: it started to bring results after none", () => {
    const out = shadowVerdict("PAUSE", side(6_000, 0), side(6_000, 8));
    expect(out.verdict).toBe("RESOLVED");
  });

  it("inconclusive: nothing was spent afterwards", () => {
    expect(shadowVerdict("PAUSE", side(6_000, 0), side(0, 0)).verdict).toBe("INCONCLUSIVE");
  });

  it("inconclusive on too few results", () => {
    expect(shadowVerdict("BUDGET_DOWN", side(10_000, 3), side(10_000, 4)).verdict).toBe(
      "INCONCLUSIVE",
    );
  });

  it("does not score kinds it cannot judge", () => {
    expect(shadowVerdict("NOTIFY", side(1, 1), side(1, 1)).verdict).toBe("INCONCLUSIVE");
  });
});

describe("shadowVerdict (BUDGET_UP)", () => {
  it("persisted: efficiency held", () => {
    const out = shadowVerdict("BUDGET_UP", side(10_000, 30), side(10_000, 31));
    expect(out).toMatchObject({ verdict: "PERSISTED", exposureMinor: 0 });
  });

  it("resolved: efficiency clearly got worse, scaling would have hit a weak signal", () => {
    expect(shadowVerdict("BUDGET_UP", side(10_000, 40), side(10_000, 10)).verdict).toBe(
      "RESOLVED",
    );
  });
});

describe("humanAgreed", () => {
  const now = (o: Partial<{ configuredStatus: string | null; dailyBudgetMinor: number | null; gone: boolean }>) => ({
    configuredStatus: "ACTIVE",
    dailyBudgetMinor: 5_000,
    gone: false,
    ...o,
  });

  it("pause: agreed when the object is paused or gone", () => {
    expect(humanAgreed("PAUSE", null, now({ configuredStatus: "PAUSED" }))).toBe(true);
    expect(humanAgreed("PAUSE", null, now({ gone: true }))).toBe(true);
    expect(humanAgreed("PAUSE", null, now({}))).toBe(false);
    expect(humanAgreed("PAUSE", null, now({ configuredStatus: null }))).toBeNull();
  });

  it("budget: agreed when it moved the suggested way", () => {
    const change = { field: "dailyBudgetMinor", from: 8_000, to: 6_400 };
    expect(humanAgreed("BUDGET_DOWN", change, now({ dailyBudgetMinor: 6_000 }))).toBe(true);
    expect(humanAgreed("BUDGET_DOWN", change, now({ dailyBudgetMinor: 8_000 }))).toBe(false);
    expect(humanAgreed("BUDGET_UP", { from: 5_000 }, now({ dailyBudgetMinor: 6_000 }))).toBe(true);
    expect(humanAgreed("BUDGET_UP", null, now({}))).toBeNull();
  });
});

describe("scorecardOf", () => {
  const rows = (n: number, persisted: number): ShadowRow[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "PAUSE",
      verdict: i < persisted ? ("PERSISTED" as const) : ("RESOLVED" as const),
      exposureMinor: i < persisted ? 1_000 : 0,
      humanAgreed: i % 2 === 0,
    }));

  it("is not ready until enough decisions were judged", () => {
    const card = scorecardOf(rows(10, 9));
    expect(card.readiness).toBe("NOT_YET");
    expect(card.persistence).toBeCloseTo(0.9);
  });

  it("is ready when enough were judged and most flagged a real problem", () => {
    const card = scorecardOf(rows(30, 24));
    expect(card).toMatchObject({ readiness: "READY", total: 30, exposureMinor: 24_000 });
    expect(card.agreement).toBeCloseTo(0.5);
  });

  it("is noisy when too many problems went away by themselves", () => {
    expect(scorecardOf(rows(30, 12)).readiness).toBe("NOISY");
  });

  it("does not count inconclusive rows as right or wrong", () => {
    const card = scorecardOf([
      ...rows(20, 20),
      { kind: "PAUSE", verdict: "INCONCLUSIVE", exposureMinor: 0, humanAgreed: null },
    ]);
    expect(card.persistence).toBe(1);
    expect(card.kinds[0]?.inconclusive).toBe(1);
  });
});
