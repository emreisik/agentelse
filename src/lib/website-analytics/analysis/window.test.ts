import { describe, expect, it } from "vitest";

import type { GaStoredSlice } from "@/lib/website-analytics/slices";

import {
  emptyWindowTables,
  windowTablesFrom,
  type GaWindowDayTotal,
} from "./window";

// Bu dosyanın kanıtladığı: şüpheli gün toplamlardan ve DAY dilimlerinden
// düşer; hariç güne değen WEEK dilimi bütünüyle düşer ve kapsamı azaltır;
// WEEK dilimi 7 gün kapsar; landingOther kırpılan satırlardan gelir; gelir
// mikrodan ana birime çevrilir; usedDays/missingDays doğru sayılır.

const RANGE = { from: "2026-09-07", to: "2026-09-20" };

function total(day: string, sessions = 100): GaWindowDayTotal {
  return {
    day,
    sessions,
    engagedSessions: sessions / 2,
    keyEvents: 5,
    revenueMicros: BigInt(12_500_000),
    transactions: 1,
    engagementSec: 60,
    screenPageViews: 300,
  };
}

function channelSlice(day: string, organic: number): GaStoredSlice {
  return {
    day,
    dimensionHeaders: ["sessionDefaultChannelGroup"],
    metricHeaders: [
      "sessions",
      "engagedSessions",
      "activeUsers",
      "newUsers",
      "keyEvents",
      "totalRevenue",
    ],
    rows: [["Organic Search", organic, organic / 2, 1, 1, 2, 10]],
    truncated: false,
    otherRow: null,
    quality: {},
  };
}

function landingSlice(
  day: string,
  otherRow: number[] | null = null,
): GaStoredSlice {
  return {
    day,
    dimensionHeaders: ["landingPage"],
    metricHeaders: [
      "sessions",
      "engagedSessions",
      "keyEvents",
      "totalRevenue",
      "userEngagementDuration",
    ],
    rows: [["/pricing", 40, 20, 2, 0, 400]],
    truncated: otherRow !== null,
    otherRow,
    quality: otherRow ? { otherRow: true } : {},
  };
}

function days(from: string, count: number): string[] {
  const result: string[] = [];
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  for (let index = 0; index < count; index += 1) {
    result.push(
      new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    );
  }
  return result;
}

describe("windowTablesFrom", () => {
  it("drops excluded days from totals and day slices", () => {
    const all = days(RANGE.from, 14);
    const tables = windowTablesFrom({
      range: RANGE,
      exclude: new Set(["2026-09-10"]),
      totals: all.map((day) => total(day)),
      slices: {
        channel: {
          slices: all.map((day) => channelSlice(day, 10)),
          weekStarts: new Set(),
        },
      },
    });
    expect(tables.usedDays).toBe(13);
    expect(tables.excludedDays).toEqual(["2026-09-10"]);
    expect(tables.missingDays).toBe(0);
    expect(tables.totals.sessions).toBe(1300);
    expect(tables.channel).toEqual([
      { key: ["Organic Search"], values: [130, 65, 26, 130] },
    ]);
    expect(tables.coverage.channel).toBe(13);
  });

  it("drops a week slice that touches an excluded day and lowers coverage", () => {
    const secondWeek = days("2026-09-14", 7);
    const tables = windowTablesFrom({
      range: RANGE,
      exclude: new Set(["2026-09-09"]),
      totals: [],
      slices: {
        landing: {
          slices: [
            landingSlice("2026-09-07"),
            ...secondWeek.map((day) => landingSlice(day)),
          ],
          weekStarts: new Set(["2026-09-07"]),
        },
      },
    });
    expect(tables.coverage.landing).toBe(7);
    expect(tables.landing[0]?.values[0]).toBe(7 * 40);
  });

  it("counts a clean week slice as seven covered days", () => {
    const tables = windowTablesFrom({
      range: RANGE,
      exclude: new Set(),
      totals: [],
      slices: {
        landing: {
          slices: [landingSlice("2026-09-07"), landingSlice("2026-09-14")],
          weekStarts: new Set(["2026-09-07", "2026-09-14"]),
        },
      },
    });
    expect(tables.coverage.landing).toBe(14);
    expect(tables.landing[0]?.values[0]).toBe(80);
  });

  it("sums landingOther from the dropped-row totals", () => {
    const tables = windowTablesFrom({
      range: RANGE,
      exclude: new Set(),
      totals: [],
      slices: {
        landing: {
          slices: [
            landingSlice("2026-09-07", [5, 3, 1, 0, 50]),
            landingSlice("2026-09-08", [7, 2, 0, 0, 20]),
            landingSlice("2026-09-09"),
          ],
          weekStarts: new Set(),
        },
      },
    });
    expect(tables.landingOther).toEqual([12, 5, 1, 0, 70]);
    expect(tables.quality).toEqual({
      thresholded: false,
      otherRow: true,
      truncated: true,
    });
  });

  it("converts revenue micros to the major unit", () => {
    const tables = windowTablesFrom({
      range: RANGE,
      exclude: new Set(),
      totals: [total("2026-09-07"), total("2026-09-08")],
      slices: {},
    });
    expect(tables.totals.revenue).toBeCloseTo(25, 6);
  });

  it("counts used, excluded and missing days", () => {
    const tables = windowTablesFrom({
      range: RANGE,
      exclude: new Set(["2026-09-08", "2026-09-30"]),
      totals: days(RANGE.from, 10).map((day) => total(day)),
      slices: {},
    });
    // 14 gün: 9 kullanılan, 1 hariç (aralık dışındaki sayılmaz), 4 eksik.
    expect(tables.days).toBe(14);
    expect(tables.usedDays).toBe(9);
    expect(tables.excludedDays).toEqual(["2026-09-08"]);
    expect(tables.missingDays).toBe(4);
    expect(tables.landingOther).toBeNull();
  });
});

describe("emptyWindowTables", () => {
  it("has every day missing and nothing covered", () => {
    const tables = emptyWindowTables(RANGE);
    expect(tables).toMatchObject({ days: 14, usedDays: 0, missingDays: 14 });
    expect(tables.coverage).toEqual({});
  });
});
