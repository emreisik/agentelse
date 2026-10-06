import { describe, expect, it } from "vitest";

import { evaluateSiteSearch } from "./site-search";
import { makeWeeklyInput, makeWindowTables } from "./test-fixtures";
import type { An8Evidence, GaWeeklyAnalysisInput } from "./types";

const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };
const W28 = { from: "2026-09-07", to: "2026-10-04" };

type Week = { monday: string; terms: Record<string, number> };

function input(weeks: Week[] | null, sessions = 1_000): GaWeeklyAnalysisInput {
  return makeWeeklyInput({
    week: WEEK,
    window28: makeWindowTables(W28, {
      totals: {
        sessions,
        engagedSessions: 0,
        keyEvents: 0,
        revenue: 0,
        transactions: 0,
        engagementSec: 0,
        screenPageViews: 0,
      },
    }),
    siteSearch:
      weeks?.map((week) => ({
        monday: week.monday,
        rows: Object.entries(week.terms).map(([term, count]) => ({
          key: [term],
          values: [count],
        })),
      })) ?? null,
  });
}

describe("evaluateSiteSearch (AN8)", () => {
  it("is null without GA_WEEKLY data", () => {
    expect(evaluateSiteSearch(input(null))).toBeNull();
    expect(evaluateSiteSearch(input([]))).toBeNull();
  });

  it("needs ≥5 searches for a term across the weeks", () => {
    const four = evaluateSiteSearch(
      input([
        { monday: "2026-09-21", terms: { shoes: 2 } },
        { monday: "2026-09-28", terms: { shoes: 2 } },
      ]),
    );
    expect(four).toBeNull();
    const five = evaluateSiteSearch(
      input([
        { monday: "2026-09-21", terms: { shoes: 2 } },
        { monday: "2026-09-28", terms: { shoes: 3 } },
      ]),
    );
    expect(five).not.toBeNull();
    const evidence = five!.evidence as An8Evidence;
    expect(evidence.terms).toEqual([{ term: "shoes", searches: 5 }]);
    expect(evidence.weeks).toEqual(["2026-09-21", "2026-09-28"]);
  });

  it("drops masked-only, empty and long terms", () => {
    expect(
      evaluateSiteSearch(
        input([
          {
            monday: "2026-09-28",
            terms: {
              "[email]": 50,
              "[phone] [id]": 50,
              "": 50,
              ["x".repeat(81)]: 50,
            },
          },
        ]),
      ),
    ).toBeNull();
    const kept = evaluateSiteSearch(
      input([{ monday: "2026-09-28", terms: { "[email] return policy": 9 } }]),
    );
    expect((kept!.evidence as An8Evidence).terms[0]!.term).toBe(
      "[email] return policy",
    );
  });

  it("uses at most 4 weeks up to the target week and keeps the top 10", () => {
    const terms: Record<string, number> = {};
    for (let i = 0; i < 12; i++) terms[`term ${i}`] = 10 + i;
    const candidate = evaluateSiteSearch(
      input([
        { monday: "2026-08-31", terms: { old: 100 } },
        { monday: "2026-09-07", terms },
        { monday: "2026-09-14", terms: {} },
        { monday: "2026-09-21", terms: {} },
        { monday: "2026-09-28", terms: {} },
        { monday: "2026-10-05", terms: { future: 100 } },
      ]),
    )!;
    const evidence = candidate.evidence as An8Evidence;
    expect(evidence.weeks).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
    expect(evidence.terms).toHaveLength(10);
    expect(evidence.terms[0]).toEqual({ term: "term 11", searches: 21 });
    expect(evidence.terms.some((t) => t.term === "old")).toBe(false);
  });

  it("is a DIRECTIONAL INFO opportunity with impact null", () => {
    const candidate = evaluateSiteSearch(
      input([{ monday: "2026-09-28", terms: { shoes: 30, socks: 2 } }], 100),
    )!;
    expect(candidate.kind).toBe("OPPORTUNITY");
    expect(candidate.confidence).toBe("DIRECTIONAL");
    expect(candidate.severity).toBe("INFO");
    expect(candidate.impact).toBeNull();
    expect(candidate.subject).toBe("site_search");
    expect(candidate.period).toMatchObject({
      grain: "WINDOW28",
      from: W28.from,
      to: W28.to,
    });
    expect((candidate.evidence as An8Evidence).totalSearches).toBe(32);
    expect(candidate.impactShare).toBeCloseTo(0.32, 10);
    expect(
      evaluateSiteSearch(
        input([{ monday: "2026-09-28", terms: { shoes: 300 } }], 100),
      )!.impactShare,
    ).toBe(1);
  });
});
