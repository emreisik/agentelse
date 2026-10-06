import {
  addDays,
  addMonths,
  lastCompleteMonthStart,
  lastCompleteWeekStart,
} from "@/lib/seo/dates";
import { utcToZonedDateTimeLocal, zonedDateTimeToUtc } from "@/lib/timezone";

// SEO rapor zamanlaması (docs/search-reports.md "Zamanlama"). Saf
// fonksiyonlar: çalıştırıcı yalnız bunların söylediğini yapar. Gün anahtarları
// dize olarak karşılaştırılır; "şimdi" projenin yerel saatiyle
// `${yerelGün}T${HH:mm}` damgasıdır ve her karşılaştırma bu damgada sözlük
// sırasıyladır (Çarşamba 09:00'dan sonraki Perşembe 08:00 "due"dur, "wait"
// değil).

export const REPORT_TIME = "09:00";
// Haftalık rapor, haftayı izleyen Çarşamba (Pazartesi + 9) 09:00'dan itibaren.
export const WEEKLY_DAY_OFFSET = 9;
// SC-F4 motoru geride kalırsa en çok Perşembe 09:00'a kadar beklenir.
export const WEEKLY_ENGINE_WAIT_OFFSET = 10;
export const WEEKLY_STALE_DAYS = 20;
// Aylık rapor, ayı izleyen ayın 4'ünden itibaren.
export const MONTHLY_DAY = 4;
export const MONTHLY_STALE_DAYS = 27;
export const PULSE_STALE_DAYS = 4;
export const ENGINE_RECHECK_MS = 3_600_000;

const BACKOFF_BASE_MS = 600_000;
const BACKOFF_CAP_MS = 21_600_000;

function stamp(day: string): string {
  return `${day}T${REPORT_TIME}`;
}

function localOf(input: { localDay: string; localTime: string }): string {
  return `${input.localDay}T${input.localTime}`;
}

// Raporu yazılacak hafta (Pazartesi): son tam hafta; bağın haftalık özetleri
// o haftaya kadar çekilmemişse ya da hafta zaten yazılmışsa null.
export function weeklyCandidate(input: {
  finalThrough: string;
  lastWeeklyWeek: string | null;
  doneWeek: string | null;
}): string | null {
  const week = lastCompleteWeekStart(input.finalThrough);
  if ((input.lastWeeklyWeek ?? "") < week) return null;
  if ((input.doneWeek ?? "") >= week) return null;
  return week;
}

export function weeklyDue(input: {
  week: string;
  localDay: string;
  localTime: string;
  engineWaits: boolean;
  engineWeek: string | null;
}): "due" | "wait" | "stale" {
  if (input.week < addDays(input.localDay, -WEEKLY_STALE_DAYS)) return "stale";
  const local = localOf(input);
  if (local < stamp(addDays(input.week, WEEKLY_DAY_OFFSET))) return "wait";
  if (
    input.engineWaits &&
    (input.engineWeek ?? "") < input.week &&
    local < stamp(addDays(input.week, WEEKLY_ENGINE_WAIT_OFFSET))
  ) {
    return "wait";
  }
  return "due";
}

// "wait" yanıtının değişebileceği ilk an: Çarşamba 09:00'dan önce o an;
// sonrasında (motor geride) bir saat sonra, en geç Perşembe 09:00.
export function weeklyWaitUntil(input: {
  week: string;
  timezone: string;
  now: Date;
  engineLagging: boolean;
}): Date {
  const due = stamp(addDays(input.week, WEEKLY_DAY_OFFSET));
  if (utcToZonedDateTimeLocal(input.now, input.timezone) < due) {
    return zonedDateTimeToUtc(due, input.timezone);
  }
  if (!input.engineLagging) return input.now;
  const cap = zonedDateTimeToUtc(
    stamp(addDays(input.week, WEEKLY_ENGINE_WAIT_OFFSET)),
    input.timezone,
  );
  const recheck = new Date(input.now.getTime() + ENGINE_RECHECK_MS);
  return recheck < cap ? recheck : cap;
}

export function monthlyCandidate(input: {
  finalThrough: string;
  lastMonthlyMonth: string | null;
  doneMonth: string | null;
}): string | null {
  const month = lastCompleteMonthStart(input.finalThrough);
  if ((input.lastMonthlyMonth ?? "") < month) return null;
  if ((input.doneMonth ?? "") >= month) return null;
  return month;
}

// Ayı izleyen ayın MONTHLY_DAY'i (ayın ilk günü + 3).
function monthlyDueDay(month: string): string {
  return addDays(addMonths(month, 1), MONTHLY_DAY - 1);
}

export function monthlyDue(input: {
  month: string;
  localDay: string;
  localTime: string;
}): "due" | "wait" | "stale" {
  const staleAfter = addDays(addMonths(input.month, 1), MONTHLY_STALE_DAYS - 1);
  if (input.localDay > staleAfter) return "stale";
  if (localOf(input) < stamp(monthlyDueDay(input.month))) return "wait";
  return "due";
}

export function monthlyWaitUntil(input: {
  month: string;
  timezone: string;
}): Date {
  return zonedDateTimeToUtc(stamp(monthlyDueDay(input.month)), input.timezone);
}

// Nabız: kesinleşen en yeni gün, dört günden eski değilse ve daha önce
// bakılmadıysa.
export function pulseCandidate(input: {
  finalThrough: string;
  donePulse: string | null;
  today: string;
}): string | null {
  if ((input.donePulse ?? "") >= input.finalThrough) return null;
  if (input.finalThrough < addDays(input.today, -PULSE_STALE_DAYS)) return null;
  return input.finalThrough;
}

// Hedef değerleri, kesinleşen gün ilerledikçe bir kez yenilenir.
export function goalsDue(input: {
  finalThrough: string;
  doneGoalsDay: string | null;
}): boolean {
  return input.finalThrough > (input.doneGoalsDay ?? "");
}

// Çalıştırıcının ön kontrolü: bu dönem için kaydedilmiş bekleme sürüyor mu.
export function waitingFor(
  period: string,
  waitPeriod: string | null,
  waitUntil: Date | null,
  now: Date,
): boolean {
  return waitPeriod === period && waitUntil !== null && now < waitUntil;
}

// Ardışık başarısızlıkta bekleme: 10 dk, 20 dk, ... en çok 6 saat.
export function reportBackoffMs(failures: number): number {
  if (!(failures > 0)) return 0;
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
}
