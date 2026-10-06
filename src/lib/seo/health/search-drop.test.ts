import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/seo/dates";

import { dropVerdict, type DropDay } from "./search-drop";

const LAST = "2026-10-04";

// 9 haftalık seri: her gün `base` tık; son iki gün verilen değerler.
function series(options: {
  base: number;
  last2: [number, number];
  nonBrand?: boolean;
  skip?: (day: string) => boolean;
}): DropDay[] {
  const days: DropDay[] = [];
  for (let offset = 69; offset >= 0; offset -= 1) {
    const day = addDays(LAST, -offset);
    if (options.skip?.(day)) continue;
    const clicks =
      offset === 1
        ? options.last2[0]
        : offset === 0
          ? options.last2[1]
          : options.base;
    days.push({
      day,
      clicks: options.nonBrand ? clicks + 1000 : clicks,
      nonBrandClicks: options.nonBrand ? clicks : null,
    });
  }
  return days;
}

describe("dropVerdict", () => {
  it("ignores small sites (baseline under 20)", () => {
    expect(dropVerdict(series({ base: 19, last2: [0, 0] }))).toBeNull();
  });

  it("is CRITICAL when two days are under 50%", () => {
    const verdict = dropVerdict(series({ base: 100, last2: [49, 40] }));
    expect(verdict).toMatchObject({
      severity: "CRITICAL",
      metric: "total",
      baseline: 100,
      days: [addDays(LAST, -1), LAST],
    });
    expect(verdict?.ratio).toBeCloseTo(0.49);
  });

  it("is WARN when two days are under 75%", () => {
    expect(dropVerdict(series({ base: 100, last2: [74, 49] }))?.severity).toBe(
      "WARN",
    );
  });

  it("needs both days to be low", () => {
    expect(dropVerdict(series({ base: 100, last2: [100, 10] }))).toBeNull();
    expect(dropVerdict(series({ base: 100, last2: [75, 75] }))).toBeNull();
  });

  it("uses non-brand clicks when the split covers nine weeks, else total", () => {
    const nonBrand = dropVerdict(
      series({ base: 100, last2: [30, 30], nonBrand: true }),
    );
    expect(nonBrand).toMatchObject({
      severity: "CRITICAL",
      metric: "nonBrand",
    });

    const mixed = series({ base: 100, last2: [30, 30], nonBrand: true });
    mixed[mixed.length - 20] = {
      ...mixed[mixed.length - 20]!,
      nonBrandClicks: null,
    };
    // Toplamda düşüş küçük (1030 / 1100): uyarı yok.
    expect(dropVerdict(mixed)).toBeNull();
  });

  it("needs at least six of the eight same weekdays", () => {
    const sameWeekday = (day: string, of: string) =>
      new Date(`${day}T00:00:00Z`).getUTCDay() ===
      new Date(`${of}T00:00:00Z`).getUTCDay();
    // Son günün haftagününden 3 hafta eksik → 5 değer → karar yok.
    const missing = series({
      base: 100,
      last2: [10, 10],
      skip: (day) =>
        day < LAST && day >= addDays(LAST, -21) && sameWeekday(day, LAST),
    });
    expect(dropVerdict(missing)).toBeNull();
    // 2 hafta eksik → 6 değer → yeterli.
    const twoMissing = series({
      base: 100,
      last2: [10, 10],
      skip: (day) =>
        day < LAST && day >= addDays(LAST, -14) && sameWeekday(day, LAST),
    });
    expect(dropVerdict(twoMissing)?.severity).toBe("CRITICAL");
  });

  it("needs the two latest days to be consecutive", () => {
    const gap = series({ base: 100, last2: [10, 10] }).filter(
      (day) => day.day !== addDays(LAST, -1),
    );
    expect(dropVerdict(gap)).toBeNull();
  });
});
