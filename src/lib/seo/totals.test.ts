import { describe, expect, it } from "vitest";

import {
  anonymousShare,
  averagePosition,
  ctrPercent,
  sumGscDays,
  type GscDayLike,
} from "./totals";

function day(
  clicks: number,
  impressions: number,
  position: number,
  brand: [number, number, number] | null,
): GscDayLike {
  return {
    clicks,
    impressions,
    positionWeighted: position * impressions,
    brandClicks: brand ? brand[0] : null,
    brandImpressions: brand ? brand[1] : null,
    brandPositionWeighted: brand ? brand[2] * brand[1] : null,
  };
}

describe("sumGscDays", () => {
  it("sums totals and splits brand from non-brand", () => {
    const split = sumGscDays([
      day(10, 100, 5, [4, 20, 1]),
      day(20, 300, 10, [6, 30, 2]),
    ]);
    expect(split.total).toEqual({
      clicks: 30,
      impressions: 400,
      positionWeighted: 3500,
    });
    expect(split.brand).toEqual({
      clicks: 10,
      impressions: 50,
      positionWeighted: 80,
    });
    expect(split.nonBrand).toEqual({
      clicks: 20,
      impressions: 350,
      positionWeighted: 3420,
    });
  });

  it("has no split when any day lacks brand values, or there are no days", () => {
    const split = sumGscDays([
      day(10, 100, 5, [4, 20, 1]),
      day(5, 50, 3, null),
    ]);
    expect(split.total.clicks).toBe(15);
    expect(split.brand).toBeNull();
    expect(split.nonBrand).toBeNull();
    expect(sumGscDays([])).toEqual({
      total: { clicks: 0, impressions: 0, positionWeighted: 0 },
      brand: null,
      nonBrand: null,
    });
  });

  it("never returns negative non-brand values", () => {
    const split = sumGscDays([day(3, 10, 2, [5, 12, 3])]);
    expect(split.nonBrand).toEqual({
      clicks: 0,
      impressions: 0,
      positionWeighted: 0,
    });
  });
});

describe("rates", () => {
  it("derives CTR and position, null without impressions", () => {
    const totals = { clicks: 5, impressions: 200, positionWeighted: 1600 };
    expect(ctrPercent(totals)).toBe(2.5);
    expect(averagePosition(totals)).toBe(8);
    const none = { clicks: 0, impressions: 0, positionWeighted: 0 };
    expect(ctrPercent(none)).toBeNull();
    expect(averagePosition(none)).toBeNull();
  });

  it("clamps the anonymous share and is null without clicks", () => {
    expect(anonymousShare(100, 60)).toBeCloseTo(0.4);
    expect(anonymousShare(100, 120)).toBe(0);
    expect(anonymousShare(100, -5)).toBe(1);
    expect(anonymousShare(0, 0)).toBeNull();
    expect(anonymousShare(Number.NaN, 1)).toBeNull();
  });
});
