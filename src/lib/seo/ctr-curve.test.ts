import { describe, expect, it } from "vitest";

import {
  CTR_BUCKETS,
  CTR_SITE_MIN_IMPRESSIONS,
  PUBLIC_CTR_PRIOR,
  bucketIndex,
  expectedCtr,
  fitCtrCurve,
  isotonicNonIncreasing,
  parseCtrCurve,
  priorCurve,
} from "./ctr-curve";
import type { SeoMetric } from "./opportunity-types";

// Bu dosyanın kanıtladığı: kovalar yarı açıktır; az veride eğri önseldir;
// her rastgele veride beklenen CTR konumla artmaz; az gösterimli kova önsele
// çekilir; bozuk saklı eğri reddedilir.

function row(position: number, impressions: number, clicks: number): SeoMetric {
  return { clicks, impressions, positionWeighted: position * impressions };
}

// Tohumlu sözde rastgele (mulberry32).
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("bucketIndex", () => {
  it("uses half-open buckets", () => {
    const cases: [number, number][] = [
      [1.49, 0],
      [1.5, 1],
      [10.49, 9],
      [10.5, 10],
      [15.49, 10],
      [15.5, 11],
      [20.49, 11],
      [20.5, 12],
      [30.49, 12],
      [30.5, 13],
      [50.49, 13],
      [50.5, 14],
      [400, 14],
      [Number.NaN, 0],
      [0.2, 0],
      [Number.POSITIVE_INFINITY, 0],
    ];
    for (const [position, index] of cases) {
      expect([position, bucketIndex(position)]).toEqual([position, index]);
    }
    expect(CTR_BUCKETS).toHaveLength(15);
    expect(CTR_BUCKETS.map((bucket) => bucket.key)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11-15",
      "16-20",
      "21-30",
      "31-50",
      "51+",
    ]);
  });
});

describe("fitCtrCurve", () => {
  it("returns the prior below the site minimum", () => {
    const curve = fitCtrCurve(
      [row(3, 1000, 500), row(12, 999, 0)],
      "non-brand",
      "2026-10-05",
    );
    expect(curve.source).toBe("prior");
    expect(curve.impressions).toBe(1999);
    expect(curve.fittedAt).toBe("2026-10-05");
    expect(curve.points.map((point) => point.ctr)).toEqual([
      ...PUBLIC_CTR_PRIOR,
    ]);
  });

  it("fits a site curve and shrinks a thin bucket toward the prior", () => {
    const curve = fitCtrCurve(
      [
        row(1, CTR_SITE_MIN_IMPRESSIONS, 1000),
        // 10 gösterim, 10 tıklama: ham oran 1, önsele çekilmiş ≈ 0.07.
        row(4, 10, 10),
      ],
      "non-brand",
    );
    expect(curve.source).toBe("site");
    expect(curve.impressions).toBe(CTR_SITE_MIN_IMPRESSIONS + 10);
    const thin = curve.points[3]!;
    expect(thin.impressions).toBe(10);
    expect(thin.ctr).toBeCloseTo((10 + 500 * 0.07) / 510, 6);
    expect(thin.ctr).toBeLessThan(0.1);
    expect(curve.points[0]!.ctr).toBeCloseTo((1000 + 500 * 0.28) / 2500, 6);
  });

  it("never rises with position on random data", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed);
      const rows = Array.from({ length: 40 }, () => {
        const impressions = Math.floor(next() * 400) + 1;
        return row(
          1 + next() * 70,
          impressions,
          Math.floor(next() * impressions),
        );
      });
      const curve = fitCtrCurve(rows, seed % 2 ? "brand" : "non-brand");
      for (let index = 1; index < curve.points.length; index += 1) {
        expect(curve.points[index]!.ctr).toBeLessThanOrEqual(
          curve.points[index - 1]!.ctr,
        );
      }
      for (const point of curve.points) {
        expect(point.ctr).toBeGreaterThanOrEqual(0.0005);
        expect(point.ctr).toBeLessThanOrEqual(0.95);
      }
      for (let position = 1; position <= 60; position += 1) {
        expect(expectedCtr(curve, position)).toBeGreaterThanOrEqual(
          expectedCtr(curve, position + 0.25),
        );
      }
    }
  });

  it("skips rows without impressions", () => {
    const curve = fitCtrCurve(
      [row(2, 0, 5), { clicks: 1, impressions: -3, positionWeighted: 3 }],
      "brand",
    );
    expect(curve.impressions).toBe(0);
    expect(curve.kind).toBe("brand");
  });
});

describe("isotonicNonIncreasing", () => {
  it("pools adjacent violators by weight", () => {
    expect(isotonicNonIncreasing([3, 2, 1], [1, 1, 1])).toEqual([3, 2, 1]);
    expect(isotonicNonIncreasing([1, 3], [1, 1])).toEqual([2, 2]);
    expect(isotonicNonIncreasing([1, 3], [3, 1])).toEqual([1.5, 1.5]);
    expect(isotonicNonIncreasing([5, 1, 2, 4], [1, 1, 1, 1])).toEqual([
      5,
      7 / 3,
      7 / 3,
      7 / 3,
    ]);
    expect(isotonicNonIncreasing([], [])).toEqual([]);
  });
});

describe("expectedCtr", () => {
  it("interpolates between centers and clamps at both ends", () => {
    const curve = priorCurve("non-brand");
    expect(expectedCtr(curve, 0.5)).toBe(0.28);
    expect(expectedCtr(curve, 1)).toBe(0.28);
    expect(expectedCtr(curve, 1.5)).toBeCloseTo(0.215, 6);
    expect(expectedCtr(curve, 13)).toBe(0.012);
    expect(expectedCtr(curve, 90)).toBe(0.001);
    expect(expectedCtr(curve, Number.NaN)).toBe(0);
  });
});

describe("parseCtrCurve", () => {
  it("round-trips a stored curve", () => {
    const curve = fitCtrCurve(
      [row(2, 3000, 300)],
      "non-brand",
      "2026-10-05T00:00:00.000Z",
    );
    expect(parseCtrCurve(JSON.parse(JSON.stringify(curve)))).toEqual(curve);
    expect(parseCtrCurve(priorCurve("brand"))).toEqual(priorCurve("brand"));
  });

  it("rejects malformed input", () => {
    const good = priorCurve("non-brand");
    const broken: unknown[] = [
      null,
      "x",
      [],
      { ...good, v: 2 },
      { ...good, kind: "mobile" },
      { ...good, source: "guess" },
      { ...good, impressions: "3" },
      { ...good, points: good.points.slice(1) },
      {
        ...good,
        points: good.points.map((point, index) =>
          index === 4 ? { ...point, ctr: Number.NaN } : point,
        ),
      },
      {
        ...good,
        points: good.points.map((point, index) =>
          index === 0 ? { ...point, bucket: "0" } : point,
        ),
      },
      { ...good, fittedAt: 5 },
    ];
    for (const value of broken) expect(parseCtrCurve(value)).toBeNull();
  });
});
