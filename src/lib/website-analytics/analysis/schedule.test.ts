import { describe, expect, it } from "vitest";

import {
  dailyTargets,
  evaluationWindows,
  monthRunFor,
  weeklyDue,
  weeklyTargetWeek,
} from "./schedule";

// Bu dosyanın kanıtladığı: haftalık tur mülk saatiyle Pazartesi 06:30'dan
// sonra ve Pazar verisi gelince açılır (yaz/kış saati geçişi dahil); ay turu
// tamamen dolmuş son ayı seçer; değerlendirme pencereleri plan §6.3 ile aynı.

const SKOPJE = "Europe/Skopje";
const LAST_WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };

describe("weeklyTargetWeek", () => {
  it("opens at Monday 06:30 property time (CEST)", () => {
    const at = (iso: string, completeThrough: string | null = "2026-10-04") =>
      weeklyTargetWeek({
        now: new Date(iso),
        timeZone: SKOPJE,
        completeThrough,
      });
    // 06:29 yerel = 04:29 UTC
    expect(at("2026-10-05T04:29:00Z")).toBeNull();
    expect(at("2026-10-05T04:31:00Z")).toEqual(LAST_WEEK);
    // Pazar verisi gelmeden açılmaz, gelince Salı'da da açık.
    expect(at("2026-10-05T10:00:00Z", "2026-10-03")).toBeNull();
    expect(at("2026-10-06T08:00:00Z", "2026-10-03")).toBeNull();
    expect(at("2026-10-06T08:00:00Z", "2026-10-04")).toEqual(LAST_WEEK);
    expect(at("2026-10-07T08:00:00Z", "2026-10-05")).toEqual(LAST_WEEK);
    expect(at("2026-10-05T10:00:00Z", null)).toBeNull();
  });

  it("uses the property clock across DST changes", () => {
    // 29 Mart 2026'da yaz saati başlar: Pazartesi UTC+2.
    const spring = { monday: "2026-03-23", sunday: "2026-03-29" };
    expect(
      weeklyTargetWeek({
        now: new Date("2026-03-30T04:29:00Z"),
        timeZone: SKOPJE,
        completeThrough: "2026-03-29",
      }),
    ).toBeNull();
    expect(
      weeklyTargetWeek({
        now: new Date("2026-03-30T04:31:00Z"),
        timeZone: SKOPJE,
        completeThrough: "2026-03-29",
      }),
    ).toEqual(spring);
    // 25 Ekim 2026'da kış saatine dönülür: Pazartesi UTC+1.
    const autumn = { monday: "2026-10-19", sunday: "2026-10-25" };
    expect(
      weeklyTargetWeek({
        now: new Date("2026-10-26T05:29:00Z"),
        timeZone: SKOPJE,
        completeThrough: "2026-10-25",
      }),
    ).toBeNull();
    expect(
      weeklyTargetWeek({
        now: new Date("2026-10-26T05:31:00Z"),
        timeZone: SKOPJE,
        completeThrough: "2026-10-25",
      }),
    ).toEqual(autumn);
  });

  it("uses the property day, not the UTC day", () => {
    // UTC'de hâlâ Pazar; Tokyo'da Pazartesi 08:30.
    expect(
      weeklyTargetWeek({
        now: new Date("2026-10-04T23:30:00Z"),
        timeZone: "Asia/Tokyo",
        completeThrough: "2026-10-04",
      }),
    ).toEqual(LAST_WEEK);
    // Geçersiz saat dilimi UTC'ye düşer.
    expect(
      weeklyTargetWeek({
        now: new Date("2026-10-05T06:31:00Z"),
        timeZone: "Not/AZone",
        completeThrough: "2026-10-04",
      }),
    ).toEqual(LAST_WEEK);
  });
});

describe("weeklyDue", () => {
  it("is due once per new week", () => {
    expect(weeklyDue({ week: null, lastWeek: null })).toBe(false);
    expect(weeklyDue({ week: LAST_WEEK, lastWeek: null })).toBe(true);
    expect(weeklyDue({ week: LAST_WEEK, lastWeek: "2026-09-21" })).toBe(true);
    expect(weeklyDue({ week: LAST_WEEK, lastWeek: "2026-09-28" })).toBe(false);
  });
});

describe("dailyTargets", () => {
  it("re-checks the last three days once per complete day", () => {
    expect(
      dailyTargets({ completeThrough: "2026-10-05", lastDailyDay: null }),
    ).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(
      dailyTargets({
        completeThrough: "2026-10-05",
        lastDailyDay: "2026-10-04",
      }),
    ).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(
      dailyTargets({
        completeThrough: "2026-10-05",
        lastDailyDay: "2026-10-05",
      }),
    ).toEqual([]);
    expect(dailyTargets({ completeThrough: null, lastDailyDay: null })).toEqual(
      [],
    );
  });
});

describe("monthRunFor", () => {
  it("picks the latest month fully covered by completeThrough", () => {
    expect(
      monthRunFor({ completeThrough: "2026-09-30", lastMonth: null }),
    ).toBe("2026-09");
    expect(
      monthRunFor({ completeThrough: "2026-09-29", lastMonth: null }),
    ).toBe("2026-08");
    expect(
      monthRunFor({ completeThrough: "2026-10-05", lastMonth: null }),
    ).toBe("2026-09");
    expect(
      monthRunFor({ completeThrough: "2026-10-05", lastMonth: "2026-09" }),
    ).toBeNull();
    expect(
      monthRunFor({ completeThrough: "2026-01-15", lastMonth: null }),
    ).toBe("2025-12");
    expect(monthRunFor({ completeThrough: null, lastMonth: null })).toBeNull();
  });
});

describe("evaluationWindows", () => {
  it("before 28 days, 7 days excluded, after 28 days", () => {
    expect(evaluationWindows("2026-10-10")).toEqual({
      before: { from: "2026-09-12", to: "2026-10-09" },
      after: { from: "2026-10-17", to: "2026-11-13" },
    });
  });
});
