import { addDays } from "@/lib/website-analytics/days";

// GA-F4 AN16 düzelticisi: resmî tatiller (docs/google-analytics-plan.md
// §6.2 AN16; ayrıntı docs/website-insights.md "Tatiller"). Tatil günleri
// AN1 tabanından ve hedefinden çıkar, SIGNIFICANT AN2'yi engeller, pencere
// bulgularına "Includes a public holiday." ekler. Tablo elle yazılmıştır:
// sabit tarihler, iki Paskalya hesabı ve 2024–2028 bayram tablosu. Yalnız
// GB için hafta sonuna denk gelen tatilin yerine geçen gün eklenir. Saf ve
// izomorfik.

export const HOLIDAY_COUNTRIES = [
  "TR",
  "MK",
  "RS",
  "AL",
  "BA",
  "XK",
  "BG",
  "GR",
  "DE",
  "GB",
  "US",
] as const;
export type HolidayCountry = (typeof HOLIDAY_COUNTRIES)[number];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

// 0 = Pazar … 6 = Cumartesi.
function weekdayOf(key: string): number {
  return new Date(`${key}T00:00:00.000Z`).getUTCDay();
}

// Batı (Gregoryen) Paskalyası: Anonim Gregoryen algoritması.
export function westernEaster(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dayKey(year, month, day);
}

// Ortodoks Paskalyası: Meeus Jülyen algoritması + 13 gün (Gregoryen takvim
// tarihi; 1900–2099 için geçerli).
export function orthodoxEaster(year: number): string {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return addDays(dayKey(year, month, day), 13);
}

// Ramazan (fitr) ve Kurban (adha) Bayramı'nın ilk günü, Türkiye Diyanet
// takvimi. doğrulanmalı: tarihler elle girildi; ülkeye göre bir gün kayabilir.
// Tabloda olmayan yılda bayram günü yoktur.
export const ISLAMIC_HOLIDAYS: Readonly<
  Record<number, { fitr: string; adha: string }>
> = {
  2024: { fitr: "2024-04-10", adha: "2024-06-16" },
  2025: { fitr: "2025-03-30", adha: "2025-06-06" },
  2026: { fitr: "2026-03-20", adha: "2026-05-27" },
  2027: { fitr: "2027-03-09", adha: "2027-05-16" },
  2028: { fitr: "2028-02-26", adha: "2028-05-05" },
};

// Ayın n'inci haftanın günü (weekday: 0 = Pazar).
function nthWeekday(
  year: number,
  month: number,
  weekday: number,
  n: number,
): string {
  const first = dayKey(year, month, 1);
  const offset = (weekday - weekdayOf(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const offset = (weekdayOf(last) - weekday + 7) % 7;
  return addDays(last, -offset);
}

function fixed(year: number, monthDays: readonly string[]): string[] {
  return monthDays.map((md) => `${year}-${md}`);
}

function span(start: string, from: number, to: number): string[] {
  const days: string[] = [];
  for (let offset = from; offset <= to; offset++) {
    days.push(addDays(start, offset));
  }
  return days;
}

function fitr(year: number): string[] {
  const entry = ISLAMIC_HOLIDAYS[year];
  return entry ? [entry.fitr] : [];
}

function adha(year: number): string[] {
  const entry = ISLAMIC_HOLIDAYS[year];
  return entry ? [entry.adha] : [];
}

// GB: 1 Ocak, 25 ve 26 Aralık hafta sonuna denk gelirse, tatil olmayan
// sonraki iş günü(leri) eklenir.
function withGbSubstitutes(year: number, days: string[]): string[] {
  const set = new Set(days);
  for (const md of ["01-01", "12-25", "12-26"]) {
    const key = `${year}-${md}`;
    const weekday = weekdayOf(key);
    if (weekday !== 0 && weekday !== 6) continue;
    let candidate = addDays(key, 1);
    while (
      set.has(candidate) ||
      weekdayOf(candidate) === 0 ||
      weekdayOf(candidate) === 6
    ) {
      candidate = addDays(candidate, 1);
    }
    set.add(candidate);
  }
  return [...set];
}

function countryDays(country: HolidayCountry, year: number): string[] {
  const western = westernEaster(year);
  const orthodox = orthodoxEaster(year);
  switch (country) {
    case "TR": {
      const islamic = ISLAMIC_HOLIDAYS[year];
      return [
        ...fixed(year, [
          "01-01",
          "04-23",
          "05-01",
          "05-19",
          "07-15",
          "08-30",
          "10-28",
          "10-29",
        ]),
        // Arife dahil: Ramazan fitr−1 … fitr+2, Kurban adha−1 … adha+3.
        ...(islamic ? span(islamic.fitr, -1, 2) : []),
        ...(islamic ? span(islamic.adha, -1, 3) : []),
      ];
    }
    case "MK":
      return [
        ...fixed(year, [
          "01-01",
          "01-07",
          "05-01",
          "05-24",
          "08-02",
          "09-08",
          "10-11",
          "10-23",
          "12-08",
        ]),
        addDays(orthodox, 1),
        ...fitr(year),
      ];
    case "RS":
      return [
        ...fixed(year, [
          "01-01",
          "01-02",
          "01-07",
          "02-15",
          "02-16",
          "05-01",
          "05-02",
          "11-11",
        ]),
        addDays(orthodox, -2),
        orthodox,
        addDays(orthodox, 1),
      ];
    case "AL":
      return [
        ...fixed(year, [
          "01-01",
          "01-02",
          "03-14",
          "03-22",
          "05-01",
          "11-28",
          "11-29",
          "12-08",
          "12-25",
        ]),
        western,
        orthodox,
        ...fitr(year),
        ...adha(year),
      ];
    case "BA":
      return [
        ...fixed(year, [
          "01-01",
          "01-02",
          "01-07",
          "03-01",
          "05-01",
          "05-02",
          "11-25",
          "12-25",
        ]),
        addDays(western, 1),
        addDays(orthodox, 1),
        ...fitr(year),
        ...adha(year),
      ];
    case "XK":
      return [
        ...fixed(year, [
          "01-01",
          "01-02",
          "01-07",
          "02-17",
          "04-09",
          "05-01",
          "05-09",
          "12-25",
        ]),
        addDays(western, 1),
        addDays(orthodox, 1),
        ...fitr(year),
        ...adha(year),
      ];
    case "BG":
      return [
        ...fixed(year, [
          "01-01",
          "03-03",
          "05-01",
          "05-06",
          "05-24",
          "09-06",
          "09-22",
          "12-24",
          "12-25",
          "12-26",
        ]),
        addDays(orthodox, -2),
        orthodox,
        addDays(orthodox, 1),
      ];
    case "GR":
      return [
        ...fixed(year, [
          "01-01",
          "01-06",
          "03-25",
          "05-01",
          "08-15",
          "10-28",
          "12-25",
          "12-26",
        ]),
        // Kathara Deftera (−48), Kutsal Cuma, Paskalya Pazartesi, Ruhun
        // Pazartesi'si (+50).
        addDays(orthodox, -48),
        addDays(orthodox, -2),
        addDays(orthodox, 1),
        addDays(orthodox, 50),
      ];
    case "DE":
      return [
        ...fixed(year, [
          "01-01",
          "05-01",
          "10-03",
          "12-24",
          "12-25",
          "12-26",
          "12-31",
        ]),
        addDays(western, -2),
        addDays(western, 1),
        addDays(western, 39),
        addDays(western, 50),
      ];
    case "GB":
      return withGbSubstitutes(year, [
        ...fixed(year, ["01-01", "12-24", "12-25", "12-26", "12-31"]),
        addDays(western, -2),
        addDays(western, 1),
        nthWeekday(year, 5, 1, 1),
        lastWeekday(year, 5, 1),
        lastWeekday(year, 8, 1),
      ]);
    case "US": {
      const thanksgiving = nthWeekday(year, 11, 4, 4);
      return [
        ...fixed(year, [
          "01-01",
          "06-19",
          "07-04",
          "11-11",
          "12-24",
          "12-25",
          "12-31",
        ]),
        nthWeekday(year, 1, 1, 3),
        nthWeekday(year, 2, 1, 3),
        lastWeekday(year, 5, 1),
        nthWeekday(year, 9, 1, 1),
        nthWeekday(year, 10, 1, 2),
        thanksgiving,
        addDays(thanksgiving, 1),
      ];
    }
  }
}

const COUNTRY_SET: ReadonlySet<string> = new Set(HOLIDAY_COUNTRIES);

function isHolidayCountry(value: string): value is HolidayCountry {
  return COUNTRY_SET.has(value);
}

// Sıralı, tekil "YYYY-MM-DD"; desteklenmeyen ülke ya da null'da [] (büyük/küçük
// harf duyarsız).
export function holidaysFor(country: string | null, year: number): string[] {
  if (!country || !Number.isInteger(year)) return [];
  const code = country.trim().toUpperCase();
  if (!isHolidayCountry(code)) return [];
  return [...new Set(countryDays(code, year))]
    .filter((day) => day.startsWith(`${year}-`))
    .sort();
}

export function holidaysBetween(
  country: string | null,
  from: string,
  to: string,
): Set<string> {
  const result = new Set<string>();
  const first = Number(from.slice(0, 4));
  const last = Number(to.slice(0, 4));
  if (!Number.isInteger(first) || !Number.isInteger(last)) return result;
  for (let year = first; year <= last; year++) {
    for (const day of holidaysFor(country, year)) {
      if (day >= from && day <= to) result.add(day);
    }
  }
  return result;
}

// Tatil ülkesi: Project.country büyük harfle, countries doluysa ya da ülke
// "US" değilse. "US" migration varsayılanıdır: countries boşken US tatillerini
// sessizce çıkarmamak için null.
export function holidayCountryOf(project: {
  country: string | null;
  countries: readonly string[];
}): string | null {
  const country = project.country?.trim().toUpperCase() ?? "";
  if (!country) return null;
  return project.countries.length > 0 || country !== "US" ? country : null;
}
