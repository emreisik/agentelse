import { describe, expect, it } from "vitest";

import { addDays, daysInRange } from "./dates";
import {
  DEFAULT_SEARCH_PERIOD,
  SEARCH_PERIODS,
  isSearchPeriod,
  resolveSearchPeriod,
  weeksWithin,
} from "./periods";

// 2026-10-03 Cumartesi; son tam hafta 21–27 Eylül.
const FINAL = "2026-10-03";

describe("resolveSearchPeriod", () => {
  it.each(SEARCH_PERIODS.map((period) => [period.key, period.days] as const))(
    "%s ends at finalThrough with an equal previous period",
    (key, days) => {
      const period = resolveSearchPeriod(key, FINAL);
      expect(period.to).toBe(FINAL);
      expect(daysInRange(period.from, period.to)).toBe(days);
      expect(period.days).toBe(days);
      expect(period.previous.to).toBe(addDays(period.from, -1));
      expect(daysInRange(period.previous.from, period.previous.to)).toBe(days);
      expect(addDays(period.weeks.to, 6) <= FINAL).toBe(true);
    },
  );

  it("uses the complete weeks inside the period", () => {
    expect(resolveSearchPeriod("28d", FINAL)).toMatchObject({
      key: "28d",
      label: "28 days",
      from: "2026-09-06",
      to: "2026-10-03",
      previous: { from: "2026-08-09", to: "2026-09-05" },
      weeks: { from: "2026-09-07", to: "2026-09-21", count: 3 },
    });
  });

  it("knows its keys", () => {
    expect(DEFAULT_SEARCH_PERIOD).toBe("28d");
    expect(isSearchPeriod("3m")).toBe(true);
    expect(isSearchPeriod("90d")).toBe(false);
    expect(isSearchPeriod(null)).toBe(false);
  });
});

describe("weeksWithin", () => {
  it("covers aligned Monday–Sunday ranges exactly", () => {
    expect(weeksWithin("2026-09-07", "2026-10-04")).toEqual({
      from: "2026-09-07",
      to: "2026-09-28",
      count: 4,
    });
  });

  it("drops partial weeks at both ends", () => {
    expect(weeksWithin("2026-09-08", "2026-10-03")).toEqual({
      from: "2026-09-14",
      to: "2026-09-21",
      count: 2,
    });
  });

  it("falls back to the latest complete week for 7 days", () => {
    expect(resolveSearchPeriod("7d", FINAL).weeks).toEqual({
      from: "2026-09-21",
      to: "2026-09-21",
      count: 1,
    });
    // Pazar biten 7 gün tam bir haftadır.
    expect(resolveSearchPeriod("7d", "2026-10-04").weeks).toEqual({
      from: "2026-09-28",
      to: "2026-09-28",
      count: 1,
    });
  });

  it("never includes a day after the end", () => {
    for (let offset = 0; offset < 14; offset += 1) {
      const to = addDays("2026-10-01", offset);
      const weeks = weeksWithin(addDays(to, -20), to);
      expect(addDays(weeks.to, 6) <= to).toBe(true);
    }
  });
});
