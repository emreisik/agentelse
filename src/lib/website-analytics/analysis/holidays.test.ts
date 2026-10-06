import { describe, expect, it } from "vitest";

import {
  HOLIDAY_COUNTRIES,
  holidayCountryOf,
  holidaysBetween,
  holidaysFor,
  orthodoxEaster,
  westernEaster,
} from "./holidays";

// Bu dosyanın kanıtladığı: iki Paskalya hesabı bilinen tarihleri verir;
// Türkiye bayramları arife dahil; ABD ve Birleşik Krallık hareketli
// tatilleri ve GB yerine geçen günleri doğru; bilinmeyen ülke boş; varsayılan
// "US" (countries boş) tatil ülkesi sayılmaz.

describe("Easter", () => {
  it("western (Gregorian) Easter", () => {
    expect(westernEaster(2024)).toBe("2024-03-31");
    expect(westernEaster(2025)).toBe("2025-04-20");
    expect(westernEaster(2026)).toBe("2026-04-05");
  });

  it("orthodox Easter as a Gregorian date", () => {
    expect(orthodoxEaster(2024)).toBe("2024-05-05");
    expect(orthodoxEaster(2025)).toBe("2025-04-20");
    expect(orthodoxEaster(2026)).toBe("2026-04-12");
  });
});

describe("holidaysFor", () => {
  it("TR 2026 includes both Eids with the eve", () => {
    const tr = holidaysFor("TR", 2026);
    for (const day of [
      "2026-03-19",
      "2026-03-20",
      "2026-03-21",
      "2026-03-22",
      "2026-05-26",
      "2026-05-27",
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
    ]) {
      expect(tr).toContain(day);
    }
    expect(tr).not.toContain("2026-03-23");
    expect(tr).not.toContain("2026-05-31");
    expect(tr).toContain("2026-10-29");
  });

  it("a year without an Islamic entry has no Eid days", () => {
    const tr = holidaysFor("TR", 2030);
    expect(tr).toEqual([
      "2030-01-01",
      "2030-04-23",
      "2030-05-01",
      "2030-05-19",
      "2030-07-15",
      "2030-08-30",
      "2030-10-28",
      "2030-10-29",
    ]);
  });

  it("US Thanksgiving and the following Friday", () => {
    const us = holidaysFor("US", 2026);
    expect(us).toContain("2026-11-26");
    expect(us).toContain("2026-11-27");
    expect(us).toContain("2026-01-19"); // MLK
    expect(us).toContain("2026-05-25"); // Memorial Day
    expect(us).toContain("2026-09-07"); // Labor Day
  });

  it("GB 2027 substitutes for Christmas and Boxing Day on a weekend", () => {
    const gb = holidaysFor("GB", 2027);
    expect(gb).toContain("2027-12-27");
    expect(gb).toContain("2027-12-28");
    expect(gb).toContain("2027-05-03"); // ilk Pazartesi
    expect(gb).toContain("2027-05-31"); // son Pazartesi
    expect(gb).toContain("2027-08-30");
    // 2028-01-01 Cumartesi → 3 Ocak Pazartesi.
    expect(holidaysFor("GB", 2028)).toContain("2028-01-03");
  });

  it("orthodox-based days for MK, GR and DE western days", () => {
    expect(holidaysFor("MK", 2026)).toContain("2026-04-13");
    expect(holidaysFor("MK", 2026)).toContain("2026-03-20");
    const gr = holidaysFor("GR", 2026);
    expect(gr).toContain("2026-02-23"); // Kathara Deftera
    expect(gr).toContain("2026-06-01"); // +50
    const de = holidaysFor("DE", 2026);
    expect(de).toContain("2026-04-03");
    expect(de).toContain("2026-05-14"); // Ascension
  });

  it("is sorted, unique, case-insensitive and empty for unknown countries", () => {
    for (const country of HOLIDAY_COUNTRIES) {
      const days = holidaysFor(country, 2026);
      expect(days.length).toBeGreaterThan(4);
      expect([...days].sort()).toEqual(days);
      expect(new Set(days).size).toBe(days.length);
      expect(days.every((day) => day.startsWith("2026-"))).toBe(true);
    }
    expect(holidaysFor("tr", 2026)).toEqual(holidaysFor("TR", 2026));
    expect(holidaysFor("FR", 2026)).toEqual([]);
    expect(holidaysFor(null, 2026)).toEqual([]);
  });
});

describe("holidaysBetween", () => {
  it("spans year boundaries", () => {
    expect(
      [...holidaysBetween("DE", "2026-12-20", "2027-01-02")].sort(),
    ).toEqual([
      "2026-12-24",
      "2026-12-25",
      "2026-12-26",
      "2026-12-31",
      "2027-01-01",
    ]);
    expect(holidaysBetween(null, "2026-01-01", "2026-12-31").size).toBe(0);
  });
});

describe("holidayCountryOf", () => {
  it("ignores the migration default US with empty countries", () => {
    expect(holidayCountryOf({ country: "US", countries: [] })).toBeNull();
    expect(holidayCountryOf({ country: "US", countries: ["US"] })).toBe("US");
    expect(holidayCountryOf({ country: "mk", countries: [] })).toBe("MK");
    expect(holidayCountryOf({ country: null, countries: [] })).toBeNull();
  });
});
