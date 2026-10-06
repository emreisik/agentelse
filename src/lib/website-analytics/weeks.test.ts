import { describe, expect, it } from "vitest";

import { addDays } from "./days";
import {
  isoWeekMonday,
  isoYearIsoWeekKey,
  latestCompleteWeek,
  mondayOfIsoYearIsoWeek,
  mondaysBetween,
  weekSunday,
  weeklyFloor,
  weeksInside,
} from "./weeks";

// Bu dosyanın kanıtladığı: ISO hafta anahtarı GA'nın `isoYearIsoWeek`
// biçimiyle aynıdır (yıl Perşembe'den, 53 haftalık yıllar dahil) ve geri
// çevrilir; her gün kendi Pazartesi'sine düşer; "son kesinleşen hafta"
// gecikmeye göre doğru seçilir; haftalık kapsamın ilk haftası mülk yaşıyla
// sınırlanır.

// 2026-10-05 Pazartesi.
const WEEK = [
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-10",
  "2026-10-11",
];

describe("ISO week keys", () => {
  it("matches GA's isoYearIsoWeek and round-trips", () => {
    expect(isoYearIsoWeekKey("2026-10-05")).toBe("202641");
    expect(isoYearIsoWeekKey("2026-12-28")).toBe("202653");
    expect(isoYearIsoWeekKey("2027-01-03")).toBe("202653");
    expect(isoYearIsoWeekKey("2027-01-04")).toBe("202701");
    // 1 Ocak 2026 Perşembe: 2026'nın 1. haftası 2025-12-29'da başlar.
    expect(isoYearIsoWeekKey("2025-12-29")).toBe("202601");
    expect(mondayOfIsoYearIsoWeek("202641")).toBe("2026-10-05");
    expect(mondayOfIsoYearIsoWeek("202653")).toBe("2026-12-28");
    expect(mondayOfIsoYearIsoWeek("202701")).toBe("2027-01-04");
    // 2027'nin 53. haftası yok.
    expect(mondayOfIsoYearIsoWeek("202753")).toBeNull();
    expect(mondayOfIsoYearIsoWeek("202600")).toBeNull();
    expect(mondayOfIsoYearIsoWeek("2026-41")).toBeNull();
    expect(mondayOfIsoYearIsoWeek(undefined)).toBeNull();
    for (let day = "2024-12-20"; day <= "2027-01-20"; day = addDays(day, 1)) {
      expect(mondayOfIsoYearIsoWeek(isoYearIsoWeekKey(day))).toBe(
        isoWeekMonday(day),
      );
    }
  });

  it("puts every weekday on its Monday", () => {
    for (const day of WEEK) expect(isoWeekMonday(day)).toBe("2026-10-05");
    expect(isoWeekMonday("2026-10-12")).toBe("2026-10-12");
    expect(weekSunday("2026-10-05")).toBe("2026-10-11");
  });
});

describe("week ranges", () => {
  it("lists Mondays inclusively and nothing for a reversed range", () => {
    expect(mondaysBetween("2026-09-21", "2026-10-05")).toEqual([
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ]);
    expect(mondaysBetween("2026-10-05", "2026-10-05")).toEqual(["2026-10-05"]);
    expect(mondaysBetween("2026-10-12", "2026-10-05")).toEqual([]);
  });

  it("keeps only the weeks whose seven days are inside", () => {
    expect(weeksInside("2026-09-28", "2026-10-11")).toEqual([
      "2026-09-28",
      "2026-10-05",
    ]);
    expect(weeksInside("2026-09-29", "2026-10-11")).toEqual(["2026-10-05"]);
    expect(weeksInside("2026-09-28", "2026-10-10")).toEqual(["2026-09-28"]);
    expect(weeksInside("2026-09-29", "2026-10-10")).toEqual([]);
  });

  it("finds the latest final week for lag 8 and lag 3 on every weekday", () => {
    // today - 8 Pazar'a denk gelirse o hafta, yoksa bir önceki tam hafta.
    const lag8 = WEEK.map((today) => latestCompleteWeek(today, 8));
    expect(lag8).toEqual([
      "2026-09-21",
      "2026-09-21",
      "2026-09-21",
      "2026-09-21",
      "2026-09-21",
      "2026-09-21",
      // 2026-10-11 - 8 = 2026-10-03 (Cumartesi): 28 Eylül haftası henüz değil.
      "2026-09-21",
    ]);
    // 2026-10-12 - 8 = 2026-10-04 (Pazar): 28 Eylül haftası kesinleşti.
    expect(latestCompleteWeek("2026-10-12", 8)).toBe("2026-09-28");
    expect(latestCompleteWeek("2026-10-13", 8)).toBe("2026-09-28");
    const lag3 = WEEK.map((today) => latestCompleteWeek(today, 3));
    expect(lag3).toEqual([
      "2026-09-21",
      "2026-09-21",
      "2026-09-28",
      "2026-09-28",
      "2026-09-28",
      "2026-09-28",
      "2026-09-28",
    ]);
    for (const today of [...WEEK, "2026-10-12", "2026-10-13"]) {
      for (const lag of [3, 8]) {
        const monday = latestCompleteWeek(today, lag);
        expect(isoWeekMonday(monday)).toBe(monday);
        expect(weekSunday(monday) <= addDays(today, -lag)).toBe(true);
        expect(weekSunday(addDays(monday, 7)) > addDays(today, -lag)).toBe(
          true,
        );
      }
    }
  });

  it("starts the weekly history 400 days back or at the property's week", () => {
    // 2026-10-06 - 400 = 2025-09-01 (Pazartesi).
    expect(weeklyFloor("2026-10-06", 400, null)).toBe("2025-09-01");
    // 2026-10-07 - 400 = 2025-09-02 (Salı): bir sonraki Pazartesi.
    expect(weeklyFloor("2026-10-07", 400, null)).toBe("2025-09-08");
    expect(weeklyFloor("2026-10-06", 400, "2025-01-01")).toBe("2025-09-01");
    // Genç mülk: oluşturulduğu hafta (Pazartesi'si).
    expect(weeklyFloor("2026-10-06", 400, "2026-08-13")).toBe("2026-08-10");
  });
});
