// Sitenin TEK tarih/saat seçicisinin saf mantığı (IO yok, React yok): değer
// biçimleri, ayrıştırma, gösterim ve ızgara yardımcıları. Bileşenler
// (src/components/ui/date-time-picker.tsx) yalnız bunları çağırır; böylece
// ekranın hiçbir yerinde farklı bir biçim ya da kural oluşmaz.
//
// Değer biçimleri (saat dilimsiz, duvar saati):
//   gün          "YYYY-MM-DD"
//   saat         "HH:mm" (24 saat)
//   gün + saat   "YYYY-MM-DDTHH:mm"  (eski <input type="datetime-local"> ile aynı)
// Bir anın hangi saat diliminde okunacağı değerin işi değil; çağıran
// (src/lib/timezone.ts) bunu `timezone` ile bilir ve gerekirse çevirir.

import {
  addDays,
  addDaysToKey,
  daysInMonth,
  formatDayLong,
  monthGridDays,
  pad2,
  parseDayKey,
  parseMonthKey,
  shiftMonthParam,
  weekdayMonFirst,
  weekGridDays,
  ymdKey,
  type GridDay,
} from "@/lib/calendar/grid";
import { dayKeyInTimezone } from "@/lib/timezone";

// Saati olmayan bir güne ilk seçimde verilen varsayılan yayın saati.
export const DEFAULT_PICKER_TIME = "10:00";
// Saati ileri/geri alan düğmelerin adımı (dakika). Başka bir dakika elle yazılır.
export const DEFAULT_TIME_STEP = 30;
// Hızlı saat kısayolları (içerik paylaşımı için sık seçilen saatler): altılı,
// panelde 3x2 oturur.
export const DEFAULT_TIME_PRESETS: readonly string[] = [
  "09:00",
  "11:00",
  "13:00",
  "15:00",
  "18:00",
  "20:00",
];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

export function isTimeValue(value: string | undefined | null): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

export function isDayValue(value: string | undefined | null): value is string {
  return typeof value === "string" && parseDayKey(value) !== null;
}

// "YYYY-MM-DDTHH:mm" -> parçalar; geçersizse null.
export function splitDateTime(
  value: string | undefined | null,
): { day: string; time: string } | null {
  const match = DATE_TIME_RE.exec(value ?? "");
  if (!match) return null;
  const [, day, time] = match;
  return isDayValue(day) && isTimeValue(time) ? { day, time } : null;
}

export function joinDateTime(day: string, time: string): string {
  return `${day}T${time}`;
}

// Gün seçildi: saat varsa korunur, yoksa varsayılan saat verilir.
export function withDay(
  current: string,
  day: string,
  defaultTime: string,
): string {
  return joinDateTime(day, splitDateTime(current)?.time ?? defaultTime);
}

// Saat seçildi: gün varsa korunur, yoksa `fallbackDay` (bugün ya da izin
// verilen ilk gün) atanır; böylece saat tek başına seçilince de tam bir değer
// oluşur.
export function withTime(
  current: string,
  time: string,
  fallbackDay: string,
): string {
  return joinDateTime(splitDateTime(current)?.day ?? fallbackDay, time);
}

// Gün seçilmeden saat seçilirse atanacak gün: bugün, ama alt sınır daha
// ilerideyse alt sınır.
export function fallbackDayFor(
  today: string,
  min: string | null | undefined,
): string {
  return min && min > today ? min : today;
}

// Elle yazılan saati "HH:mm"e çevirir; anlaşılmazsa null (alan eski değerine
// döner). "9", "930", "0930", "9:30", "09:30", "21.30" kabul edilir. Tek
// haneli dakika ("9:5") belirsiz olduğundan reddedilir.
export function parseTimeInput(raw: string): string | null {
  const text = raw.trim().replace(".", ":");
  let hours: number;
  let minutes: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{1,2}):(\d{2})$/.exec(text))) {
    hours = Number(match[1]);
    minutes = Number(match[2]);
  } else if ((match = /^(\d{1,2})$/.exec(text))) {
    hours = Number(match[1]);
    minutes = 0;
  } else if ((match = /^(\d{1,2})(\d{2})$/.exec(text)) && text.length >= 3) {
    hours = Number(match[1]);
    minutes = Number(match[2]);
  } else {
    return null;
  }
  if (hours > 23 || minutes > 59) return null;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

// Bugünün anahtarı: saat dilimi verilmişse O dilimde (proje takvimi), yoksa
// tarayıcının yerel günü.
export function todayKeyIn(timezone?: string, now: Date = new Date()): string {
  if (timezone) return dayKeyInTimezone(now, timezone);
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// "Wed, Oct 7" — yıl, başvuru yılından farklıysa eklenir ("Thu, Oct 7, 2027").
export function formatDayLabel(dayKey: string, referenceYear: number): string {
  const label = formatDayLong(dayKey);
  const year = Number(dayKey.slice(0, 4));
  return year === referenceYear ? label : `${label}, ${year}`;
}

// Seçicinin her yerde AYNI görünen değeri: "Wed, Oct 7 · 10:00", "Wed, Oct 7"
// ya da "10:00".
export function formatPickerValue(
  parts: { day?: string | null; time?: string | null },
  referenceYear: number,
): string {
  const day = parts.day ? formatDayLabel(parts.day, referenceYear) : null;
  return [day, parts.time || null].filter(Boolean).join(" · ");
}

const MONTH_TITLE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

export type ViewMonth = { year: number; month: number };

export function monthTitle(view: ViewMonth): string {
  return MONTH_TITLE.format(new Date(Date.UTC(view.year, view.month - 1, 1)));
}

export function monthShortName(month: number): string {
  return MONTH_SHORT.format(new Date(Date.UTC(2000, month - 1, 1)));
}

export function viewOfDay(dayKey: string): ViewMonth | null {
  const ymd = parseDayKey(dayKey);
  return ymd ? { year: ymd.year, month: ymd.month } : null;
}

export function shiftView(view: ViewMonth, delta: number): ViewMonth {
  return parseMonthKey(shiftMonthParam(view.year, view.month, delta)) ?? view;
}

// Seçici, ay değişince boyu zıplamasın diye HEP 6 haftalık (42 günlük) ızgara
// çizer: Pazartesi başlar, ayın dışındaki günler komşu aydan dolar.
export function sixWeekGrid(view: ViewMonth): GridDay[] {
  const days = monthGridDays(view.year, view.month);
  if (days.length >= 42) return days;
  const last = days[days.length - 1]!;
  return [...days, ...weekGridDays(addDays(last, 1))].slice(0, 42);
}

// Gün anahtarını `delta` ay kaydırır; hedef ay kısaysa ayın son gününe oturur
// (31 Ocak + 1 ay = 28 Şubat). PageUp/PageDown için.
export function shiftDayByMonths(dayKey: string, delta: number): string {
  const ymd = parseDayKey(dayKey);
  if (!ymd) return dayKey;
  const view = shiftView({ year: ymd.year, month: ymd.month }, delta);
  return ymdKey(
    view.year,
    view.month,
    Math.min(ymd.day, daysInMonth(view.year, view.month)),
  );
}

// Izgaranın ilk ve son günü (planlı gün sayılarını okumak için görünür aralık).
export function gridRange(view: ViewMonth): { first: string; last: string } {
  const days = sixWeekGrid(view);
  return { first: days[0]!.key, last: days[days.length - 1]!.key };
}


// Gün anahtarı sınırlar içinde mi (min/max dahil).
export function dayInRange(
  dayKey: string,
  min?: string | null,
  max?: string | null,
): boolean {
  if (min && dayKey < min) return false;
  if (max && dayKey > max) return false;
  return true;
}

// Klavye gezintisi: bir günden okla ne kadar gidilir (gün sayısı olarak).
export function keyboardDayStep(key: string): number | null {
  switch (key) {
    case "ArrowLeft":
      return -1;
    case "ArrowRight":
      return 1;
    case "ArrowUp":
      return -7;
    case "ArrowDown":
      return 7;
    default:
      return null;
  }
}

// Haftanın başına/sonuna git (Pazartesi başlar).
export function weekEdge(dayKey: string, edge: "start" | "end"): string {
  const ymd = parseDayKey(dayKey);
  if (!ymd) return dayKey;
  const offset = weekdayMonFirst(ymd.year, ymd.month, ymd.day);
  return (
    addDaysToKey(dayKey, edge === "start" ? -offset : 6 - offset) ?? dayKey
  );
}

export type DayPreset = { label: string; key: string };

// Gün kısayolları: bugünden hesaplanır, hep aynı dört seçenek.
export function dayPresets(todayKey: string): DayPreset[] {
  const today = parseDayKey(todayKey);
  if (!today) return [];
  const untilMonday = 7 - weekdayMonFirst(today.year, today.month, today.day);
  return [
    { label: "Today", key: todayKey },
    { label: "Tomorrow", key: addDaysToKey(todayKey, 1)! },
    { label: "Next Mon", key: addDaysToKey(todayKey, untilMonday)! },
    { label: "In a week", key: addDaysToKey(todayKey, 7)! },
  ];
}

// Saati bir adım ileri (+1) ya da geri (-1) alır. Adımın katına oturur: 18:20
// +30 dk -> 18:30, -30 dk -> 18:00; 18:30 +30 dk -> 19:00. Günün dışına taşmaz:
// 00:00'dan geri ya da son adımdan ileri gidilemezse null (düğme kapanır).
// Geçersiz adım varsayılana düşer.
const VALID_STEPS = new Set([1, 5, 10, 15, 30, 60]);
const MINUTES_PER_DAY = 24 * 60;

export function nudgeTime(
  time: string,
  direction: 1 | -1,
  step: number = DEFAULT_TIME_STEP,
): string | null {
  const match = TIME_RE.exec(time);
  if (!match) return null;
  const size = VALID_STEPS.has(step) ? step : DEFAULT_TIME_STEP;
  const total = Number(match[1]) * 60 + Number(match[2]);
  const next =
    direction > 0
      ? (Math.floor(total / size) + 1) * size
      : (Math.ceil(total / size) - 1) * size;
  if (next < 0 || next >= MINUTES_PER_DAY) return null;
  return `${pad2(Math.floor(next / 60))}:${pad2(next % 60)}`;
}
