import { describe, expect, it } from "vitest";

import {
  addMonths,
  addWeeks,
  dayRange,
  firstMonthStartOnOrAfter,
  firstWeekStartOnOrAfter,
  googleWindowStart,
  gscHour,
  gscToday,
  lastCompleteMonthStart,
  lastCompleteWeekStart,
  maxDay,
  minDay,
  shiftMonthsClamped,
  weekEndOf,
  weekStartOf,
} from "./dates";

// Bu dosyanın kanıtladığı: PT günü gece yarısında ve yaz saati geçişlerinde
// doğru döner; hafta/ay sınırları, ay kaydırma kırpması ve Google penceresi
// beklenen günleri verir.

describe("gscToday / gscHour", () => {
  it("switches day at Pacific midnight (PST)", () => {
    expect(gscToday(new Date("2026-01-15T07:59:59Z"))).toBe("2026-01-14");
    expect(gscToday(new Date("2026-01-15T08:00:00Z"))).toBe("2026-01-15");
    expect(gscHour(new Date("2026-01-15T08:00:00Z"))).toBe(0);
  });

  it("handles the spring DST change (2026-03-08)", () => {
    expect(gscToday(new Date("2026-03-08T07:59:59Z"))).toBe("2026-03-07");
    expect(gscToday(new Date("2026-03-08T08:00:00Z"))).toBe("2026-03-08");
    // 02:00 PST → 03:00 PDT: 10:00 UTC artık 03:00 PT.
    expect(gscHour(new Date("2026-03-08T10:00:00Z"))).toBe(3);
    // Ertesi gece yarısı PDT ile 07:00 UTC'dir.
    expect(gscToday(new Date("2026-03-09T06:59:59Z"))).toBe("2026-03-08");
    expect(gscToday(new Date("2026-03-09T07:00:00Z"))).toBe("2026-03-09");
  });

  it("handles the autumn DST change (2026-11-01)", () => {
    expect(gscToday(new Date("2026-11-01T06:59:59Z"))).toBe("2026-10-31");
    expect(gscToday(new Date("2026-11-01T07:00:00Z"))).toBe("2026-11-01");
    expect(gscToday(new Date("2026-11-02T07:59:59Z"))).toBe("2026-11-01");
    expect(gscToday(new Date("2026-11-02T08:00:00Z"))).toBe("2026-11-02");
    expect(gscHour(new Date("2026-11-02T07:30:00Z"))).toBe(23);
  });
});

describe("weeks", () => {
  it("uses ISO Monday–Sunday weeks", () => {
    expect(weekStartOf("2026-10-05")).toBe("2026-10-05"); // Pazartesi
    expect(weekStartOf("2026-10-11")).toBe("2026-10-05"); // Pazar
    expect(weekStartOf("2026-10-07")).toBe("2026-10-05");
    expect(weekEndOf("2026-10-05")).toBe("2026-10-11");
    expect(addWeeks("2026-10-05", -2)).toBe("2026-09-21");
  });

  it("finds the last complete week", () => {
    expect(lastCompleteWeekStart("2026-10-11")).toBe("2026-10-05"); // Pazar
    expect(lastCompleteWeekStart("2026-10-10")).toBe("2026-09-28");
    expect(lastCompleteWeekStart("2026-10-05")).toBe("2026-09-28");
  });

  it("finds the first week start on or after a day", () => {
    expect(firstWeekStartOnOrAfter("2026-10-05")).toBe("2026-10-05");
    expect(firstWeekStartOnOrAfter("2026-10-06")).toBe("2026-10-12");
  });
});

describe("months", () => {
  it("finds the last complete month", () => {
    expect(lastCompleteMonthStart("2026-09-30")).toBe("2026-09-01");
    expect(lastCompleteMonthStart("2026-10-03")).toBe("2026-09-01");
    expect(lastCompleteMonthStart("2026-01-10")).toBe("2025-12-01");
    expect(lastCompleteMonthStart("2028-02-29")).toBe("2028-02-01");
  });

  it("adds months to a month start", () => {
    expect(addMonths("2026-10-01", 1)).toBe("2026-11-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2026-10-01", -16)).toBe("2025-06-01");
  });

  it("clamps to the month length", () => {
    expect(shiftMonthsClamped("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonthsClamped("2028-03-31", -1)).toBe("2028-02-29");
    expect(shiftMonthsClamped("2026-01-31", 3)).toBe("2026-04-30");
    expect(shiftMonthsClamped("2026-10-15", -16)).toBe("2025-06-15");
  });

  it("finds the first month start on or after a day", () => {
    expect(firstMonthStartOnOrAfter("2026-10-01")).toBe("2026-10-01");
    expect(firstMonthStartOnOrAfter("2026-12-02")).toBe("2027-01-01");
  });

  it("places Google's window 16 months back", () => {
    expect(googleWindowStart("2026-10-06")).toBe("2025-06-06");
    expect(googleWindowStart("2027-06-30")).toBe("2026-02-28");
  });
});

describe("ranges", () => {
  it("lists inclusive days and is empty for a reversed range", () => {
    expect(dayRange("2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(dayRange("2026-10-06", "2026-10-06")).toEqual(["2026-10-06"]);
    expect(dayRange("2026-10-07", "2026-10-06")).toEqual([]);
  });

  it("minDay/maxDay ignore null and undefined", () => {
    expect(maxDay("2026-10-01", null, "2026-10-05", undefined)).toBe(
      "2026-10-05",
    );
    expect(minDay(null, "2026-10-01", "2026-09-30")).toBe("2026-09-30");
    expect(minDay(null, undefined)).toBeNull();
    expect(maxDay()).toBeNull();
  });
});
