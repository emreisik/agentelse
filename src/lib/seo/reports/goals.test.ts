import { describe, expect, it } from "vitest";

import {
  PACE_HORIZON_WEEKS,
  PACE_LABEL,
  PACE_MIN_POINTS,
  SEO_GOAL_METRICS,
  goalPace,
  isSeoGoalMetric,
  linearTrend,
  seoGoalTitle,
  validSeoGoalTarget,
} from "./goals";
import { SEO_GOAL_METRIC_KEYS, type GoalSeriesPoint } from "./types";

function weekly(values: readonly number[]): GoalSeriesPoint[] {
  return values.map((value, index) => {
    const date = new Date(Date.UTC(2026, 0, 5 + index * 7));
    return { week: date.toISOString().slice(0, 10), value };
  });
}

describe("catalog", () => {
  it("describes every goal key", () => {
    expect(Object.keys(SEO_GOAL_METRICS).sort()).toEqual(
      [...SEO_GOAL_METRIC_KEYS].sort(),
    );
    expect(SEO_GOAL_METRICS["gsc.nonBrandClicks"]).toEqual({
      label: "Non-brand search clicks a month",
      unit: "count",
      needs: "brand_split",
      window: "last 30 days",
    });
    expect(SEO_GOAL_METRICS["seo.cwvGoodShare"].needs).toBe("cwv");
    expect(SEO_GOAL_METRICS["seo.indexedShare"].needs).toBe("health");
    expect(SEO_GOAL_METRICS["gsc.clicks"].needs).toBeNull();
  });

  it("recognises goals by exact key only", () => {
    for (const key of SEO_GOAL_METRIC_KEYS) expect(isSeoGoalMetric(key)).toBe(true);
    for (const value of [
      "seo.traffic",
      "gsc.other",
      "gsc.clicks.extra",
      "gsc.",
      "GSC.clicks",
      "",
      null,
      undefined,
      5,
    ]) {
      expect(isSeoGoalMetric(value)).toBe(false);
    }
  });

  it("titles every goal", () => {
    expect(seoGoalTitle("gsc.nonBrandClicks", 1200)).toBe(
      "Reach 1,200 non-brand search clicks a month",
    );
    expect(seoGoalTitle("gsc.clicks", 1200)).toBe(
      "Reach 1,200 search clicks a month",
    );
    expect(seoGoalTitle("gsc.top10Queries", 40)).toBe(
      "Get 40 non-brand searches into Google's top 10",
    );
    expect(seoGoalTitle("seo.indexedShare", 90)).toBe(
      "Keep 90% of pages indexed by Google",
    );
    expect(seoGoalTitle("seo.cwvGoodShare", 75)).toBe(
      "Get 75% of pages to good Core Web Vitals",
    );
  });

  it("validates targets", () => {
    expect(validSeoGoalTarget("gsc.clicks", 1000)).toBe(true);
    expect(validSeoGoalTarget("gsc.clicks", 10_000_000)).toBe(true);
    expect(validSeoGoalTarget("gsc.clicks", 10_000_001)).toBe(false);
    expect(validSeoGoalTarget("gsc.clicks", 12.5)).toBe(false);
    expect(validSeoGoalTarget("gsc.clicks", 0)).toBe(false);
    expect(validSeoGoalTarget("gsc.clicks", -3)).toBe(false);
    expect(validSeoGoalTarget("gsc.clicks", Number.NaN)).toBe(false);
    expect(validSeoGoalTarget("gsc.clicks", Number.POSITIVE_INFINITY)).toBe(false);
    expect(validSeoGoalTarget("seo.indexedShare", 100)).toBe(true);
    expect(validSeoGoalTarget("seo.indexedShare", 87.5)).toBe(true);
    expect(validSeoGoalTarget("seo.indexedShare", 101)).toBe(false);
    expect(validSeoGoalTarget("seo.cwvGoodShare", 0)).toBe(false);
  });
});

describe("linearTrend", () => {
  it("is null below two points", () => {
    expect(linearTrend([])).toBeNull();
    expect(linearTrend([3])).toBeNull();
  });

  it("fits an exact line", () => {
    const fit = linearTrend([2, 4, 6, 8]);
    expect(fit?.slope).toBeCloseTo(2);
    expect(fit?.intercept).toBeCloseTo(2);
    expect(fit?.residualSd).toBeCloseTo(0);
    expect(fit?.n).toBe(4);
  });

  it("measures the scatter around the line", () => {
    const fit = linearTrend([1, 3, 2, 4, 3]);
    expect(fit?.residualSd).toBeGreaterThan(0);
  });
});

describe("goalPace", () => {
  it("is unknown without a value or a target", () => {
    expect(
      goalPace({ current: null, target: 100, series: weekly([1, 2, 3, 4, 5, 6]) }),
    ).toMatchObject({ pace: "unknown", reason: "no_value" });
    expect(
      goalPace({ current: 10, target: null, series: weekly([1, 2, 3, 4, 5, 6]) }),
    ).toMatchObject({ pace: "unknown", reason: "no_target" });
  });

  it("is achieved at or above the target, even with no history", () => {
    expect(goalPace({ current: 100, target: 100, series: [] })).toMatchObject({
      pace: "achieved",
      reason: null,
    });
    expect(goalPace({ current: 150, target: 100, series: [] }).pace).toBe(
      "achieved",
    );
  });

  it("is unknown with a short history", () => {
    expect(PACE_MIN_POINTS).toBe(6);
    expect(
      goalPace({ current: 10, target: 100, series: weekly([1, 2, 3, 4, 5]) }),
    ).toMatchObject({ pace: "unknown", reason: "short_history" });
  });

  it("is on track when even the low end reaches the target", () => {
    const values = Array.from({ length: 13 }, (_, i) => 100 + i * 10);
    const result = goalPace({ current: 220, target: 300, series: weekly(values) });
    expect(result.pace).toBe("on_track");
    // 12 + 13 = 25. nokta: 100 + 250.
    expect(result.projected).toBe(350);
    expect(result.low).toBe(350);
    expect(result.high).toBe(350);
    expect(result.slopePerWeek).toBe(10);
  });

  it("is behind when even the high end misses the target", () => {
    const values = [100, 101, 99, 100, 100, 101, 99, 100];
    const result = goalPace({ current: 100, target: 300, series: weekly(values) });
    expect(result.pace).toBe("behind");
    expect(result.high).toBeLessThan(300);
  });

  it("is at risk when the band straddles the target", () => {
    const values = [100, 130, 90, 140, 110, 150, 120, 160, 130, 170, 140, 180, 150];
    const result = goalPace({ current: 150, target: 220, series: weekly(values) });
    expect(result.pace).toBe("at_risk");
    expect(result.low ?? 0).toBeLessThan(220);
    expect(result.high ?? 0).toBeGreaterThanOrEqual(220);
  });

  it("uses only the last 13 weeks", () => {
    const recent = [100, 130, 90, 140, 110, 150, 120, 160, 130, 170, 140, 180, 150];
    expect(PACE_HORIZON_WEEKS).toBe(13);
    const long = goalPace({
      current: 150,
      target: 220,
      series: weekly([900, 5, 700, 3, 500, 1, 800, ...recent]),
    });
    const short = goalPace({ current: 150, target: 220, series: weekly(recent) });
    expect(long.projected).toBe(short.projected);
  });

  it("orders the series by week", () => {
    const values = Array.from({ length: 8 }, (_, i) => 100 + i * 10);
    const ordered = weekly(values);
    const shuffled = [...ordered].reverse();
    expect(
      goalPace({ current: 170, target: 400, series: shuffled }).projected,
    ).toBe(goalPace({ current: 170, target: 400, series: ordered }).projected);
  });

  it("clamps a percent goal to 100", () => {
    const result = goalPace({
      current: 90,
      target: 99,
      series: weekly([80, 82, 84, 86, 88, 90]),
      max: 100,
    });
    expect(result.projected).toBe(100);
    expect(result.high).toBe(100);
    expect(result.pace).toBe("on_track");
  });

  it("clamps the projection at zero", () => {
    const result = goalPace({
      current: 5,
      target: 50,
      series: weekly([60, 50, 40, 30, 20, 10, 5]),
    });
    expect(result.projected).toBe(0);
    expect(result.low).toBe(0);
    expect(result.pace).toBe("behind");
  });

  it("labels every pace", () => {
    expect(PACE_LABEL).toEqual({
      achieved: "Reached",
      on_track: "On track",
      behind: "Behind",
      at_risk: "At risk",
      unknown: "Not enough data",
    });
  });
});
