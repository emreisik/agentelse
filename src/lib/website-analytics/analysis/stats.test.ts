import { describe, expect, it } from "vitest";

import {
  benjaminiHochberg,
  mad,
  median,
  normalCdf,
  percentile,
  poissonInterval,
  poissonRateTest,
  rateRatioTest,
  robustZ,
  twoProportionTest,
  twoSidedP,
  wilsonInterval,
} from "./stats";

// Bu dosyanın kanıtladığı: normal dağılım, iki oran ve Poisson oran
// testleri bilinen değerleri verir; key event / oturum 1'i aştığında oran
// testi sonlu kalır; Poisson aralığı k ≤ 4'te kesin tabloyu, büyük k'de
// Byar yaklaşımını kullanır; BH ders kitabı örneğini tutar; her fonksiyon
// boş ve NaN girdide hata fırlatmaz.

describe("normal distribution", () => {
  it("normalCdf matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-3)).toBeCloseTo(0.0013499, 6);
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(-Infinity)).toBe(0);
  });

  it("twoSidedP", () => {
    expect(twoSidedP(1.96)).toBeCloseTo(0.05, 3);
    expect(twoSidedP(-1.96)).toBeCloseTo(0.05, 3);
    expect(twoSidedP(0)).toBeCloseTo(1, 6);
    expect(twoSidedP(Number.NaN)).toBe(1);
  });
});

describe("robust summaries", () => {
  it("median, mad and percentile", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([1, Number.NaN, 3])).toBe(2);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(mad([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("robustZ uses the floor when MAD is 0", () => {
    const flat = [100, 100, 100, 100, 100];
    const result = robustZ(130, flat, 10);
    expect(result).toEqual({ z: 3, median: 100, scale: 10 });
    expect(robustZ(100, flat)?.z).toBe(0);
    expect(robustZ(101, flat)!.scale).toBe(1e-9);
    expect(robustZ(1, [])).toBeNull();
    expect(robustZ(Number.NaN, flat)).toBeNull();
  });

  it("robustZ scales MAD by 1.4826", () => {
    const result = robustZ(20, [8, 9, 10, 11, 12]);
    expect(result!.median).toBe(10);
    expect(result!.scale).toBeCloseTo(1.4826, 10);
    expect(result!.z).toBeCloseTo(10 / 1.4826, 10);
  });
});

describe("twoProportionTest", () => {
  it("matches a hand-computed case", () => {
    // p = 150/1000; se = √(0.15·0.85·(1/500+1/500)) = 0.0225832
    const result = twoProportionTest(100, 500, 50, 500)!;
    expect(result.z).toBeCloseTo(0.1 / Math.sqrt(0.15 * 0.85 * 0.004), 8);
    expect(result.z).toBeCloseTo(4.428, 3);
    expect(result.p).toBeLessThan(0.0001);
  });

  it("is symmetric", () => {
    const a = twoProportionTest(30, 200, 45, 210)!;
    const b = twoProportionTest(45, 210, 30, 200)!;
    expect(a.z).toBeCloseTo(-b.z, 12);
    expect(a.p).toBeCloseTo(b.p, 12);
  });

  it("returns null on degenerate input and clips hits", () => {
    expect(twoProportionTest(1, 0, 1, 10)).toBeNull();
    expect(twoProportionTest(0, 10, 0, 10)).toBeNull();
    expect(twoProportionTest(10, 10, 10, 10)).toBeNull();
    expect(twoProportionTest(Number.NaN, 10, 1, 10)).toBeNull();
    // 20 isabet 10 denemeye kırpılır.
    expect(twoProportionTest(20, 10, 5, 10)).toEqual(
      twoProportionTest(10, 10, 5, 10),
    );
  });
});

describe("Poisson rate tests", () => {
  it("poissonRateTest with equal exposure", () => {
    // n = 200, π0 = 0.5: z = (120 − 100)/√50
    const result = poissonRateTest(120, 80)!;
    expect(result.z).toBeCloseTo(20 / Math.sqrt(50), 10);
  });

  it("poissonRateTest with unequal exposure", () => {
    // Aynı oran (0.1/oturum), maruziyet 1000'e 3000: z ≈ 0.
    expect(poissonRateTest(100, 300, 1000, 3000)!.z).toBeCloseTo(0, 10);
    // π0 = 0.25; n = 200; beklenen 50, gözlenen 80.
    const result = poissonRateTest(80, 120, 1000, 3000)!;
    expect(result.z).toBeCloseTo(30 / Math.sqrt(200 * 0.25 * 0.75), 10);
    expect(result.z).toBeGreaterThan(0);
  });

  it("returns null without hits or with a bad exposure", () => {
    expect(poissonRateTest(0, 0)).toBeNull();
    expect(poissonRateTest(1, 1, 0, 1)).toBeNull();
    expect(poissonRateTest(1, 1, 1, -1)).toBeNull();
    expect(poissonRateTest(Number.NaN, 1)).toBeNull();
  });

  it("rateRatioTest stays finite when key events exceed sessions", () => {
    const result = rateRatioTest(300, 200, 100, 1000)!;
    expect(Number.isFinite(result.z)).toBe(true);
    expect(result.z).toBeGreaterThan(3);
    expect(result.p).toBeLessThan(0.001);
    expect(result.ratio).toBeCloseTo(15, 10);
    expect(rateRatioTest(5, 100, 0, 100)!.ratio).toBeNull();
    expect(rateRatioTest(0, 100, 0, 100)).toBeNull();
  });
});

describe("intervals", () => {
  it("poissonInterval uses the exact table for k ≤ 4", () => {
    const low = [0, 0.0253, 0.2422, 0.6186, 1.0899];
    const high = [3.6889, 5.5716, 7.2247, 8.7673, 10.2416];
    for (let k = 0; k <= 4; k++) {
      expect(poissonInterval(k)).toEqual({ low: low[k], high: high[k] });
    }
    expect(poissonInterval(2.4)).toEqual(poissonInterval(2));
    expect(poissonInterval(-3)).toEqual(poissonInterval(0));
    expect(poissonInterval(Number.NaN)).toEqual(poissonInterval(0));
  });

  it("poissonInterval (Byar) is within 3% of exact for k = 10 and 100", () => {
    const near = (value: number, exact: number) =>
      expect(Math.abs(value - exact) / exact).toBeLessThan(0.03);
    const ten = poissonInterval(10);
    near(ten.low, 4.795);
    near(ten.high, 18.39);
    const hundred = poissonInterval(100);
    near(hundred.low, 81.36);
    near(hundred.high, 121.63);
  });

  it("wilsonInterval", () => {
    const result = wilsonInterval(10, 100)!;
    expect(result.low).toBeCloseTo(0.0552, 3);
    expect(result.high).toBeCloseTo(0.1744, 3);
    expect(wilsonInterval(0, 10)!.low).toBe(0);
    expect(wilsonInterval(10, 10)!.high).toBe(1);
    expect(wilsonInterval(1, 0)).toBeNull();
  });
});

describe("benjaminiHochberg", () => {
  const textbook = [
    0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216,
  ];

  it("textbook example at q = 0.05 keeps the first two", () => {
    expect(benjaminiHochberg(textbook, 0.05)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("default q = 0.10 keeps the first six; output keeps input order", () => {
    expect(benjaminiHochberg(textbook).filter(Boolean)).toHaveLength(6);
    const shuffled = [0.06, 0.205, 0.001, 0.074, 0.042];
    // Sıralı: 0.001, 0.042 (0.04 ✗), 0.06, 0.074 (0.08 ✓), 0.205 (0.10 ✗)
    // → eşik 0.074; adım yukarı olduğu için 0.042 de kabul.
    expect(benjaminiHochberg(shuffled)).toEqual([
      true,
      false,
      true,
      true,
      true,
    ]);
  });

  it("NaN counts as 1 and empty input is empty", () => {
    expect(benjaminiHochberg([Number.NaN, 0.001])).toEqual([false, true]);
    expect(benjaminiHochberg([])).toEqual([]);
  });
});
