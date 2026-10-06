import { describe, expect, it } from "vitest";

import {
  dailySlot,
  detectGap,
  dueGscStages,
  pendingMonths,
  pendingWeeks,
  planDailyWrites,
  resolveFinalThrough,
  backfillWriteDays,
  type GscSyncState,
} from "./schedule";

// Bu dosyanın kanıtladığı: günlük pencere PT 06:00 ve 18:00'de açılır (yaz
// saati geçişinde de); aşamalar yalnız vadesi gelince çalışır; kesinleşen
// gün kuralı geri gitmez ve dünü geçmez; bağ çevrimdışı kaldıysa aradaki
// günler boşluk olur; haftalar/aylar tabandan eski istenmez; pencere
// kenarında sahte sıfır yazılmaz.

// 2026-10-06 Salı; Ekim'de PT = UTC−7, 2 Kasım'da UTC−8.
const at = (iso: string) => new Date(iso);

function state(overrides: Partial<GscSyncState> = {}): GscSyncState {
  return {
    lastMetadataAt: null,
    lastDailyAt: null,
    lastDailySlot: null,
    lastFinalDate: null,
    lastWeeklyWeek: null,
    lastMonthlyMonth: null,
    backfillDone: false,
    gapCount: 0,
    heavyPending: 0,
    heavyBlocked: false,
    ...overrides,
  };
}

describe("dailySlot", () => {
  it("opens the morning window at 06:00 PT and the evening one at 18:00 PT", () => {
    expect(dailySlot(at("2026-10-06T12:59:00Z"))).toBe("2026-10-05@18");
    expect(dailySlot(at("2026-10-06T13:00:00Z"))).toBe("2026-10-06@06");
    expect(dailySlot(at("2026-10-07T00:59:00Z"))).toBe("2026-10-06@06");
    expect(dailySlot(at("2026-10-07T01:00:00Z"))).toBe("2026-10-06@18");
  });

  it("follows Pacific standard time after the DST change", () => {
    expect(dailySlot(at("2026-11-02T13:59:00Z"))).toBe("2026-11-01@18");
    expect(dailySlot(at("2026-11-02T14:00:00Z"))).toBe("2026-11-02@06");
  });
});

describe("dueGscStages", () => {
  const now = at("2026-10-06T15:00:00Z"); // 08:00 PT

  it("starts metadata and daily at once for a new link", () => {
    expect(dueGscStages(state(), now)).toEqual({
      metadata: true,
      daily: true,
      weekly: false,
      monthly: false,
      backfill: false,
    });
  });

  it("waits for the next window once the current slot is done", () => {
    const done = state({
      lastMetadataAt: at("2026-10-06T14:00:00Z"),
      lastDailyAt: at("2026-10-06T13:30:00Z"),
      lastDailySlot: "2026-10-06@06",
      lastFinalDate: "2026-10-03",
      lastWeeklyWeek: "2026-09-21",
      lastMonthlyMonth: "2026-09-01",
      backfillDone: true,
    });
    expect(dueGscStages(done, now)).toEqual({
      metadata: false,
      daily: false,
      weekly: false,
      monthly: false,
      backfill: false,
    });
    expect(dueGscStages(done, at("2026-10-07T01:30:00Z")).daily).toBe(true);
    expect(dueGscStages(done, at("2026-10-07T15:00:00Z")).metadata).toBe(true);
  });

  it("runs the weekly stage once the final data passes a Sunday and the monthly one past a month end", () => {
    const base = state({
      lastDailySlot: "2026-10-06@06",
      lastDailyAt: now,
      lastWeeklyWeek: "2026-09-21",
      lastMonthlyMonth: "2026-08-01",
      backfillDone: true,
    });
    expect(
      dueGscStages({ ...base, lastFinalDate: "2026-10-03" }, now).weekly,
    ).toBe(false);
    expect(
      dueGscStages({ ...base, lastFinalDate: "2026-10-04" }, now).weekly,
    ).toBe(true);
    expect(
      dueGscStages({ ...base, lastFinalDate: "2026-09-29" }, now).monthly,
    ).toBe(false);
    expect(
      dueGscStages({ ...base, lastFinalDate: "2026-09-30" }, now).monthly,
    ).toBe(true);
  });

  it("keeps backfill due for gaps, and for queued heavy work only while heavy is allowed", () => {
    const done = state({
      lastDailySlot: "2026-10-06@06",
      lastDailyAt: now,
      lastFinalDate: "2026-10-03",
      backfillDone: true,
    });
    expect(dueGscStages(done, now).backfill).toBe(false);
    expect(dueGscStages({ ...done, gapCount: 1 }, now).backfill).toBe(true);
    expect(dueGscStages({ ...done, heavyPending: 2 }, now).backfill).toBe(true);
    expect(
      dueGscStages({ ...done, heavyPending: 2, heavyBlocked: true }, now)
        .backfill,
    ).toBe(false);
    expect(
      dueGscStages({ ...done, lastFinalDate: null, gapCount: 1 }, now).backfill,
    ).toBe(false);
  });
});

describe("resolveFinalThrough", () => {
  const today = "2026-10-06";

  it("takes the last final row first", () => {
    expect(
      resolveFinalThrough({
        finalRowMax: "2026-10-03",
        firstIncompleteDate: "2026-10-04",
        today,
        previous: null,
      }),
    ).toBe("2026-10-03");
  });

  it("falls back to the day before first_incomplete_date, then to today−3", () => {
    expect(
      resolveFinalThrough({
        finalRowMax: null,
        firstIncompleteDate: "2026-10-05",
        today,
        previous: null,
      }),
    ).toBe("2026-10-04");
    expect(
      resolveFinalThrough({
        finalRowMax: null,
        firstIncompleteDate: null,
        today,
        previous: null,
      }),
    ).toBe("2026-10-03");
  });

  it("never goes back below the previous value nor past yesterday", () => {
    expect(
      resolveFinalThrough({
        finalRowMax: "2026-10-01",
        firstIncompleteDate: null,
        today,
        previous: "2026-10-03",
      }),
    ).toBe("2026-10-03");
    expect(
      resolveFinalThrough({
        finalRowMax: "2026-10-06",
        firstIncompleteDate: null,
        today,
        previous: null,
      }),
    ).toBe("2026-10-05");
  });
});

describe("planDailyWrites", () => {
  it("writes final days from the final response and later days as fresh", () => {
    const writes = planDailyWrites({
      start: "2026-09-26",
      yesterday: "2026-10-05",
      finalThrough: "2026-10-03",
      firstIncompleteDate: "2026-10-04",
      allDays: new Set(["2026-10-04", "2026-10-05"]),
    });
    expect(writes).toHaveLength(10);
    expect(writes.filter((write) => write.source === "final")).toHaveLength(8);
    expect(writes.slice(-2)).toEqual([
      { day: "2026-10-04", source: "all", fresh: true },
      { day: "2026-10-05", source: "all", fresh: true },
    ]);
  });

  it("skips a fresh day Google has not processed yet", () => {
    const writes = planDailyWrites({
      start: "2026-10-03",
      yesterday: "2026-10-05",
      finalThrough: "2026-10-03",
      firstIncompleteDate: "2026-10-05",
      allDays: new Set(),
    });
    expect(writes.map((write) => write.day)).toEqual([
      "2026-10-03",
      "2026-10-04",
    ]);
  });
});

describe("detectGap", () => {
  it("returns the missed days after a link was offline for 30 days", () => {
    expect(
      detectGap({
        previousFinal: "2026-08-27",
        dailyStart: "2026-09-26",
        windowStart: "2025-06-06",
      }),
    ).toEqual({ start: "2026-08-28", end: "2026-09-25" });
  });

  it("returns nothing when the previous final day is recent or unknown", () => {
    expect(
      detectGap({
        previousFinal: "2026-09-25",
        dailyStart: "2026-09-26",
        windowStart: "2025-06-06",
      }),
    ).toBeNull();
    expect(
      detectGap({
        previousFinal: "2026-10-02",
        dailyStart: "2026-09-26",
        windowStart: "2025-06-06",
      }),
    ).toBeNull();
    expect(
      detectGap({
        previousFinal: null,
        dailyStart: "2026-09-26",
        windowStart: "2025-06-06",
      }),
    ).toBeNull();
  });

  it("is clamped to Google's window", () => {
    expect(
      detectGap({
        previousFinal: "2024-01-01",
        dailyStart: "2026-09-26",
        windowStart: "2025-06-06",
      }),
    ).toEqual({ start: "2025-06-06", end: "2026-09-25" });
  });
});

describe("pendingWeeks / pendingMonths", () => {
  it("starts with the latest complete week and walks every week after the last one", () => {
    expect(
      pendingWeeks({
        lastWeeklyWeek: null,
        finalThrough: "2026-10-04",
        floor: "2025-06-09",
      }),
    ).toEqual(["2026-09-28"]);
    expect(
      pendingWeeks({
        lastWeeklyWeek: "2026-09-07",
        finalThrough: "2026-10-03",
        floor: "2025-06-09",
      }),
    ).toEqual(["2026-09-14", "2026-09-21"]);
  });

  it("is floored at Google's window", () => {
    expect(
      pendingWeeks({
        lastWeeklyWeek: "2024-01-01",
        finalThrough: "2025-06-29",
        floor: "2025-06-09",
      }),
    ).toEqual(["2025-06-09", "2025-06-16", "2025-06-23"]);
    expect(
      pendingMonths({
        lastMonthlyMonth: "2024-01-01",
        finalThrough: "2025-09-15",
        floor: "2025-06-06",
      }),
    ).toEqual(["2025-07-01", "2025-08-01"]);
  });

  it("starts with the latest complete month", () => {
    expect(
      pendingMonths({
        lastMonthlyMonth: null,
        finalThrough: "2026-10-03",
        floor: "2025-06-06",
      }),
    ).toEqual(["2026-09-01"]);
    expect(
      pendingMonths({
        lastMonthlyMonth: "2026-09-01",
        finalThrough: "2026-10-03",
        floor: "2025-06-06",
      }),
    ).toEqual([]);
  });
});

describe("backfillWriteDays", () => {
  const days = ["2025-06-06", "2025-06-07", "2025-06-08", "2025-06-09"];
  const base = { days, atFloor: false, gap: false, pendingTo: null };

  it("keeps the days before the first returned day pending in a normal chunk", () => {
    expect(
      backfillWriteDays({ ...base, returned: new Set(["2025-06-08"]) }),
    ).toEqual({ days: ["2025-06-08", "2025-06-09"], pendingTo: "2025-06-07" });
    // Satırsız parça: hiçbir gün yazılmaz, aralık parçanın son gününe kadar.
    expect(backfillWriteDays({ ...base, returned: new Set() })).toEqual({
      days: [],
      pendingTo: "2025-06-09",
    });
  });

  it("writes the pending days as zeros once an older chunk returns rows", () => {
    expect(
      backfillWriteDays({
        ...base,
        returned: new Set(["2025-06-06"]),
        pendingTo: "2025-06-12",
      }),
    ).toEqual({
      days: [...days, "2025-06-10", "2025-06-11", "2025-06-12"],
      pendingTo: null,
    });
    // Satırsız eski parça bekleyen aralığı korur.
    expect(
      backfillWriteDays({ ...base, returned: new Set(), pendingTo: "2025-06-12" }),
    ).toEqual({ days: [], pendingTo: "2025-06-12" });
  });

  it("drops the days before the first returned day and the pending range at the floor", () => {
    expect(
      backfillWriteDays({
        ...base,
        atFloor: true,
        returned: new Set(["2025-06-08"]),
      }),
    ).toEqual({ days: ["2025-06-08", "2025-06-09"], pendingTo: null });
    expect(
      backfillWriteDays({
        ...base,
        atFloor: true,
        returned: new Set(),
        pendingTo: "2025-06-12",
      }),
    ).toEqual({ days: [], pendingTo: null });
  });

  it("zero-fills every day of a gap chunk", () => {
    expect(
      backfillWriteDays({ ...base, gap: true, returned: new Set() }),
    ).toEqual({ days, pendingTo: null });
  });
});
