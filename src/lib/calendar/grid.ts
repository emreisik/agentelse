// Content Calendar'ın saf tarih matematiği (IO yok, saat dilimi yok).
//
// Izgara tamamen Gregoryen takvim aritmetiğidir: "1 Ekim'den önceki Pazartesi
// hangi gün" sorusunun cevabı dünyanın her yerinde aynıdır. Date.UTC burada
// yalnızca takvim hesaplayıcısı olarak kullanılır (UTC getter/setter'ları ile,
// çalışma ortamının yerel saat dilimi sızmasın diye), gerçek bir an olarak
// değil. Bir Creative.scheduledFor anının hangi güne düştüğü ise saat dilimi
// ister: o iş src/lib/timezone.ts'te (dayKeyInTimezone).

export type CalendarView = "month" | "week";

export type YMD = { year: number; month: number; day: number };
export type GridDay = YMD & { key: string };

// Sayfanın ve bileşenin paylaştığı gezinti parametreleri.
export type CalendarNav = {
  view?: CalendarView;
  // "YYYY-MM" (ay görünümü)
  month?: string;
  // "YYYY-MM-DD" (hafta görünümü: bu günü içeren hafta)
  date?: string;
};

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymdKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

// "YYYY-MM-DD" -> parçalar; var olmayan günleri ("2026-02-31") reddeder.
export function parseDayKey(key: string | undefined): YMD | null {
  const match = DAY_KEY_RE.exec(key ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

export function parseMonthKey(
  key: string | undefined,
): { year: number; month: number } | null {
  const match = MONTH_KEY_RE.exec(key ?? "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

// `month` 1 tabanlıdır (JS Date'in 0 tabanlı ayının aksine).
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 0 = Pazartesi ... 6 = Pazar.
export function weekdayMonFirst(
  year: number,
  month: number,
  day: number,
): number {
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

export function addDays(ymd: YMD, delta: number): YMD {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  d.setUTCDate(d.getUTCDate() + delta);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function toGridDay(ymd: YMD): GridDay {
  return { ...ymd, key: ymdKey(ymd.year, ymd.month, ymd.day) };
}

// "YYYY-MM-DD" anahtarından `delta` gün sonrası (geçersiz anahtarda null).
export function addDaysToKey(key: string, delta: number): string | null {
  const ymd = parseDayKey(key);
  return ymd ? toGridDay(addDays(ymd, delta)).key : null;
}

export function shiftMonthParam(
  year: number,
  month: number,
  delta: number,
): string {
  const total = year * 12 + (month - 1) + delta;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return `${y}-${pad2(m + 1)}`;
}

// Ayı kapsayan, Pazartesi'den Pazar'a tam haftalarla dolu ızgara.
export function monthGridDays(year: number, month: number): GridDay[] {
  const last = daysInMonth(year, month);
  const start = addDays(
    { year, month, day: 1 },
    -weekdayMonFirst(year, month, 1),
  );
  const end = addDays(
    { year, month, day: last },
    6 - weekdayMonFirst(year, month, last),
  );
  return rangeDays(start, end);
}

// `anchor` gününü içeren Pazartesi-Pazar haftası.
export function weekGridDays(anchor: YMD): GridDay[] {
  const start = addDays(
    anchor,
    -weekdayMonFirst(anchor.year, anchor.month, anchor.day),
  );
  return rangeDays(start, addDays(start, 6));
}

// `anchor` gününü içeren haftadan başlayan İKİ hafta (14 gün): hafta görünümü
// iki haftayı alt alta, her hafta kendi satırında gösterir.
export function fortnightGridDays(anchor: YMD): GridDay[] {
  return [...weekGridDays(anchor), ...weekGridDays(addDays(anchor, 7))];
}

function rangeDays(start: YMD, end: YMD): GridDay[] {
  const endKey = ymdKey(end.year, end.month, end.day);
  const days: GridDay[] = [];
  let cursor = start;
  // Üst sınır yalnızca sonsuz döngüye karşı emniyet (en uzun ızgara 6 hafta).
  for (let i = 0; i < 60; i += 1) {
    const day = toGridDay(cursor);
    days.push(day);
    if (day.key === endKey) break;
    cursor = addDays(cursor, 1);
  }
  return days;
}

export type CalendarRange = {
  view: CalendarView;
  days: GridDay[];
  firstKey: string;
  lastKey: string;
  // Ay görünümünde ayın numarası (ay dışı günleri soluk göstermek için).
  focusMonth: number | null;
  title: string;
  prev: CalendarNav;
  next: CalendarNav;
  // Bugüne dönüş: parametresiz (varsayılan) hal.
  today: CalendarNav;
  // Geçerli aralık "bugün"ü içeriyorsa true (Today düğmesi pasif olur).
  isCurrent: boolean;
};

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const SHORT_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function utcDate(ymd: YMD): Date {
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
}

// URL parametrelerini ve "bugün"ü (proje saat diliminde) görünür aralığa çevirir.
// Geçersiz parametreler sessizce bugüne düşer.
export function buildCalendarRange(input: {
  view?: string;
  month?: string;
  date?: string;
  todayKey: string;
}): CalendarRange {
  const today = parseDayKey(input.todayKey);
  if (!today) throw new Error(`Invalid todayKey: ${input.todayKey}`);
  const view: CalendarView = input.view === "week" ? "week" : "month";

  if (view === "week") {
    const anchor = parseDayKey(input.date) ?? today;
    const days = fortnightGridDays(anchor);
    const first = days[0]!;
    const last = days[days.length - 1]!;
    const sameYear = first.year === last.year;
    const title = `${SHORT_FORMAT.format(utcDate(first))}${
      sameYear ? "" : `, ${first.year}`
    } – ${SHORT_FORMAT.format(utcDate(last))}, ${last.year}`;
    return {
      view,
      days,
      firstKey: first.key,
      lastKey: last.key,
      focusMonth: null,
      title,
      // Kayan pencere: bir hafta kayar, ikinci satır birinci olur.
      prev: { view, date: toGridDay(addDays(anchor, -7)).key },
      next: { view, date: toGridDay(addDays(anchor, 7)).key },
      today: { view },
      // "Şimdi": bugünün haftası ilk satırda.
      isCurrent: days.slice(0, 7).some((d) => d.key === input.todayKey),
    };
  }

  const parsed = parseMonthKey(input.month) ?? {
    year: today.year,
    month: today.month,
  };
  const days = monthGridDays(parsed.year, parsed.month);
  return {
    view,
    days,
    firstKey: days[0]!.key,
    lastKey: days[days.length - 1]!.key,
    focusMonth: parsed.month,
    title: MONTH_FORMAT.format(
      new Date(Date.UTC(parsed.year, parsed.month - 1, 1)),
    ),
    prev: { view, month: shiftMonthParam(parsed.year, parsed.month, -1) },
    next: { view, month: shiftMonthParam(parsed.year, parsed.month, 1) },
    today: { view },
    isCurrent: parsed.year === today.year && parsed.month === today.month,
  };
}

// Görünüm geçişinde bağlamı koru: aydan haftaya geçerken bugün ya da
// görünen ayın ilk günü, haftadan aya geçerken haftanın ayı.
export function switchViewNav(
  range: CalendarRange,
  to: CalendarView,
  todayKey: string,
): CalendarNav {
  if (range.view === to) return range.today;
  if (to === "week") {
    // Ay görünümünde bugün bu ayın içindeyse bugünün haftası, değilse ayın
    // ilk gününün haftası.
    const inView = range.days.some(
      (d) => d.key === todayKey && d.month === range.focusMonth,
    );
    if (inView) return { view: "week" };
    const firstOfMonth = range.days.find((d) => d.month === range.focusMonth);
    return { view: "week", date: firstOfMonth?.key };
  }
  // Haftadan aya: haftanın ortasındaki (Perşembe) günün ayı.
  const mid = range.days[3] ?? range.days[0]!;
  const todayParsed = parseDayKey(todayKey);
  const sameAsToday =
    todayParsed !== null &&
    todayParsed.year === mid.year &&
    todayParsed.month === mid.month;
  return sameAsToday
    ? { view: "month" }
    : { view: "month", month: `${mid.year}-${pad2(mid.month)}` };
}

// "Oct 5 – Oct 11" (bir hafta satırının başlığı).
export function formatShortRange(firstKey: string, lastKey: string): string {
  const first = parseDayKey(firstKey);
  const last = parseDayKey(lastKey);
  if (!first || !last) return `${firstKey} – ${lastKey}`;
  return `${SHORT_FORMAT.format(utcDate(first))} – ${SHORT_FORMAT.format(utcDate(last))}`;
}

const LONG_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

// "Tue, Oct 14" (bildirim metinleri için).
export function formatDayLong(key: string): string {
  const ymd = parseDayKey(key);
  return ymd ? LONG_DAY_FORMAT.format(utcDate(ymd)) : key;
}

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: "UTC",
});

export function weekdayShort(key: string): string {
  const ymd = parseDayKey(key);
  return ymd ? WEEKDAY_FORMAT.format(utcDate(ymd)) : "";
}
