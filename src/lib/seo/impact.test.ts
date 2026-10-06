import { describe, expect, it } from "vitest";

import { priorCurve } from "./ctr-curve";
import {
  MONTH_FACTOR,
  avgPosition,
  clicksImpact,
  ctrOf,
  priorityOf,
  reachImpact,
  strikingGain,
  targetPosition,
} from "./impact";

const CURVE = priorCurve("non-brand");

describe("targetPosition", () => {
  it("moves each band to a realistic target", () => {
    const cases: [number, number][] = [
      [1, 1],
      [3, 1],
      [3.1, 1],
      [4.6, 2],
      [8, 5],
      [10, 7],
      [10.1, 5],
      [20, 5],
      [20.1, 10],
      [45, 10],
    ];
    for (const [position, target] of cases) {
      expect([position, targetPosition(position)]).toEqual([position, target]);
    }
  });
});

describe("strikingGain", () => {
  it("is the monthly click gap to the target position", () => {
    // Konum 12 → hedef 5 (CTR 0.05): 1000 × 0.05 − 10 = 40 tıklama / 28 gün.
    expect(
      strikingGain({
        impressions: 1000,
        clicks: 10,
        position: 12,
        curve: CURVE,
      }),
    ).toBeCloseTo(40 * MONTH_FACTOR, 6);
  });

  it("is 0 when the actual CTR already beats the target", () => {
    expect(
      strikingGain({
        impressions: 1000,
        clicks: 90,
        position: 12,
        curve: CURVE,
      }),
    ).toBe(0);
    expect(
      strikingGain({ impressions: 0, clicks: 0, position: 12, curve: CURVE }),
    ).toBe(0);
    expect(
      strikingGain({
        impressions: 100,
        clicks: 0,
        position: Number.NaN,
        curve: CURVE,
      }),
    ).toBe(0);
  });
});

describe("clicksImpact and reachImpact", () => {
  it("rounds to integer ranges by confidence", () => {
    expect(clicksImpact(100.4, "SIGNIFICANT")).toEqual({
      kind: "clicks",
      perMonth: 100,
      low: 70,
      high: 131,
    });
    expect(clicksImpact(100, "DIRECTIONAL")).toEqual({
      kind: "clicks",
      perMonth: 100,
      low: 50,
      high: 150,
    });
    expect(clicksImpact(-5, "SIGNIFICANT")).toEqual({
      kind: "clicks",
      perMonth: 0,
      low: 0,
      high: 0,
    });
    expect(reachImpact(2800)).toEqual({
      kind: "reach",
      impressionsPerMonth: 3000,
    });
  });
});

describe("priorityOf", () => {
  const clicks = clicksImpact(100, "SIGNIFICANT");

  it("ranks by impact, confidence and effort", () => {
    expect(priorityOf(clicks, "SIGNIFICANT", "S")).toBe(100);
    expect(priorityOf(clicks, "SIGNIFICANT", "L")).toBe(25);
    expect(priorityOf(clicks, "DIRECTIONAL", "S")).toBe(50);
    expect(priorityOf(clicks, "SIGNIFICANT", "VARIES")).toBe(50);
    expect(priorityOf(clicks, "SIGNIFICANT", "S")).toBeGreaterThan(
      priorityOf(clicks, "SIGNIFICANT", "L"),
    );
    expect(priorityOf(null, "SIGNIFICANT", "S")).toBe(0);
  });

  it("ranks reach with the 2% proxy CTR, two decimals", () => {
    expect(
      priorityOf(
        { kind: "reach", impressionsPerMonth: 1000 },
        "SIGNIFICANT",
        "S",
      ),
    ).toBe(20);
    expect(
      priorityOf(
        { kind: "reach", impressionsPerMonth: 334 },
        "DIRECTIONAL",
        "M",
      ),
    ).toBe(1.67);
  });
});

describe("avgPosition and ctrOf", () => {
  it("is null without impressions", () => {
    expect(
      avgPosition({ clicks: 1, impressions: 0, positionWeighted: 0 }),
    ).toBe(null);
    expect(ctrOf({ clicks: 1, impressions: 0, positionWeighted: 0 })).toBe(
      null,
    );
    expect(
      avgPosition({ clicks: 1, impressions: 4, positionWeighted: 30 }),
    ).toBe(7.5);
    expect(ctrOf({ clicks: 1, impressions: 4, positionWeighted: 30 })).toBe(
      0.25,
    );
  });
});
