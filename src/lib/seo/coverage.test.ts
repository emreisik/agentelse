import { describe, expect, it } from "vitest";

import {
  coverageDropped,
  coverageText,
  estimateCoverage,
  wilsonInterval,
  type CoverageEstimate,
} from "./coverage";

// Bu dosyanın kanıtladığı: Wilson aralığı bilinen değerleri verir, metin
// yuvarlaması doğrudur ve düşüş hem 10 puan hem örtüşmeyen aralık ister.

function estimate(indexed: number, sampled: number): CoverageEstimate {
  return {
    sampled,
    indexed,
    crawledNotIndexed: 0,
    ...wilsonInterval(indexed, sampled),
  };
}

describe("wilsonInterval", () => {
  it("returns the full range without a sample", () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, low: 0, high: 1 });
  });

  it("matches known values", () => {
    const half = wilsonInterval(50, 100);
    expect(half.point).toBe(0.5);
    expect(half.low).toBeCloseTo(0.4038, 4);
    expect(half.high).toBeCloseTo(0.5962, 4);
    const most = wilsonInterval(82, 100);
    expect(most.point).toBe(0.82);
    expect(most.low).toBeCloseTo(0.7333, 3);
    expect(most.high).toBeCloseTo(0.883, 3);
    const all = wilsonInterval(20, 20);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0.8);
  });
});

describe("estimateCoverage", () => {
  it("counts indexed and crawled-not-indexed rows", () => {
    const rows = [
      { verdict: "PASS", coverageState: "Submitted and indexed" },
      { verdict: "PASS", coverageState: "Indexed, not submitted in sitemap" },
      { verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" },
      {
        verdict: "NEUTRAL",
        coverageState: "Discovered - currently not indexed",
      },
    ];
    expect(estimateCoverage(rows)).toMatchObject({
      sampled: 4,
      indexed: 2,
      crawledNotIndexed: 1,
      point: 0.5,
    });
  });
});

describe("coverageText", () => {
  it("rounds the point and the half width", () => {
    expect(coverageText(estimate(82, 100))).toBe("~82% (±7%)");
    expect(coverageText(estimate(50, 100))).toBe("~50% (±10%)");
    expect(
      coverageText({
        sampled: 40,
        indexed: 33,
        crawledNotIndexed: 0,
        point: 0.8249,
        low: 0.7,
        high: 0.9,
      }),
    ).toBe("~82% (±10%)");
  });
});

describe("coverageDropped", () => {
  it("needs both a 10-point drop and non-overlapping intervals", () => {
    // 10 puan düştü ama aralıklar örtüşüyor (küçük örneklem).
    expect(coverageDropped(estimate(18, 20), estimate(16, 20))).toBe(false);
    // Aralıklar ayrık ve düşüş 10 puandan büyük.
    expect(coverageDropped(estimate(95, 100), estimate(70, 100))).toBe(true);
    // Aralıklar ayrık ama düşüş 10 puanın altında.
    expect(
      coverageDropped(
        {
          sampled: 100,
          indexed: 90,
          crawledNotIndexed: 0,
          point: 0.9,
          low: 0.85,
          high: 0.95,
        },
        {
          sampled: 100,
          indexed: 82,
          crawledNotIndexed: 0,
          point: 0.82,
          low: 0.78,
          high: 0.84,
        },
      ),
    ).toBe(false);
    // Artış hiç düşüş sayılmaz.
    expect(coverageDropped(estimate(50, 100), estimate(90, 100))).toBe(false);
    // Örneklem yetersiz.
    expect(coverageDropped(estimate(10, 10), estimate(0, 10))).toBe(false);
  });
});
