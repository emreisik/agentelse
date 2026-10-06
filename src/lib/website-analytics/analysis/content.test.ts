import { describe, expect, it } from "vitest";

import type { GaTableRow } from "@/lib/website-analytics/slices";

import {
  CONTENT_PATH_PATTERN,
  evaluateContentEngagement,
  evaluateNotFound,
  NOT_FOUND_PATH_PATTERN,
  NOT_FOUND_TITLE_PATTERN,
} from "./content";
import { makeWeeklyInput, makeWindowTables } from "./test-fixtures";
import type {
  An9Evidence,
  An10Evidence,
  GaWeeklyAnalysisInput,
  GaWindowTotals,
} from "./types";

const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };
const MONTH = { from: "2026-09-01", to: "2026-09-30" };

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

function page(path: string, title: string, views: number): GaTableRow {
  return { key: [path, title], values: [views, 0] };
}

function weekInput(rows: GaTableRow[], views = 1_000): GaWeeklyAnalysisInput {
  return makeWeeklyInput({
    week: WEEK,
    current: makeWindowTables(
      { from: WEEK.monday, to: WEEK.sunday },
      { pages: rows, totals: totals({ screenPageViews: views }) },
    ),
  });
}

describe("NOT_FOUND patterns", () => {
  it("match 404 titles in English, Turkish and Macedonian", () => {
    expect(NOT_FOUND_TITLE_PATTERN.test("Page not found – Acme")).toBe(true);
    expect(NOT_FOUND_TITLE_PATTERN.test("404 | Acme")).toBe(true);
    expect(NOT_FOUND_TITLE_PATTERN.test("Sayfa bulunamadı")).toBe(true);
    expect(NOT_FOUND_TITLE_PATTERN.test("Страницата не е пронајдена")).toBe(
      true,
    );
    expect(NOT_FOUND_TITLE_PATTERN.test("Running shoes 4040")).toBe(false);
  });

  it("match 404 paths", () => {
    expect(NOT_FOUND_PATH_PATTERN.test("/404")).toBe(true);
    expect(NOT_FOUND_PATH_PATTERN.test("/en/page-not-found/")).toBe(true);
    expect(NOT_FOUND_PATH_PATTERN.test("/404.html")).toBe(true);
    expect(NOT_FOUND_PATH_PATTERN.test("/products/4040")).toBe(false);
  });
});

describe("evaluateNotFound (AN9)", () => {
  it("needs ≥10 views across matching pages (TR, MK, EN titles)", () => {
    const rows = [
      page("/a", "Sayfa bulunamadı", 4),
      page("/b", "Страницата не е пронајдена", 3),
      page("/c", "Page not found", 2),
      page("/shop", "Shop", 500),
    ];
    expect(evaluateNotFound(weekInput(rows))).toBeNull();
    const candidate = evaluateNotFound(
      weekInput([...rows, page("/missing/404", "Acme", 1)]),
    )!;
    const evidence = candidate.evidence as An9Evidence;
    expect(evidence.views).toBe(10);
    expect(evidence.pages.map((p) => p.path)).toEqual([
      "/a",
      "/b",
      "/c",
      "/missing/404",
    ]);
    expect(candidate.kind).toBe("RISK");
    expect(candidate.severity).toBe("INFO");
    expect(candidate.subject).toBe("notfound");
    expect(candidate.period).toMatchObject({
      grain: "WEEK",
      from: WEEK.monday,
      to: WEEK.sunday,
    });
  });

  it("is SIGNIFICANT from 30 views", () => {
    expect(
      evaluateNotFound(weekInput([page("/404", "x", 29)]))!.confidence,
    ).toBe("DIRECTIONAL");
    expect(
      evaluateNotFound(weekInput([page("/404", "x", 30)]))!.confidence,
    ).toBe("SIGNIFICANT");
  });

  it("lists the top 5 masked pages and derives impact and share", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) =>
      page(
        `/404?u=${n}&e=jane@example.com`,
        `Not found jane${n}@example.com`,
        n * 10,
      ),
    );
    const candidate = evaluateNotFound(weekInput(rows, 420))!;
    const evidence = candidate.evidence as An9Evidence;
    expect(evidence.views).toBe(210);
    expect(evidence.pages).toHaveLength(5);
    expect(evidence.pages[0]).toEqual({
      path: "/404",
      title: "Not found [email]",
      views: 60,
    });
    expect(candidate.impact).toEqual({
      metric: "views",
      perWeek: 210,
      low: 210,
      high: 210,
      directional: false,
    });
    expect(candidate.impactShare).toBeCloseTo(0.5, 10);
  });
});

describe("CONTENT_PATH_PATTERN", () => {
  it.each([
    ["/blog/how-to", true],
    ["/en/blog/how-to", true],
    ["/tr-tr/haberler/x", true],
    ["/makaleler", true],
    ["/NEWS/", true],
    ["/mk/vesti/a", true],
    ["/blogger", false],
    ["/products/blog", false],
    ["/", false],
  ])("%s → %s", (path, expected) => {
    expect(CONTENT_PATH_PATTERN.test(path)).toBe(expected);
  });
});

describe("evaluateContentEngagement (AN10)", () => {
  function landing(
    path: string,
    sessions: number,
    engaged: number,
    seconds: number,
  ): GaTableRow {
    return { key: [path], values: [sessions, engaged, 1, 0, seconds] };
  }

  function monthInput(rows: GaTableRow[] | null): GaWeeklyAnalysisInput {
    return makeWeeklyInput({
      week: WEEK,
      holidays: new Set(["2026-09-15", "2026-10-02"]),
      month:
        rows === null
          ? null
          : {
              month: "2026-09",
              current: makeWindowTables(MONTH, {
                landing: rows,
                totals: totals({
                  sessions: 10_000,
                  engagedSessions: 5_000,
                  engagementSec: 300_000,
                }),
              }),
              previous: makeWindowTables({
                from: "2026-08-01",
                to: "2026-08-31",
              }),
            },
    });
  }

  it("needs the month", () => {
    expect(evaluateContentEngagement(monthInput(null))).toBeNull();
  });

  it("needs ≥2 content rows at ≥1.2 × site engagement", () => {
    const one = [
      landing("/blog/a", 100, 80, 6_000),
      landing("/blog/b", 100, 50, 6_000),
      landing("/shop", 1_000, 900, 60_000),
    ];
    expect(evaluateContentEngagement(monthInput(one))).toBeNull();

    const two = [
      landing("/blog/a", 100, 80, 6_000),
      landing("/blog/b", 100, 60, 9_000),
      landing("/blog/c", 49, 49, 9_000),
      landing("/shop", 1_000, 900, 60_000),
    ];
    const candidate = evaluateContentEngagement(monthInput(two))!;
    const evidence = candidate.evidence as An10Evidence;
    // 0,6 · 90 = 54 > 0,8 · 60 = 48
    expect(evidence.pages.map((p) => p.path)).toEqual(["/blog/b", "/blog/a"]);
    expect(evidence.siteEngagementRate).toBe(0.5);
    expect(evidence.siteAvgEngagementSec).toBe(30);
    expect(evidence.month).toBe("2026-09");
    expect(evidence.holidays).toEqual(["2026-09-15"]);
    expect(candidate).toMatchObject({
      ruleKey: "AN10",
      kind: "WIN",
      confidence: "DIRECTIONAL",
      severity: "INFO",
      impact: null,
      impactShare: 0.1,
      subject: "content",
    });
    expect(candidate.period).toMatchObject({
      grain: "MONTH",
      from: MONTH.from,
      to: MONTH.to,
      key: "2026-09",
    });
  });
});
