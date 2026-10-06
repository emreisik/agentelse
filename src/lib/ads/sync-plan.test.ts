import { describe, expect, it } from "vitest";

import {
  addDays,
  backoffMs,
  dayRanges,
  dueStages,
  hourInTimezone,
  safeTimezone,
  weekStartSunday,
} from "./sync-plan";

const now = new Date("2026-10-06T10:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("backoffMs", () => {
  it("doubles from 5 minutes up to 6 hours", () => {
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(2)).toBe(10 * 60_000);
    expect(backoffMs(3)).toBe(20 * 60_000);
    expect(backoffMs(50)).toBe(6 * 60 * 60_000);
  });
});

describe("dueStages", () => {
  const base = {
    now,
    lastHealthAt: minutesAgo(10),
    lastStructureAt: minutesAgo(10),
    lastInsightsAt: minutesAgo(10),
    lastBackfillDate: "2026-10-06",
    activeDelivery: true,
    accountToday: "2026-10-06",
    accountHour: 13,
  };

  it("does nothing when everything is fresh", () => {
    expect(dueStages(base)).toEqual({
      health: false,
      structure: false,
      insights: false,
      backfill: "none",
    });
  });

  it("refreshes today's insights every 30 minutes while delivering", () => {
    expect(dueStages({ ...base, lastInsightsAt: minutesAgo(31) }).insights).toBe(true);
    expect(
      dueStages({ ...base, activeDelivery: false, lastInsightsAt: minutesAgo(31) }).insights,
    ).toBe(false);
  });

  it("runs the initial load once and the daily backfill after 04:00 account time", () => {
    expect(dueStages({ ...base, lastBackfillDate: null }).backfill).toBe("initial");
    expect(
      dueStages({ ...base, lastBackfillDate: "2026-10-05", accountHour: 3 }).backfill,
    ).toBe("none");
    expect(
      dueStages({ ...base, lastBackfillDate: "2026-10-05", accountHour: 4 }).backfill,
    ).toBe("daily");
  });
});

describe("day helpers", () => {
  it("adds days across month ends", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("splits a range into 30-day chunks", () => {
    expect(dayRanges("2026-07-08", "2026-10-05")).toEqual([
      { since: "2026-07-08", until: "2026-08-06" },
      { since: "2026-08-07", until: "2026-09-05" },
      { since: "2026-09-06", until: "2026-10-05" },
    ]);
    expect(dayRanges("2026-10-05", "2026-10-05")).toEqual([
      { since: "2026-10-05", until: "2026-10-05" },
    ]);
  });

  it("finds the Sunday the Meta week starts on", () => {
    // 6 Oct 2026 is a Tuesday.
    expect(weekStartSunday("2026-10-06")).toBe("2026-10-04");
    expect(weekStartSunday("2026-10-04")).toBe("2026-10-04");
  });

  it("reads the hour in the account's time zone and falls back to UTC", () => {
    expect(hourInTimezone(now, "Europe/Istanbul")).toBe(13);
    expect(safeTimezone("Not/AZone")).toBe("UTC");
    expect(safeTimezone(null)).toBe("UTC");
  });
});
