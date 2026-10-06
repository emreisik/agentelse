import { describe, expect, it, vi } from "vitest";

import type { GaTableRow } from "@/lib/website-analytics/slices";

import { evaluateLandingPages, weeks4 } from "./landing-pages";
import { makeWeeklyInput, makeWindowTables } from "./test-fixtures";
import type {
  An3Evidence,
  GaFindingCandidate,
  GaWeeklyAnalysisInput,
  GaWindowTotals,
} from "./types";

// BH testi için p değerleri sayfanın KE sayısından seçilebilsin; diğer
// testlerde gerçek rateRatioTest çalışır.
const pOverride = vi.hoisted(() => ({
  map: null as Map<number, number> | null,
}));
vi.mock("./stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stats")>();
  return {
    ...actual,
    rateRatioTest: (a: number, ea: number, b: number, eb: number) => {
      const real = actual.rateRatioTest(a, ea, b, eb);
      const p = pOverride.map?.get(a);
      return real && p !== undefined ? { ...real, p } : real;
    },
  };
});

const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };
const W28 = { from: "2026-09-07", to: "2026-10-04" };

function totals(partial: Partial<GaWindowTotals>): GaWindowTotals {
  return {
    sessions: 0,
    engagedSessions: 0,
    keyEvents: 0,
    revenue: 0,
    transactions: 0,
    engagementSec: 0,
    screenPageViews: 0,
    ...partial,
  };
}

function landing(
  path: string,
  sessions: number,
  keyEvents: number,
): GaTableRow {
  return { key: [path], values: [sessions, sessions / 2, keyEvents, 0, 0] };
}

function input(
  rows: GaTableRow[],
  siteTotals: Partial<GaWindowTotals>,
): GaWeeklyAnalysisInput {
  return makeWeeklyInput({
    week: WEEK,
    window28: makeWindowTables(W28, {
      landing: rows,
      totals: totals(siteTotals),
    }),
  });
}

function ev(candidate: GaFindingCandidate): An3Evidence {
  return candidate.evidence as An3Evidence;
}

function variant(candidates: GaFindingCandidate[], v: "cro" | "promote") {
  return candidates.filter((c) => ev(c).variant === v);
}

describe("evaluateLandingPages (AN3)", () => {
  it("threshold is max(100, p75): a small site uses 100", () => {
    const rows = [
      landing("/a", 100, 0),
      landing("/b", 10, 1),
      landing("/c", 10, 1),
      landing("/d", 10, 1),
      landing("/e", 10, 1),
    ];
    const result = evaluateLandingPages(
      input(rows, { sessions: 10_000, keyEvents: 500 }),
    );
    const cro = variant(result, "cro");
    expect(cro).toHaveLength(1);
    expect(ev(cro[0]!).threshold).toBe(100);
    expect(ev(cro[0]!).page).toBe("/a");

    const below = evaluateLandingPages(
      input([landing("/a", 99, 0), ...rows.slice(1)], {
        sessions: 10_000,
        keyEvents: 500,
      }),
    );
    expect(variant(below, "cro")).toHaveLength(0);
  });

  it("threshold follows p75 on larger sites", () => {
    const rows = [
      landing("/a", 100, 10),
      landing("/b", 200, 20),
      landing("/c", 300, 0),
      landing("/d", 400, 40),
      landing("/e", 500, 0),
    ];
    const result = evaluateLandingPages(
      input(rows, { sessions: 10_000, keyEvents: 1_000 }),
    );
    const cro = variant(result, "cro");
    // p75 = 400: /e (500) uygun, /c (300) eşiğin altında.
    expect(cro.map((c) => ev(c).page)).toEqual(["/e"]);
    expect(ev(cro[0]!).threshold).toBe(400);
  });

  it("CRO needs rate strictly below 0.5 × restRate", () => {
    // rest: 9000 oturum, 900 KE → oran 0,1.
    const at = evaluateLandingPages(
      input([landing("/p", 1_000, 50)], { sessions: 10_000, keyEvents: 950 }),
    );
    expect(variant(at, "cro")).toHaveLength(0);
    const under = evaluateLandingPages(
      input([landing("/p", 1_000, 49)], { sessions: 10_000, keyEvents: 949 }),
    );
    expect(variant(under, "cro")).toHaveLength(1);
    expect(ev(under[0]!).rate).toBeCloseTo(0.049, 10);
    expect(ev(under[0]!).restRate).toBeCloseTo(0.1, 10);
  });

  it("SIGNIFICANT needs ≥200 sessions", () => {
    const at = evaluateLandingPages(
      input([landing("/p", 200, 0)], { sessions: 10_000, keyEvents: 980 }),
    );
    expect(at[0]!.confidence).toBe("SIGNIFICANT");
    expect(at[0]!.severity).toBe("WARN");
    expect(at[0]!.kind).toBe("OPPORTUNITY");
    const under = evaluateLandingPages(
      input([landing("/p", 199, 0)], { sessions: 10_000, keyEvents: 980 }),
    );
    expect(under[0]!.confidence).toBe("DIRECTIONAL");
    expect(under[0]!.severity).toBe("INFO");
    expect(under[0]!.impact?.directional).toBe(true);
  });

  it("BH demotes a borderline p < 0.05 in a family of five", () => {
    pOverride.map = new Map([
      [1, 0.001],
      [2, 0.045],
      [3, 0.07],
      [4, 0.5],
      [5, 0.6],
    ]);
    try {
      const rows = [1, 2, 3, 4, 5].map((k) => landing(`/p${k}`, 1_000, k));
      const result = variant(
        evaluateLandingPages(
          input(rows, { sessions: 10_000, keyEvents: 1_015 }),
        ),
        "cro",
      );
      expect(result.map((c) => ev(c).page)).toEqual(["/p1", "/p2", "/p3"]);
      expect(result.map((c) => c.confidence)).toEqual([
        "SIGNIFICANT",
        "DIRECTIONAL",
        "DIRECTIONAL",
      ]);
      expect(ev(result[1]!).p).toBe(0.045);
      expect(ev(result[1]!).bhAccepted).toBe(false);
      expect(ev(result[0]!).bhAccepted).toBe(true);
    } finally {
      pOverride.map = null;
    }
  });

  it("promote needs 100 ≤ sessions and ≥10 key events", () => {
    const big = [
      landing("/big1", 1_000, 30),
      landing("/big2", 1_000, 30),
      landing("/big3", 1_000, 30),
    ];
    const site = { sessions: 10_000, keyEvents: 300 };
    const ok = variant(
      evaluateLandingPages(input([...big, landing("/p", 100, 10)], site)),
      "promote",
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.kind).toBe("WIN");
    expect(ok[0]!.severity).toBe("INFO");
    expect(ok[0]!.impact?.directional).toBe(true);
    expect(ok[0]!.impact?.perWeek).toBe(weeks4(10));

    expect(
      variant(
        evaluateLandingPages(input([...big, landing("/p", 99, 10)], site)),
        "promote",
      ),
    ).toHaveLength(0);
    expect(
      variant(
        evaluateLandingPages(input([...big, landing("/p", 100, 9)], site)),
        "promote",
      ),
    ).toHaveLength(0);
  });

  it("caps CRO at 3 and promote at 2", () => {
    const cro = [1, 2, 3, 4, 5].map((k) => landing(`/c${k}`, 2_000, 0));
    const promote = [1, 2, 3].map((k) => landing(`/w${k}`, 150, 40 + k));
    const others = [1, 2, 3, 4, 5, 6].map((k) => landing(`/o${k}`, 2_000, 200));
    const result = evaluateLandingPages(
      input([...cro, ...promote, ...others], {
        sessions: 40_000,
        keyEvents: 2_000,
      }),
    );
    expect(variant(result, "cro")).toHaveLength(3);
    const winners = variant(result, "promote");
    expect(winners.map((c) => ev(c).page)).toEqual(["/w3", "/w2"]);
  });

  it("ignores (not set) rows", () => {
    const result = evaluateLandingPages(
      input([landing("(not set)", 5_000, 0), landing("", 5_000, 0)], {
        sessions: 20_000,
        keyEvents: 1_000,
      }),
    );
    expect(result).toEqual([]);
  });

  it("CRO impact has low ≤ perWeek ≤ high and the share formula", () => {
    const result = evaluateLandingPages(
      input([landing("/p", 1_000, 10)], { sessions: 10_000, keyEvents: 910 }),
    );
    const impact = result[0]!.impact!;
    expect(impact.metric).toBe("keyEvents");
    expect(impact.low).toBeGreaterThanOrEqual(0);
    expect(impact.low).toBeLessThanOrEqual(impact.perWeek);
    expect(impact.perWeek).toBeLessThanOrEqual(impact.high);
    // (0,1 − 0,01) · 1000 / 4
    expect(impact.perWeek).toBeCloseTo(22.5, 10);
    expect(result[0]!.impactShare).toBeCloseTo(22.5 / (910 / 4), 10);
    expect(result[0]!.period.grain).toBe("WINDOW28");
    expect(result[0]!.period.from).toBe(W28.from);
    expect(result[0]!.subject).toBe("page:/p");
  });

  it("promote impact interval brackets the weekly key events", () => {
    const result = evaluateLandingPages(
      input(
        [
          landing("/big1", 1_000, 30),
          landing("/big2", 1_000, 30),
          landing("/big3", 1_000, 30),
          landing("/p", 150, 20),
        ],
        { sessions: 10_000, keyEvents: 300 },
      ),
    );
    const impact = variant(result, "promote")[0]!.impact!;
    expect(impact.low).toBeLessThanOrEqual(impact.perWeek);
    expect(impact.perWeek).toBeLessThanOrEqual(impact.high);
  });

  it("a page with more key events than sessions still gives a finite test", () => {
    const result = evaluateLandingPages(
      input(
        [
          landing("/big1", 1_000, 30),
          landing("/big2", 1_000, 30),
          landing("/big3", 1_000, 30),
          landing("/p", 150, 300),
        ],
        { sessions: 10_000, keyEvents: 600 },
      ),
    );
    const promote = variant(result, "promote")[0]!;
    expect(ev(promote).rate).toBe(2);
    expect(ev(promote).p).not.toBeNull();
    expect(Number.isFinite(ev(promote).p)).toBe(true);
    expect(Number.isFinite(ev(promote).ratio)).toBe(true);
  });
});
