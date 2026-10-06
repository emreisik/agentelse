import { describe, expect, it } from "vitest";

import {
  daysIn,
  metricOfDay,
  sameWeekdayBaseline,
  sumRange,
  weeklySums,
} from "./baseline";
import { makeDays } from "./test-fixtures";

// Bu dosyanın kanıtladığı: aynı gün tabanı şüpheli/tatil günlerini ve eksik
// günleri atlar, en az 4 değer ister; haftalık toplamın "clean" bayrağı 7
// tam ve hariç olmayan gün demektir.

const target = "2026-10-05"; // Pazartesi
const days = makeDays({
  from: "2026-07-01",
  to: target,
  sessions: (_day, index) => 100 + index,
  keyEventRate: 0.1,
});

describe("metricOfDay", () => {
  it("reads counts and computes keyEventRate as a fraction", () => {
    const day = days.find((d) => d.day === target)!;
    expect(metricOfDay(day, "sessions")).toBe(day.sessions);
    expect(metricOfDay(day, "keyEventRate")).toBeCloseTo(
      day.keyEvents / day.sessions,
      12,
    );
    expect(metricOfDay({ ...day, sessions: 0 }, "keyEventRate")).toBeNull();
  });
});

describe("sameWeekdayBaseline", () => {
  const pick = (d: { sessions: number }) => d.sessions;

  it("walks the same weekday back eight weeks", () => {
    const result = sameWeekdayBaseline(days, target, pick, {
      exclude: new Set(),
    })!;
    expect(result.days).toEqual([
      "2026-09-28",
      "2026-09-21",
      "2026-09-14",
      "2026-09-07",
      "2026-08-31",
      "2026-08-24",
      "2026-08-17",
      "2026-08-10",
    ]);
    expect(result.values).toHaveLength(8);
  });

  it("skips excluded (suspect or holiday) and missing days", () => {
    const sparse = days.filter((d) => d.day !== "2026-09-21");
    const result = sameWeekdayBaseline(sparse, target, pick, {
      exclude: new Set(["2026-09-28", "2026-09-14"]),
    })!;
    expect(result.days).toEqual([
      "2026-09-07",
      "2026-08-31",
      "2026-08-24",
      "2026-08-17",
      "2026-08-10",
    ]);
  });

  it("skips null picks and needs four values", () => {
    const exclude = new Set([
      "2026-09-28",
      "2026-09-21",
      "2026-09-14",
      "2026-09-07",
    ]);
    expect(
      sameWeekdayBaseline(days, target, pick, { exclude, weeks: 8 })!.values,
    ).toHaveLength(4);
    exclude.add("2026-08-31");
    expect(sameWeekdayBaseline(days, target, pick, { exclude })).toBeNull();
    expect(
      sameWeekdayBaseline(days, target, () => null, { exclude: new Set() }),
    ).toBeNull();
    expect(
      sameWeekdayBaseline(days, target, pick, {
        exclude: new Set(),
        weeks: 3,
        minValues: 3,
      })!.values,
    ).toHaveLength(3);
  });
});

describe("weeklySums and sumRange", () => {
  it("flags weeks with an excluded or missing day as not clean", () => {
    const sparse = days.filter((d) => d.day !== "2026-09-16");
    const result = weeklySums(
      sparse,
      ["2026-09-07", "2026-09-14", "2026-09-21"],
      (d) => d.sessions,
      new Set(["2026-09-23"]),
    );
    expect(result.map((week) => week.clean)).toEqual([true, false, false]);
    const sept7 = days.filter(
      (d) => d.day >= "2026-09-07" && d.day <= "2026-09-13",
    );
    expect(result[0]!.value).toBe(sept7.reduce((s, d) => s + d.sessions, 0));
    // Hariç gün toplama girmez.
    const sept21 = days.filter(
      (d) =>
        d.day >= "2026-09-21" &&
        d.day <= "2026-09-27" &&
        d.day !== "2026-09-23",
    );
    expect(result[2]!.value).toBe(sept21.reduce((s, d) => s + d.sessions, 0));
  });

  it("sumRange counts used days", () => {
    const range = { from: "2026-10-01", to: "2026-10-07" };
    expect(sumRange(days, range, () => 1)).toEqual({ value: 5, days: 5 });
    expect(sumRange(days, range, () => 1, new Set(["2026-10-02"]))).toEqual({
      value: 4,
      days: 4,
    });
  });
});

describe("daysIn", () => {
  it("returns sorted members inside the range", () => {
    const set = new Set([
      "2026-10-09",
      "2026-10-01",
      "2026-09-30",
      "2026-10-05",
    ]);
    expect(daysIn({ from: "2026-10-01", to: "2026-10-05" }, set)).toEqual([
      "2026-10-01",
      "2026-10-05",
    ]);
    expect(daysIn({ from: "2026-10-01", to: "2026-10-05" }, new Set())).toEqual(
      [],
    );
  });
});
