import { describe, expect, it } from "vitest";

import {
  DEFAULT_PICKER_TIME,
  dayInRange,
  dayPresets,
  fallbackDayFor,
  formatDayLabel,
  formatPickerValue,
  HOUR_OPTIONS,
  isDayValue,
  isTimeValue,
  joinDateTime,
  keyboardDayStep,
  minuteOptions,
  monthTitle,
  parseTimeInput,
  shiftDayByMonths,
  shiftView,
  sixWeekGrid,
  gridRange,
  splitDateTime,
  todayKeyIn,
  viewOfDay,
  weekEdge,
  withDay,
  withTime,
} from "./date-picker";

describe("değer biçimleri", () => {
  it("gün ve saat doğrulaması", () => {
    expect(isDayValue("2026-10-07")).toBe(true);
    expect(isDayValue("2026-02-30")).toBe(false);
    expect(isDayValue("")).toBe(false);
    expect(isTimeValue("09:05")).toBe(true);
    expect(isTimeValue("24:00")).toBe(false);
    expect(isTimeValue("9:05")).toBe(false);
    expect(isTimeValue(undefined)).toBe(false);
  });

  it("gün+saati ayırır ve birleştirir", () => {
    expect(splitDateTime("2026-10-07T10:00")).toEqual({
      day: "2026-10-07",
      time: "10:00",
    });
    expect(splitDateTime("2026-10-07")).toBeNull();
    expect(splitDateTime("2026-10-07T25:00")).toBeNull();
    expect(splitDateTime("2026-13-07T10:00")).toBeNull();
    expect(joinDateTime("2026-10-07", "10:00")).toBe("2026-10-07T10:00");
  });
});

describe("parseTimeInput", () => {
  it.each([
    ["9", "09:00"],
    ["09", "09:00"],
    ["930", "09:30"],
    ["0930", "09:30"],
    ["2130", "21:30"],
    ["9:30", "09:30"],
    ["09:30", "09:30"],
    ["21.30", "21:30"],
    [" 18:45 ", "18:45"],
    ["0", "00:00"],
  ])("%s -> %s", (raw, expected) => {
    expect(parseTimeInput(raw)).toBe(expected);
  });

  it.each(["", "abc", "24:00", "12:60", "25", "9:5", "12345", "9:30pm"])(
    "%s anlaşılmaz (null)",
    (raw) => {
      expect(parseTimeInput(raw)).toBeNull();
    },
  );
});

describe("gösterim", () => {
  it("aynı yılda yılı yazmaz, farklı yılda yazar", () => {
    expect(formatDayLabel("2026-10-07", 2026)).toBe("Wed, Oct 7");
    expect(formatDayLabel("2027-10-07", 2026)).toBe("Thu, Oct 7, 2027");
  });

  it("değeri her yerde aynı biçimde yazar", () => {
    expect(formatPickerValue({ day: "2026-10-07", time: "10:00" }, 2026)).toBe(
      "Wed, Oct 7 · 10:00",
    );
    expect(formatPickerValue({ day: "2026-10-07" }, 2026)).toBe("Wed, Oct 7");
    expect(formatPickerValue({ time: "10:00" }, 2026)).toBe("10:00");
    expect(formatPickerValue({}, 2026)).toBe("");
  });

  it("ay başlığı ve gezinti", () => {
    expect(monthTitle({ year: 2026, month: 10 })).toBe("October 2026");
    expect(shiftView({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
    expect(shiftView({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    });
    expect(viewOfDay("2026-10-07")).toEqual({ year: 2026, month: 10 });
    expect(viewOfDay("bozuk")).toBeNull();
  });
});

describe("bugün", () => {
  it("saat dilimi verilince o dilimin gününü verir", () => {
    // 23:30 UTC = İstanbul'da ertesi gün 02:30
    const now = new Date("2026-10-03T23:30:00Z");
    expect(todayKeyIn("Europe/Istanbul", now)).toBe("2026-10-04");
    expect(todayKeyIn("UTC", now)).toBe("2026-10-03");
  });
});

describe("aralık ve klavye", () => {
  it("min/max dahil", () => {
    expect(dayInRange("2026-10-03", "2026-10-03")).toBe(true);
    expect(dayInRange("2026-10-02", "2026-10-03")).toBe(false);
    expect(dayInRange("2026-10-09", null, "2026-10-08")).toBe(false);
    expect(dayInRange("2026-10-09")).toBe(true);
  });

  it("ok tuşları ve hafta kenarları", () => {
    expect(keyboardDayStep("ArrowLeft")).toBe(-1);
    expect(keyboardDayStep("ArrowDown")).toBe(7);
    expect(keyboardDayStep("x")).toBeNull();
    // 7 Ekim 2026 Çarşamba
    expect(weekEdge("2026-10-07", "start")).toBe("2026-10-05");
    expect(weekEdge("2026-10-07", "end")).toBe("2026-10-11");
  });
});

describe("kısayollar ve saat sütunları", () => {
  it("gün kısayolları bugünden hesaplanır", () => {
    // 3 Ekim 2026 Cumartesi -> sonraki Pazartesi 5 Ekim
    expect(dayPresets("2026-10-03")).toEqual([
      { label: "Today", key: "2026-10-03" },
      { label: "Tomorrow", key: "2026-10-04" },
      { label: "Next Mon", key: "2026-10-05" },
      { label: "In a week", key: "2026-10-10" },
    ]);
    // Pazartesi'de "Next Mon" 7 gün sonradır.
    expect(dayPresets("2026-10-05")[2]!.key).toBe("2026-10-12");
  });

  it("dakika sütunu adıma göre; ızgara dışı seçili dakika da görünür", () => {
    expect(minuteOptions(15)).toEqual(["00", "15", "30", "45"]);
    expect(minuteOptions(5)).toHaveLength(12);
    expect(minuteOptions(7)).toHaveLength(12);
    const withOdd = minuteOptions(15, "07");
    expect(withOdd).toEqual(["00", "07", "15", "30", "45"]);
    expect(minuteOptions(15, "15")).toHaveLength(4);
    expect(HOUR_OPTIONS).toHaveLength(24);
    expect(HOUR_OPTIONS[0]).toBe("00");
    expect(HOUR_OPTIONS[23]).toBe("23");
  });

  it("varsayılan saat geçerli bir saattir", () => {
    expect(isTimeValue(DEFAULT_PICKER_TIME)).toBe(true);
  });
});

describe("sixWeekGrid / shiftDayByMonths / gridRange", () => {
  it("her ay için 6 hafta (42 gün), Pazartesi başlar", () => {
    for (const view of [
      { year: 2026, month: 2 }, // 28 gün, 4 hafta + ek
      { year: 2026, month: 10 },
      { year: 2026, month: 3 }, // zaten 6 hafta
    ]) {
      const days = sixWeekGrid(view);
      expect(days).toHaveLength(42);
    }
    expect(sixWeekGrid({ year: 2026, month: 10 })[0]!.key).toBe("2026-09-28");
    expect(sixWeekGrid({ year: 2026, month: 10 })[41]!.key).toBe("2026-11-08");
  });

  it("ay kaydırınca ayın son gününe oturur", () => {
    expect(shiftDayByMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftDayByMonths("2026-03-15", -1)).toBe("2026-02-15");
    expect(shiftDayByMonths("2026-12-10", 1)).toBe("2027-01-10");
    expect(shiftDayByMonths("2026-10-07", 12)).toBe("2027-10-07");
  });

  it("görünür aralığı verir", () => {
    expect(gridRange({ year: 2026, month: 10 })).toEqual({
      first: "2026-09-28",
      last: "2026-11-08",
    });
  });
});

describe("gün+saat birleştirme kuralları", () => {
  it("gün seçilince saat korunur, yoksa varsayılan verilir", () => {
    expect(withDay("2026-10-07T18:30", "2026-10-09", "10:00")).toBe(
      "2026-10-09T18:30",
    );
    expect(withDay("", "2026-10-09", "10:00")).toBe("2026-10-09T10:00");
  });

  it("saat seçilince gün korunur, yoksa yedek gün atanır", () => {
    expect(withTime("2026-10-07T18:30", "09:00", "2026-10-03")).toBe(
      "2026-10-07T09:00",
    );
    expect(withTime("", "09:00", "2026-10-03")).toBe("2026-10-03T09:00");
  });

  it("yedek gün: bugün, alt sınır ileriyse alt sınır", () => {
    expect(fallbackDayFor("2026-10-03", undefined)).toBe("2026-10-03");
    expect(fallbackDayFor("2026-10-03", "2026-10-03")).toBe("2026-10-03");
    expect(fallbackDayFor("2026-10-03", "2026-10-10")).toBe("2026-10-10");
    expect(fallbackDayFor("2026-10-03", "2026-09-01")).toBe("2026-10-03");
  });
});
