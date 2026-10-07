import { describe, expect, it } from "vitest";

import {
  ACTION_UPDATE_KINDS,
  dayInRange,
  evaluationWindows,
  queryBounds,
  rankingUpdatesOverlapping,
  windowReady,
  yearAgoWeeks,
} from "./windows";

// Bu dosyanın kanıtladığı: PT gün anahtarlarıyla pencere hesabı, ilk 7 günün
// dışarıda kalması, yaz/kış saati sınırı ve güncelleme çakışması.

const at = (iso: string) => new Date(iso);

describe("evaluationWindows", () => {
  // 2026-09-02 Çarşamba (PT); öğle UTC'si aynı PT günüdür.
  const wed = at("2026-09-02T19:00:00.000Z");

  it("anchors on the PT day and takes 8 complete weeks before the anchor week", () => {
    const windows = evaluationWindows({ measureFrom: wed, windowDays: 28 });
    expect(windows.anchorDay).toBe("2026-09-02");
    expect(windows.preWeeks).toHaveLength(8);
    expect(windows.preWeeks[0]).toBe("2026-07-06");
    expect(windows.preWeeks[7]).toBe("2026-08-24");
    expect(windows.windowFrom).toBe("2026-07-06");
    // Çapa haftası (2026-08-31) ön pencerede değildir.
    expect(windows.preWeeks).not.toContain("2026-08-31");
  });

  it("excludes the first 7 days and keeps whole weeks inside the window", () => {
    const windows = evaluationWindows({ measureFrom: wed, windowDays: 28 });
    // 2026-09-09 + ilk Pazartesi = 2026-09-14; hafta sonları 09-20, 09-27 <= 09-30.
    expect(windows.postWeeks).toEqual(["2026-09-14", "2026-09-21"]);
    expect(windows.lastNeededWeek).toBe("2026-09-21");
    expect(windows.overlapFrom).toBe("2026-08-05");
    expect(windows.overlapTo).toBe("2026-09-27");
  });

  it("a Monday anchor can fit three post weeks", () => {
    const monday = at("2026-09-07T19:00:00.000Z");
    const windows = evaluationWindows({ measureFrom: monday, windowDays: 28 });
    expect(windows.postWeeks).toEqual(["2026-09-14", "2026-09-21", "2026-09-28"]);
  });

  it("extends a short window to at least two post weeks", () => {
    const windows = evaluationWindows({ measureFrom: wed, windowDays: 14 });
    expect(windows.postWeeks).toEqual(["2026-09-14", "2026-09-21"]);
    const tiny = evaluationWindows({ measureFrom: wed, windowDays: 7 });
    expect(tiny.postWeeks).toHaveLength(2);
    expect(tiny.postWeeks[0]).toBe("2026-09-14");
  });

  it("uses the PT day, not the UTC day, for the anchor", () => {
    // 2026-09-03 03:00 UTC = 2026-09-02 20:00 PT.
    const late = at("2026-09-03T03:00:00.000Z");
    expect(evaluationWindows({ measureFrom: late, windowDays: 28 }).anchorDay).toBe(
      "2026-09-02",
    );
  });

  it("is stable across the DST boundary", () => {
    // PDT 2026-11-01 sabah 02:00'de bitiyor; çapa Cumartesi 2026-10-31.
    const before = at("2026-10-31T19:00:00.000Z");
    const windows = evaluationWindows({ measureFrom: before, windowDays: 28 });
    expect(windows.anchorDay).toBe("2026-10-31");
    expect(windows.preWeeks[7]).toBe("2026-10-19");
    expect(windows.postWeeks[0]).toBe("2026-11-09");
    // Kış saatine geçişten sonraki bir gün.
    const after = at("2026-11-01T20:00:00.000Z");
    expect(evaluationWindows({ measureFrom: after, windowDays: 28 }).anchorDay).toBe(
      "2026-11-01",
    );
    // 2026-11-01 08:30 UTC = 00:30 PDT (hâlâ 1 Kasım), 09:30 UTC = 01:30 PDT.
    expect(dayInRange(at("2026-11-01T08:30:00.000Z"), "2026-11-01", "2026-11-01")).toBe(true);
    // 2026-11-02 07:30 UTC = 2026-11-01 23:30 PST.
    expect(dayInRange(at("2026-11-02T07:30:00.000Z"), "2026-11-01", "2026-11-01")).toBe(true);
    expect(dayInRange(at("2026-11-02T08:30:00.000Z"), "2026-11-01", "2026-11-01")).toBe(false);
  });
});

describe("windowReady", () => {
  it("waits for the last needed week", () => {
    const windows = evaluationWindows({
      measureFrom: at("2026-09-02T19:00:00.000Z"),
      windowDays: 28,
    });
    expect(windowReady(windows, null)).toBe(false);
    expect(windowReady(windows, "2026-09-14")).toBe(false);
    expect(windowReady(windows, "2026-09-21")).toBe(true);
    expect(windowReady(windows, "2026-09-28")).toBe(true);
  });
});

describe("dayInRange", () => {
  it("compares PT days: 23:30 PT and 07:30 UTC next day are the same PT day", () => {
    // 2026-09-10 23:30 PDT = 2026-09-11 06:30 UTC.
    const lateEvening = at("2026-09-11T06:30:00.000Z");
    // 2026-09-11 07:30 UTC = 00:30 PDT 11 Eylül: ertesi PT günü.
    const nextMorning = at("2026-09-11T07:30:00.000Z");
    expect(dayInRange(lateEvening, "2026-09-10", "2026-09-10")).toBe(true);
    expect(dayInRange(lateEvening, "2026-09-11", "2026-09-11")).toBe(false);
    expect(dayInRange(nextMorning, "2026-09-11", "2026-09-11")).toBe(true);
  });

  it("is inclusive on both ends", () => {
    const instant = at("2026-09-10T19:00:00.000Z");
    expect(dayInRange(instant, "2026-09-10", "2026-09-12")).toBe(true);
    expect(dayInRange(instant, "2026-09-08", "2026-09-10")).toBe(true);
    expect(dayInRange(instant, "2026-09-11", "2026-09-12")).toBe(false);
  });
});

describe("queryBounds", () => {
  it("widens the range by a day on each side", () => {
    const bounds = queryBounds("2026-09-10", "2026-09-12");
    expect(bounds.gte.toISOString()).toBe("2026-09-09T00:00:00.000Z");
    expect(bounds.lt.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
});

describe("yearAgoWeeks", () => {
  it("shifts every week back by 52 weeks", () => {
    expect(yearAgoWeeks(["2026-09-14", "2026-09-21"])).toEqual([
      "2025-09-15",
      "2025-09-22",
    ]);
    expect(yearAgoWeeks([])).toEqual([]);
  });
});

describe("rankingUpdatesOverlapping", () => {
  const windows = evaluationWindows({
    measureFrom: at("2026-09-02T19:00:00.000Z"),
    windowDays: 28,
  });
  const now = at("2026-10-05T19:00:00.000Z");
  const update = (kind: string, start: string, end: string | null) => ({
    name: `${kind}-${start}`,
    kind,
    startedAt: at(start),
    endedAt: end ? at(end) : null,
  });

  it("lists the ranking update kinds", () => {
    expect([...ACTION_UPDATE_KINDS]).toEqual([
      "CORE",
      "SPAM",
      "REVIEWS",
      "HELPFUL_CONTENT",
      "OTHER_RANKING",
    ]);
  });

  it("includes an open-ended CORE update that started earlier", () => {
    const hits = rankingUpdatesOverlapping(
      [update("CORE", "2026-07-01T17:00:00.000Z", null)],
      windows,
      now,
    );
    expect(hits).toHaveLength(1);
  });

  it("excludes SERVING and other non-ranking kinds", () => {
    const hits = rankingUpdatesOverlapping(
      [update("SERVING", "2026-09-05T17:00:00.000Z", "2026-09-06T17:00:00.000Z")],
      windows,
      now,
    );
    expect(hits).toEqual([]);
  });

  it("excludes an update that ended the PT day before overlapFrom", () => {
    // overlapFrom = 2026-08-05; 2026-08-04 17:00 UTC = 2026-08-04 PT.
    const ended = update("SPAM", "2026-07-20T17:00:00.000Z", "2026-08-04T17:00:00.000Z");
    expect(rankingUpdatesOverlapping([ended], windows, now)).toEqual([]);
    const touching = update("SPAM", "2026-07-20T17:00:00.000Z", "2026-08-05T17:00:00.000Z");
    expect(rankingUpdatesOverlapping([touching], windows, now)).toHaveLength(1);
  });

  it("excludes an update that started after the last needed week", () => {
    const later = update("CORE", "2026-09-28T17:00:00.000Z", null);
    expect(rankingUpdatesOverlapping([later], windows, now)).toEqual([]);
    const inside = update("REVIEWS", "2026-09-27T17:00:00.000Z", null);
    expect(rankingUpdatesOverlapping([inside], windows, now)).toHaveLength(1);
  });
});
