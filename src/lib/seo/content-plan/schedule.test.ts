import { describe, expect, it } from "vitest";

import {
  addDaysToDayKey,
  daysInMonth,
  layoutSlotDates,
  manualPlanAllowed,
  monthOf,
  monthStart,
  planWindow,
} from "./schedule";

function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

describe("month helpers", () => {
  it("computes month keys and lengths", () => {
    expect(monthOf("2026-10-14")).toBe("2026-10");
    expect(monthStart("2026-10")).toBe("2026-10-01");
    expect(daysInMonth("2026-10")).toBe(31);
    expect(daysInMonth("2027-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-04")).toBe(30);
    expect(addDaysToDayKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysToDayKey("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("planWindow", () => {
  const table: [string, string, "early" | "open" | "closed"][] = [
    ["2026-10-01T09:00", "Oct 1", "early"],
    ["2026-10-02T08:59", "Oct 2 08:59", "early"],
    ["2026-10-02T09:00", "Oct 2 09:00", "open"],
    ["2026-10-24T23:59", "Oct 24", "open"],
    ["2026-10-25T00:00", "Oct 25", "closed"],
    ["2026-10-31T12:00", "Oct 31", "closed"],
    ["2027-02-21T10:00", "Feb 2027 day 21", "open"],
    ["2027-02-22T10:00", "Feb 2027 day 22", "closed"],
    ["2028-02-22T10:00", "leap Feb day 22", "open"],
    ["2028-02-23T10:00", "leap Feb day 23", "closed"],
    ["2026-11-02T09:00", "Nov 2", "open"],
    ["2026-11-23T09:00", "Nov 23", "open"],
    ["2026-11-24T09:00", "Nov 24", "closed"],
  ];
  it.each(table)("%s (%s) is %s", (local, _label, state) => {
    expect(planWindow(local).state).toBe(state);
  });

  it("reports the month and the days left", () => {
    expect(planWindow("2026-10-24T10:00")).toEqual({
      month: "2026-10",
      state: "open",
      daysLeft: 7,
    });
    expect(planWindow("2026-10-31T10:00").daysLeft).toBe(0);
  });

  it("treats unreadable input as closed", () => {
    expect(planWindow("garbage").state).toBe("closed");
    expect(planWindow("").month).toBe("");
  });
});

describe("manualPlanAllowed", () => {
  it("is allowed until two days remain", () => {
    expect(manualPlanAllowed("2026-10-01T09:00")).toBe(true);
    expect(manualPlanAllowed("2026-10-25T09:00")).toBe(true);
    expect(manualPlanAllowed("2026-10-29T09:00")).toBe(true);
    expect(manualPlanAllowed("2026-10-30T09:00")).toBe(false);
    expect(manualPlanAllowed("2026-10-31T09:00")).toBe(false);
    expect(manualPlanAllowed("nope")).toBe(false);
  });
});

describe("layoutSlotDates", () => {
  it("lays four weekdays at least two days apart from a Saturday", () => {
    const dates = layoutSlotDates({ month: "2026-10", today: "2026-10-03", count: 4, taken: [] });
    expect(dates).toHaveLength(4);
    for (const day of dates) {
      expect(weekday(day)).toBeGreaterThanOrEqual(1);
      expect(weekday(day)).toBeLessThanOrEqual(5);
      expect(day.startsWith("2026-10")).toBe(true);
      expect(day > "2026-10-03").toBe(true);
    }
    for (let i = 1; i < dates.length; i += 1) {
      const gap = (Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)) / 86_400_000;
      expect(gap).toBeGreaterThanOrEqual(2);
    }
    expect([...dates].sort()).toEqual(dates);
  });

  it("spreads the picks across the rest of the month", () => {
    const dates = layoutSlotDates({ month: "2026-10", today: "2026-10-02", count: 4, taken: [] });
    expect(dates[0]! < "2026-10-12").toBe(true);
    expect(dates[3]! > "2026-10-20").toBe(true);
  });

  it("skips taken days and never picks today", () => {
    const base = layoutSlotDates({ month: "2026-10", today: "2026-10-05", count: 3, taken: [] });
    const taken = layoutSlotDates({
      month: "2026-10",
      today: "2026-10-05",
      count: 3,
      taken: base,
    });
    for (const day of taken) expect(base).not.toContain(day);
    expect(base).not.toContain("2026-10-05");
    expect(taken).toHaveLength(3);
  });

  it("gives fewer dates when the month runs out", () => {
    const dates = layoutSlotDates({ month: "2026-10", today: "2026-10-26", count: 6, taken: [] });
    expect(dates.length).toBeLessThan(6);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((day) => day > "2026-10-26" && weekday(day) % 6 !== 0)).toBe(true);
    expect(layoutSlotDates({ month: "2026-10", today: "2026-10-31", count: 3, taken: [] })).toEqual([]);
  });

  it("packs as many as fit when asked for too many", () => {
    // Kalan hafta içi günler 27..30: en çok 2 gün (>= 2 arayla) sığar.
    const dates = layoutSlotDates({ month: "2026-10", today: "2026-10-26", count: 9, taken: [] });
    expect(dates).toHaveLength(2);
    expect(Date.parse(dates[1]!) - Date.parse(dates[0]!)).toBeGreaterThanOrEqual(2 * 86_400_000);
  });

  it("is deterministic and never leaves the month", () => {
    const input = { month: "2026-10", today: "2026-10-09", count: 5, taken: ["2026-10-14"] };
    const first = layoutSlotDates(input);
    expect(layoutSlotDates(input)).toEqual(first);
    expect(first.every((day) => day.startsWith("2026-10"))).toBe(true);
    expect(first).not.toContain("2026-10-14");
  });

  it("handles a past month relative to today and zero counts", () => {
    expect(layoutSlotDates({ month: "2026-10", today: "2026-11-05", count: 3, taken: [] })).toEqual([]);
    expect(layoutSlotDates({ month: "2026-10", today: "2026-10-02", count: 0, taken: [] })).toEqual([]);
  });

  it("starts at the month start when today is before it", () => {
    const dates = layoutSlotDates({ month: "2026-11", today: "2026-10-20", count: 2, taken: [] });
    expect(dates).toHaveLength(2);
    expect(dates.every((day) => day.startsWith("2026-11"))).toBe(true);
  });

  it("property: cap sizes never produce a weekend, a clash or a short spacing", () => {
    for (let today = 1; today <= 31; today += 1) {
      const day = `2026-10-${String(today).padStart(2, "0")}`;
      for (let count = 1; count <= 12; count += 1) {
        const dates = layoutSlotDates({ month: "2026-10", today: day, count, taken: [] });
        expect(dates.length).toBeLessThanOrEqual(count);
        dates.forEach((value, index) => {
          expect(value > day).toBe(true);
          expect([0, 6]).not.toContain(weekday(value));
          if (index > 0) {
            expect(Date.parse(value) - Date.parse(dates[index - 1]!)).toBeGreaterThanOrEqual(2 * 86_400_000);
          }
        });
      }
    }
  });
});
