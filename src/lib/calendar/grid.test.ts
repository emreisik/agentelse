import { describe, expect, it } from "vitest";

import {
  addDaysToKey,
  buildCalendarRange,
  fortnightGridDays,
  formatShortRange,
  formatDayLong,
  monthGridDays,
  parseDayKey,
  parseMonthKey,
  switchViewNav,
  weekGridDays,
} from "./grid";

describe("parseDayKey / parseMonthKey", () => {
  it("geçerli anahtarları ayrıştırır, var olmayan günleri reddeder", () => {
    expect(parseDayKey("2026-10-03")).toEqual({
      year: 2026,
      month: 10,
      day: 3,
    });
    expect(parseDayKey("2026-02-29")).toBeNull();
    expect(parseDayKey("2028-02-29")).not.toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
    expect(parseDayKey("bozuk")).toBeNull();
    expect(parseDayKey(undefined)).toBeNull();
    expect(parseMonthKey("2026-10")).toEqual({ year: 2026, month: 10 });
    expect(parseMonthKey("2026-00")).toBeNull();
  });
});

describe("monthGridDays", () => {
  it("Pazartesi'den Pazar'a tam haftalarla dolar", () => {
    // Ekim 2026: 1 Ekim Perşembe, 31 Ekim Cumartesi.
    const days = monthGridDays(2026, 10);
    expect(days[0]!.key).toBe("2026-09-28");
    expect(days[days.length - 1]!.key).toBe("2026-11-01");
    expect(days.length % 7).toBe(0);
    expect(days).toHaveLength(35);
  });

  it("Pazartesi başlayan ay ek gün almaz, 6 haftalık ay 42 gün olur", () => {
    // Haziran 2026: 1 Haziran Pazartesi, 30 Haziran Salı.
    expect(monthGridDays(2026, 6)[0]!.key).toBe("2026-06-01");
    // Mart 2026: 1 Mart Pazar -> 6 hafta.
    expect(monthGridDays(2026, 3)).toHaveLength(42);
  });
});

describe("weekGridDays", () => {
  it("verilen günü içeren Pazartesi-Pazar haftasını verir (yıl sınırında da)", () => {
    const days = weekGridDays({ year: 2026, month: 1, day: 1 });
    expect(days.map((d) => d.key)).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });
});

describe("buildCalendarRange", () => {
  it("parametresiz ay görünümü bugünün ayıdır ve 'şimdi' sayılır", () => {
    const range = buildCalendarRange({ todayKey: "2026-10-03" });
    expect(range.view).toBe("month");
    expect(range.focusMonth).toBe(10);
    expect(range.title).toBe("October 2026");
    expect(range.isCurrent).toBe(true);
    expect(range.prev).toEqual({ view: "month", month: "2026-09" });
    expect(range.next).toEqual({ view: "month", month: "2026-11" });
  });

  it("geçersiz ay parametresi bugüne düşer", () => {
    const range = buildCalendarRange({
      month: "2026-13",
      todayKey: "2026-10-03",
    });
    expect(range.focusMonth).toBe(10);
  });

  it("başka bir ay 'şimdi' değildir", () => {
    const range = buildCalendarRange({
      month: "2026-12",
      todayKey: "2026-10-03",
    });
    expect(range.title).toBe("December 2026");
    expect(range.isCurrent).toBe(false);
  });

  it("hafta görünümü: iki hafta (14 gün) alt alta, başlık aralığı, ±7 gün kayan pencere", () => {
    const range = buildCalendarRange({
      view: "week",
      date: "2026-10-14",
      todayKey: "2026-10-03",
    });
    expect(range.days).toHaveLength(14);
    expect(range.firstKey).toBe("2026-10-12");
    expect(range.lastKey).toBe("2026-10-25");
    expect(range.title).toBe("Oct 12 – Oct 25, 2026");
    expect(range.prev).toEqual({ view: "week", date: "2026-10-07" });
    expect(range.next).toEqual({ view: "week", date: "2026-10-21" });
    expect(range.isCurrent).toBe(false);
  });

  it("hafta başlığı yıl sınırında iki yılı da yazar", () => {
    const range = buildCalendarRange({
      view: "week",
      date: "2026-01-01",
      todayKey: "2026-10-03",
    });
    expect(range.title).toBe("Dec 29, 2025 – Jan 11, 2026");
  });

  it("'şimdi' yalnız bugünün haftası ilk satırdaysa doğrudur", () => {
    // 3 Ekim Cumartesi: bugünün haftası 28 Eylül'de başlar.
    const thisWeek = buildCalendarRange({
      view: "week",
      todayKey: "2026-10-03",
    });
    expect(thisWeek.firstKey).toBe("2026-09-28");
    expect(thisWeek.isCurrent).toBe(true);
    // Pencere bir hafta ileri kayınca bugün pencerenin dışında kalır.
    const nextWeek = buildCalendarRange({
      view: "week",
      date: "2026-10-10",
      todayKey: "2026-10-03",
    });
    expect(nextWeek.days.some((d) => d.key === "2026-10-03")).toBe(false);
    expect(nextWeek.isCurrent).toBe(false);
    // Bugün yalnız İKİNCİ satırdaysa pencere "şimdi" değildir.
    const prevWeek = buildCalendarRange({
      view: "week",
      date: "2026-09-21",
      todayKey: "2026-10-03",
    });
    expect(prevWeek.days.some((d) => d.key === "2026-10-03")).toBe(true);
    expect(prevWeek.isCurrent).toBe(false);
  });
});

describe("fortnightGridDays / formatShortRange", () => {
  it("verilen günün haftasından başlayan 14 ardışık gün verir", () => {
    const days = fortnightGridDays({ year: 2026, month: 10, day: 3 });
    expect(days).toHaveLength(14);
    expect(days[0]!.key).toBe("2026-09-28");
    expect(days[6]!.key).toBe("2026-10-04");
    expect(days[7]!.key).toBe("2026-10-05");
    expect(days[13]!.key).toBe("2026-10-11");
  });

  it("hafta satırı başlığını yazar", () => {
    expect(formatShortRange("2026-10-05", "2026-10-11")).toBe(
      "Oct 5 – Oct 11",
    );
  });
});

describe("switchViewNav", () => {
  const today = "2026-10-03";

  it("bugünün olduğu aydan haftaya: bugünün haftası", () => {
    const month = buildCalendarRange({ todayKey: today });
    expect(switchViewNav(month, "week", today)).toEqual({ view: "week" });
  });

  it("başka aydan haftaya: ayın ilk gününün haftası", () => {
    const month = buildCalendarRange({ month: "2026-12", todayKey: today });
    expect(switchViewNav(month, "week", today)).toEqual({
      view: "week",
      date: "2026-12-01",
    });
  });

  it("haftadan aya: haftanın ayı (bugünün ayıysa parametresiz)", () => {
    const thisWeek = buildCalendarRange({ view: "week", todayKey: today });
    expect(switchViewNav(thisWeek, "month", today)).toEqual({ view: "month" });
    const later = buildCalendarRange({
      view: "week",
      date: "2026-12-10",
      todayKey: today,
    });
    expect(switchViewNav(later, "month", today)).toEqual({
      view: "month",
      month: "2026-12",
    });
  });
});

describe("addDaysToKey", () => {
  it("ay ve yıl sınırını aşar, geçersiz anahtarda null verir", () => {
    expect(addDaysToKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysToKey("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDaysToKey("2026-10-03", 0)).toBe("2026-10-03");
    expect(addDaysToKey("bozuk", 1)).toBeNull();
  });
});

describe("formatDayLong", () => {
  it("kısa gün adı ve tarih yazar", () => {
    expect(formatDayLong("2026-10-14")).toBe("Wed, Oct 14");
  });
});
