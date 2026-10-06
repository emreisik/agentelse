import { describe, expect, it } from "vitest";

import { addMonths } from "@/lib/seo/dates";

import {
  FORECAST_BACKTEST_MONTHS,
  FORECAST_DEFAULT_ERROR,
  FORECAST_MIN_ERROR,
  daysInMonth,
  forecastMonth,
} from "./forecast";
import type { MonthlyPoint } from "./types";

// target'tan önceki `rates.length` ayı, günlük hızlarla (value = hız × gün).
function series(target: string, rates: readonly number[]): MonthlyPoint[] {
  return rates.map((rate, index) => {
    const month = addMonths(target, -(rates.length - index));
    const days = daysInMonth(month);
    return { month, value: Math.round(rate * days), days };
  });
}

describe("daysInMonth", () => {
  it("knows February from March and leap years", () => {
    expect(daysInMonth("2026-02-01")).toBe(28);
    expect(daysInMonth("2028-02-01")).toBe(29);
    expect(daysInMonth("2026-03-01")).toBe(31);
    expect(daysInMonth("2026-04-01")).toBe(30);
  });
});

describe("forecastMonth", () => {
  const target = "2027-01-01";

  it("is null with fewer than 3 months", () => {
    expect(
      forecastMonth({
        metric: "clicks",
        history: series(target, [10, 10]),
        target,
      }),
    ).toBeNull();
    expect(forecastMonth({ metric: "clicks", history: [], target })).toBeNull();
  });

  it("ignores months that are not before the target", () => {
    const history = [
      ...series(target, [10, 10]),
      { month: target, value: 999, days: 31 },
    ];
    expect(forecastMonth({ metric: "clicks", history, target })).toBeNull();
  });

  it("uses the trend with 14 months, because seasonal needs 15", () => {
    const result = forecastMonth({
      metric: "clicks",
      history: series(target, Array.from({ length: 14 }, () => 10)),
      target,
    });
    expect(result?.method).toBe("trend");
    expect(result?.historyMonths).toBe(14);
  });

  it("uses the seasonal method with 16 months", () => {
    // Geçen yılın aynı 3 ayı 10/gün, son 3 ay 20/gün: seviye iki katı.
    const rates = Array.from({ length: 16 }, (_, index) => (index >= 13 ? 20 : 10));
    const result = forecastMonth({
      metric: "nonBrandClicks",
      history: series(target, rates),
      target,
    });
    expect(result?.method).toBe("seasonal");
    expect(result?.metric).toBe("nonBrandClicks");
    expect(result?.month).toBe(target);
    // Geçen yılın ocağı 10 × 31 = 310; seviye ×2 → 620.
    expect(result?.value).toBe(620);
  });

  it("needs positive values in every seasonal month", () => {
    const rates = Array.from({ length: 16 }, () => 10);
    const history = series(target, rates).map((point, index) =>
      index === 3 ? { ...point, value: 0 } : point,
    );
    expect(forecastMonth({ metric: "clicks", history, target })?.method).toBe(
      "trend",
    );
  });

  it("puts a rising trend above the recent mean", () => {
    const rates = [10, 12, 14, 16, 18];
    const history = series(target, rates);
    const result = forecastMonth({ metric: "clicks", history, target });
    expect(result?.method).toBe("trend");
    // Son 3 ay ortalaması 16, eğim 2 → 17 / gün.
    expect(result?.value).toBe(Math.round(17 * 31));
    expect(result?.value).toBeGreaterThan(16 * 31);
  });

  it("never goes below zero and keeps low at zero or more", () => {
    const result = forecastMonth({
      metric: "clicks",
      history: series(target, [90, 30, 0, 0, 0, 0]),
      target,
    });
    expect(result?.value).toBe(0);
    expect(result?.low).toBe(0);
    expect(result?.high).toBe(0);
  });

  it("uses the default error without backtest points", () => {
    const result = forecastMonth({
      metric: "clicks",
      history: series(target, [10, 10, 10]),
      target,
    });
    expect(result?.errorPct).toBe(FORECAST_DEFAULT_ERROR);
    expect(result?.low).toBe(Math.round((result?.value ?? 0) * 0.75));
    expect(result?.high).toBe(Math.round((result?.value ?? 0) * 1.25));
  });

  it("floors the error at 15% for a flat series", () => {
    const result = forecastMonth({
      metric: "clicks",
      history: series(target, Array.from({ length: 9 }, () => 10)),
      target,
    });
    expect(result?.errorPct).toBe(FORECAST_MIN_ERROR);
  });

  it("widens the interval with a noisy backtest", () => {
    const rates = [10, 30, 8, 35, 12, 40, 9, 33];
    const result = forecastMonth({
      metric: "clicks",
      history: series(target, rates),
      target,
    });
    expect(result?.errorPct).toBeGreaterThan(FORECAST_MIN_ERROR);
    expect(result?.low).toBeLessThan(result?.value ?? 0);
    expect(result?.high).toBeGreaterThan(result?.value ?? 0);
  });

  it("backtests at most the last six months", () => {
    expect(FORECAST_BACKTEST_MONTHS).toBe(6);
    // İlk ay sıçrama yapar; sınama noktalarının hiçbiri onu eğime katmaz
    // (yedinci aydan öncesi sınanmaz), bu yüzden hata tabana oturur.
    const rates = [200, ...Array.from({ length: 12 }, () => 10)];
    const result = forecastMonth({
      metric: "clicks",
      history: series(target, rates),
      target,
    });
    expect(result?.errorPct).toBe(FORECAST_MIN_ERROR);
  });

  it("caps the error at 100%", () => {
    const rates = Array.from({ length: 16 }, (_, index) =>
      index === 15 ? 500 : index % 2 === 0 ? 5 : 40,
    );
    const result = forecastMonth({
      metric: "clicks",
      history: series(target, rates),
      target,
    });
    expect(result?.errorPct).toBeLessThanOrEqual(1);
    expect(result?.low).toBeGreaterThanOrEqual(0);
  });

  it("scales the same daily rate to the month length", () => {
    const history = series("2027-02-01", Array.from({ length: 6 }, () => 10));
    const feb = forecastMonth({ metric: "clicks", history, target: "2027-02-01" });
    const mar = forecastMonth({
      metric: "clicks",
      history: series("2027-03-01", Array.from({ length: 6 }, () => 10)),
      target: "2027-03-01",
    });
    expect(feb?.value).toBe(280);
    expect(mar?.value).toBe(310);
  });
});
