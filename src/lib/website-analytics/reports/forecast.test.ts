import { describe, expect, it } from "vitest";

import { sameWeekdayBaseline } from "@/lib/website-analytics/analysis/baseline";
import { median } from "@/lib/website-analytics/analysis/stats";
import type { GaAnalysisDay } from "@/lib/website-analytics/analysis/types";
import { addDays, monthEnd } from "@/lib/website-analytics/days";

import {
  backtestForecast,
  forecastMonthEnd,
  metricValue,
} from "./forecast";

function row(day: string, sessions: number, extra: Partial<GaAnalysisDay> = {}) {
  return {
    day,
    sessions,
    engagedSessions: Math.round(sessions * 0.6),
    keyEvents: Math.round(sessions / 10),
    revenue: 0,
    transactions: 0,
    isFinal: true,
    ...extra,
  } satisfies GaAnalysisDay;
}

function series(
  from: string,
  to: string,
  value: (day: string, index: number) => number,
): GaAnalysisDay[] {
  const rows: GaAnalysisDay[] = [];
  let index = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    rows.push(row(day, value(day, index)));
    index += 1;
  }
  return rows;
}

// Tohumlu rastgele sayı üreteci (mulberry32).
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const PATTERN = [60, 130, 140, 135, 125, 110, 70]; // pazar..cumartesi

describe("forecastMonthEnd", () => {
  it("düz seride tahmin ay başından bugüne toplam + kalan gün x 100 olur", () => {
    const days = series("2026-06-01", "2026-09-28", () => 100);
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-28",
      exclude: new Set(),
    });
    expect(view.basis).toBe("ok");
    expect(view.month).toBe("2026-09");
    expect(view.dayOfMonth).toBe(28);
    expect(view.daysInMonth).toBe(30);
    expect(view.monthToDate).toBe(2800);
    expect(view.forecast).toBe(3000);
    expect(view.low).toBe(3000);
    expect(view.high).toBe(3000);
  });

  it("haftanın günü deseni birebir yeniden üretilir", () => {
    const value = (day: string) => PATTERN[weekdayOf(day)] ?? 0;
    const days = series("2026-06-01", "2026-09-20", (day) => value(day));
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-20",
      exclude: new Set(),
    });
    let total = 0;
    for (let day = "2026-09-01"; day <= "2026-09-30"; day = addDays(day, 1)) {
      total += value(day);
    }
    expect(view.forecast).toBe(total);
    expect(view.low).toBe(total);
    expect(view.high).toBe(total);
  });

  it("şüpheli günler tabandan çıkar ama ay başından bugüne toplamda sayılır", () => {
    // Salı günlerinin ilk dördü (1, 8, 15, 22 Eylül) şüpheli ve sivri.
    const spiky = new Set(["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"]);
    const days = series("2026-06-01", "2026-09-28", (day) =>
      spiky.has(day) ? 1000 : 100,
    );
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-28",
      exclude: spiky,
    });
    expect(view.monthToDate).toBe(24 * 100 + 4 * 1000);
    // Kalan Salı (29) ve Çarşamba (30) tabanı 100.
    expect(view.forecast).toBe(24 * 100 + 4 * 1000 + 200);
  });

  it("50 günlük geçmişte short_history döner", () => {
    const days = series("2026-08-10", "2026-09-28", () => 100);
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-28",
      exclude: new Set(),
    });
    expect(view.basis).toBe("short_history");
    expect(view.forecast).toBeNull();
    expect(view.low).toBeNull();
    expect(view.high).toBeNull();
    expect(view.monthToDate).toBe(2800);
  });

  it("ayın son gününde complete döner ve tahmin toplama eşittir", () => {
    const days = series("2026-06-01", "2026-09-30", () => 100);
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-30",
      exclude: new Set(),
    });
    expect(view.basis).toBe("complete");
    expect(view.forecast).toBe(3000);
    expect(view.low).toBe(3000);
    expect(view.high).toBe(3000);
  });

  it("hiçbir kalan günün tabanı yoksa no_baseline döner", () => {
    const days = series("2026-06-01", "2026-09-20", () => 100);
    const everything = new Set(days.map((day) => day.day));
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-20",
      exclude: everything,
    });
    expect(view.basis).toBe("no_baseline");
    expect(view.forecast).toBeNull();
  });

  it("gürültülü seride aralık tahmini sarar ve düşük uç ay başından bugüne altına inmez", () => {
    const random = rng(7);
    const days = series("2026-06-01", "2026-09-10", (day) => {
      const base = PATTERN[weekdayOf(day)] ?? 0;
      return Math.round(base * (0.8 + random() * 0.4));
    });
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-10",
      exclude: new Set(),
    });
    expect(view.forecast).not.toBeNull();
    expect(view.low).not.toBeNull();
    expect(view.high).not.toBeNull();
    expect(view.low as number).toBeLessThan(view.forecast as number);
    expect(view.high as number).toBeGreaterThan(view.forecast as number);
    expect(view.low as number).toBeGreaterThanOrEqual(view.monthToDate);
  });

  it("14'ten az artık varsa aralık verilmez", () => {
    // 56 günlük geçmiş; ama çoğu gün hariç tutulduğundan artık sayısı az kalır.
    const days = series("2026-07-15", "2026-09-10", () => 100);
    const exclude = new Set(
      days.filter((_, index) => index % 7 !== 0 || index < 14).map((d) => d.day),
    );
    const view = forecastMonthEnd({
      days,
      metric: "sessions",
      through: "2026-09-10",
      exclude,
    });
    expect(view.basis).toBe("ok");
    expect(view.low).toBeNull();
    expect(view.high).toBeNull();
  });

  it("gelir iki ondalıkla, sayımlar tam sayıyla yuvarlanır", () => {
    const days = series("2026-06-01", "2026-09-28", () => 100).map((d) => ({
      ...d,
      revenue: 12.345,
    }));
    const view = forecastMonthEnd({
      days,
      metric: "revenue",
      through: "2026-09-28",
      exclude: new Set(),
    });
    expect(view.monthToDate).toBe(345.66);
    expect(view.forecast).toBe(370.35);
    expect(metricValue(days[0] as GaAnalysisDay, "revenue")).toBe(12.345);
  });

  it("AN15 ile aynı formül: 5 tohumlu rastgele seri", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = rng(seed * 101);
      const days = series("2026-04-01", "2026-09-14", () =>
        Math.round(50 + random() * 200),
      );
      const exclude = new Set(
        days.filter(() => random() < 0.08).map((day) => day.day),
      );
      const through = "2026-09-14";
      const view = forecastMonthEnd({
        days,
        metric: "sessions",
        through,
        exclude,
      });

      // Bağımsız hesap (AN15'in döngüsü).
      let monthToDate = 0;
      for (const day of days) {
        if (day.day >= "2026-09-01" && day.day <= through) {
          monthToDate += day.sessions;
        }
      }
      let expected = 0;
      for (
        let day = addDays(through, 1);
        day <= monthEnd(through);
        day = addDays(day, 1)
      ) {
        const baseline = sameWeekdayBaseline(days, day, (d) => d.sessions, {
          exclude,
          weeks: 8,
          minValues: 3,
        });
        expected += (baseline ? median(baseline.values) : null) ?? 0;
      }
      expect(view.monthToDate).toBe(monthToDate);
      expect(view.forecast).toBe(Math.round(monthToDate + expected));
    }
  });
});

describe("backtestForecast", () => {
  it("13 aylık gürültülü haftalık desende ortalama hata %20 altında kalır", () => {
    const random = rng(42);
    const days = series("2025-09-01", "2026-09-30", (day) => {
      const base = PATTERN[weekdayOf(day)] ?? 0;
      return Math.round(base * (0.9 + random() * 0.2));
    });
    const result = backtestForecast({
      days,
      metric: "sessions",
      exclude: new Set(),
    });
    expect(result.rows.length).toBeGreaterThan(6);
    expect(result.meanAbsErrorPct).not.toBeNull();
    expect(result.meanAbsErrorPct as number).toBeLessThanOrEqual(20);
    // Eskiden yeniye sıralı; son ay Eylül 2026.
    expect(
      (result.rows[0]?.month ?? "") < (result.rows.at(-1)?.month ?? ""),
    ).toBe(true);
    expect(result.rows.at(-1)?.month).toBe("2026-09");
    for (const item of result.rows) {
      expect([10, 20]).toContain(item.checkpoint);
    }
  });

  it("ay sonuna ulaşmayan seride son tam ay bir öncekidir", () => {
    const days = series("2026-01-01", "2026-09-12", () => 100);
    const result = backtestForecast({
      days,
      metric: "sessions",
      exclude: new Set(),
      months: 2,
    });
    expect(result.rows.map((item) => item.month)).toEqual([
      "2026-07",
      "2026-07",
      "2026-08",
      "2026-08",
    ]);
    expect(result.meanAbsErrorPct).toBe(0);
  });

  it("boş seride sonuç yok", () => {
    expect(
      backtestForecast({ days: [], metric: "sessions", exclude: new Set() }),
    ).toEqual({ rows: [], meanAbsErrorPct: null });
  });
});
