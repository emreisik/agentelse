import { describe, expect, it } from "vitest";

import {
  adsetScheduleParam,
  dayPartLabel,
  dayPartOf,
  hoursPerWeek,
  validHours,
} from "./day-parting";

describe("day parting", () => {
  it("builds Meta's schedule from business hours, in account time", () => {
    const part = dayPartOf({ from: 9, to: 18, weekdaysOnly: true });
    expect(part).toEqual({ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 });
    expect(adsetScheduleParam(part)).toEqual([
      { start_minute: 540, end_minute: 1080, days: [1, 2, 3, 4, 5], timezone_type: "ADVERTISER" },
    ]);
  });

  it("every day uses Sunday=0 through Saturday=6", () => {
    expect(dayPartOf({ from: 0, to: 24, weekdaysOnly: false }).days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("only accepts whole hours with the end after the start", () => {
    expect(validHours({ from: 9, to: 18, weekdaysOnly: true })).toBe(true);
    expect(validHours({ from: 0, to: 24, weekdaysOnly: false })).toBe(true);
    expect(validHours({ from: 18, to: 9, weekdaysOnly: true })).toBe(false);
    expect(validHours({ from: 9, to: 9, weekdaysOnly: true })).toBe(false);
    expect(validHours({ from: 9.5, to: 18, weekdaysOnly: true })).toBe(false);
    expect(validHours({ from: -1, to: 18, weekdaysOnly: true })).toBe(false);
    expect(validHours({ from: 9, to: 25, weekdaysOnly: true })).toBe(false);
  });

  it("labels and counts the weekly hours", () => {
    const weekdays = dayPartOf({ from: 9, to: 18, weekdaysOnly: true });
    expect(dayPartLabel(weekdays)).toBe("Mon–Fri 09:00–18:00");
    expect(hoursPerWeek(weekdays)).toBe(45);
    expect(dayPartLabel(dayPartOf({ from: 8, to: 20, weekdaysOnly: false }))).toBe("Every day 08:00–20:00");
    expect(dayPartLabel({ days: [6, 0], startMinute: 600, endMinute: 960 })).toBe("Sun, Sat 10:00–16:00");
  });
});
