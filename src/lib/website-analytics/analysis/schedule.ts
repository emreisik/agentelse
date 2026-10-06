import {
  addDays,
  monthEnd,
  previousMonthStart,
  safeTimezone,
} from "@/lib/website-analytics/days";
import { isoWeekMonday, weekSunday } from "@/lib/website-analytics/weeks";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";

import type { GaRange } from "./types";

// GA-F4 zamanlaması (docs/google-analytics-plan.md §5 "İşler, zamanlama",
// §6.3; ayrıntı docs/website-insights.md "İşler"). Saf fonksiyonlar: runner
// ve değerlendirici yalnız bunların söylediğini yapar. Haftalık tur mülk saat
// diliminde (completeThrough ile aynı saat) Pazartesi 06:30'dan sonra ve
// Pazar verisi gelince koşar; kaçan haftalar atlanır.

export const GA_ANALYZE_LEASE_MS = 3 * 60_000;
export const GA_WEEKLY_LOCAL_TIME = "06:30";
// Değerlendirme (plan §6.3): "Mark done"dan sonraki 7 gün hariç, önce/sonra
// 28'er gün; en erken doneAt + 36 gün, veri azsa 14 gün daha beklenir.
export const GA_DONE_EXCLUDE_DAYS = 7;
export const GA_EVAL_WINDOW_DAYS = 28;
export const GA_EVALUATE_AFTER_DAYS = 36;
export const GA_EVAL_GRACE_DAYS = 14;
export const GA_ACCEPTED_EXPIRE_DAYS = 60;
export const GA_DISMISS_SUPPRESS_DAYS = 56;
export const GA_FINDING_RETENTION_DAYS = 730;
export const GA_FINDING_HARD_RETENTION_DAYS = 760;
export const GA_MAX_NEW_FINDINGS_PER_RUN = 20;
export const GA_MAX_LIVE_OPPORTUNITIES_PER_WEEK = 3;
export const GA_AN1_REEVALUATE_DAYS = 3;
export const GA_MIN_WINDOW_DAYS = 21;

// Günlük tur hedefleri: son üç tam gün (ön veriler yeniden değerlendirilir);
// completeThrough yoksa ya da zaten bakıldıysa boş.
export function dailyTargets(input: {
  completeThrough: string | null;
  lastDailyDay: string | null;
}): string[] {
  const { completeThrough, lastDailyDay } = input;
  if (completeThrough === null || completeThrough === lastDailyDay) return [];
  const targets: string[] = [];
  for (let offset = GA_AN1_REEVALUATE_DAYS - 1; offset >= 0; offset--) {
    targets.push(addDays(completeThrough, -offset));
  }
  return targets;
}

// Önceki ISO hafta (mülk saatine göre); yerel saat o haftanın ertesi
// Pazartesi 06:30'unu geçtiyse ve completeThrough Pazar'a ulaştıysa.
export function weeklyTargetWeek(input: {
  now: Date;
  timeZone: string;
  completeThrough: string | null;
}): { monday: string; sunday: string } | null {
  if (input.completeThrough === null) return null;
  const local = utcToZonedDateTimeLocal(
    input.now,
    safeTimezone(input.timeZone),
  );
  const localDay = local.slice(0, 10);
  const localTime = local.slice(11, 16);
  const nextMonday = isoWeekMonday(localDay);
  const monday = addDays(nextMonday, -7);
  const sunday = weekSunday(monday);
  const timeReached =
    localDay > nextMonday ||
    (localDay === nextMonday && localTime >= GA_WEEKLY_LOCAL_TIME);
  if (!timeReached || input.completeThrough < sunday) return null;
  return { monday, sunday };
}

export function weeklyDue(input: {
  week: { monday: string } | null;
  lastWeek: string | null;
}): boolean {
  if (input.week === null) return false;
  return input.lastWeek === null || input.week.monday > input.lastWeek;
}

// completeThrough'ya kadar tamamen dolmuş son takvim ayı ("YYYY-MM"); son
// bakılan ayla aynıysa null.
export function monthRunFor(input: {
  completeThrough: string | null;
  lastMonth: string | null;
}): string | null {
  const { completeThrough, lastMonth } = input;
  if (completeThrough === null) return null;
  const month =
    completeThrough === monthEnd(completeThrough)
      ? completeThrough.slice(0, 7)
      : previousMonthStart(completeThrough).slice(0, 7);
  return month === lastMonth ? null : month;
}

// Önce [d−28, d−1], sonra [d+7, d+34] (mülk günleri).
export function evaluationWindows(doneDay: string): {
  before: GaRange;
  after: GaRange;
} {
  return {
    before: {
      from: addDays(doneDay, -GA_EVAL_WINDOW_DAYS),
      to: addDays(doneDay, -1),
    },
    after: {
      from: addDays(doneDay, GA_DONE_EXCLUDE_DAYS),
      to: addDays(doneDay, GA_DONE_EXCLUDE_DAYS + GA_EVAL_WINDOW_DAYS - 1),
    },
  };
}
