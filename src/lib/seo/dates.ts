import { dayKeyInTimezone } from "@/lib/timezone";
import {
  addDays,
  hourInTimezone,
  monthEnd,
  monthStart,
} from "@/lib/website-analytics/days";

// Search Console gün anahtarları (docs/google-search-console-plan.md §3.3).
// Search Analytics'in `date` boyutu Pasifik saatiyle (PT) gündür ve
// "YYYY-MM-DD" olarak taşınır; takvim aritmetiği bu anahtarın UTC takvimi
// üzerinde yapılır. Haftalar ISO Pazartesi–Pazar, aylar takvim ayıdır.
// Google geçmişi 16 ay tutar (pencerenin tam başlangıcı doğrulanmalı).

export {
  addDays,
  dayKeyToDate,
  dateToDayKey,
  daysInRange,
  monthStart,
  monthEnd,
} from "@/lib/website-analytics/days";

export const GSC_TIMEZONE = "America/Los_Angeles";
export const GSC_GOOGLE_WINDOW_MONTHS = 16;

// Şu anın PT günü.
export function gscToday(now: Date): string {
  return dayKeyInTimezone(now, GSC_TIMEZONE);
}

// Şu anın PT saati (0-23).
export function gscHour(now: Date): number {
  return hourInTimezone(now, GSC_TIMEZONE);
}

// [start, end] aralığının günleri (iki uç dahil); ters aralıkta boş.
export function dayRange(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

// Günün haftasının Pazartesi'si (gün Pazartesi ise kendisi).
export function weekStartOf(day: string): string {
  return addDays(day, -((weekday(day) + 6) % 7));
}

// Haftanın Pazar'ı.
export function weekEndOf(weekStart: string): string {
  return addDays(weekStart, 6);
}

export function addWeeks(weekStart: string, weeks: number): string {
  return addDays(weekStart, weeks * 7);
}

// "2026-10-01" + 1 → "2026-11-01"; girdi ve çıktı ayın ilk günüdür.
export function addMonths(monthStartKey: string, months: number): string {
  const [y, m] = monthStartKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + months, 1)).toISOString().slice(0, 10);
}

// Ay kaydırma; gün hedef ayın uzunluğuna kırpılır ("2026-03-31", -1 →
// "2026-02-28").
export function shiftMonthsClamped(day: string, months: number): string {
  const target = addMonths(monthStart(day), months);
  const last = Number(monthEnd(target).slice(8, 10));
  const clamped = Math.min(Number(day.slice(8, 10)), last);
  return `${target.slice(0, 8)}${String(clamped).padStart(2, "0")}`;
}

// Google'ın tuttuğu en eski gün (yaklaşık; çağıran istekte yeniden kırpar).
export function googleWindowStart(today: string): string {
  return shiftMonthsClamped(today, -GSC_GOOGLE_WINDOW_MONTHS);
}

// Pazar'ı finalThrough'dan sonra olmayan en son tam haftanın Pazartesi'si.
export function lastCompleteWeekStart(finalThrough: string): string {
  const start = weekStartOf(finalThrough);
  return weekday(finalThrough) === 0 ? start : addDays(start, -7);
}

// Son günü finalThrough'dan sonra olmayan en son tam ayın ilk günü.
export function lastCompleteMonthStart(finalThrough: string): string {
  const start = monthStart(finalThrough);
  return finalThrough === monthEnd(finalThrough) ? start : addMonths(start, -1);
}

// Gün Pazartesi ise kendisi, değilse sonraki Pazartesi.
export function firstWeekStartOnOrAfter(day: string): string {
  const start = weekStartOf(day);
  return start === day ? day : addDays(start, 7);
}

// Gün ayın ilk günüyse kendisi, değilse sonraki ayın ilk günü.
export function firstMonthStartOnOrAfter(day: string): string {
  const start = monthStart(day);
  return start === day ? day : addMonths(start, 1);
}

function present(days: (string | null | undefined)[]): string[] {
  return days.filter((day): day is string => typeof day === "string");
}

// En geç gün; null/undefined atlanır, hiç gün yoksa null.
export function maxDay(...days: (string | null | undefined)[]): string | null {
  const list = present(days);
  return list.length === 0
    ? null
    : list.reduce((best, day) => (day > best ? day : best));
}

// En erken gün; null/undefined atlanır, hiç gün yoksa null.
export function minDay(...days: (string | null | undefined)[]): string | null {
  const list = present(days);
  return list.length === 0
    ? null
    : list.reduce((best, day) => (day < best ? day : best));
}
