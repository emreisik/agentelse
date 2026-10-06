import { addDays, monthEnd } from "@/lib/website-analytics/days";
import { isoWeekMonday, weekSunday } from "@/lib/website-analytics/weeks";

import type { NarrativeMode, WebsiteReportVariant } from "./types";

// GA-F5 rapor zamanlaması (docs/website-reports.md "Zamanlama"). Saf
// fonksiyonlar: çalıştırıcı yalnız bunların söylediğini yapar. Yerel
// damgalar ("YYYY-MM-DDTHH:mm") ve ay anahtarları ("YYYY-MM") sözlük sırasıyla
// karşılaştırılır.

export const GA_REPORT_LOCAL_TIME = "08:00";
export const GA_REPORT_LEASE_MS = 3 * 60_000;
export const GA_REPORTS_RUN_EVERY_MS = 5 * 60_000;
// Haftalık rapor, GA-F4'ün haftalık analizini en çok bu kadar bekler.
export const GA_WEEKLY_INSIGHTS_WAIT_HOURS = 24;
// Kaçırılan raporlar bu günden sonra atlanır.
export const GA_WEEKLY_STALE_DAYS = 6;
export const GA_MONTHLY_STALE_DAYS = 10;
export const GA_PLAN_MIN_HISTORY_DAYS = 56;
// Ayın bu gününe kadar plan cari ayı hedefler; sonrasında gelecek ayı.
export const PLAN_CURRENT_MONTH_MAX_DAY = 10;
export const GA_ALERT_LOOKBACK_MS = 48 * 3_600_000;
export const GA_REPORTS_MAX_LLM_PER_TICK = 2;
export const GA_PULSE_INSIGHTS_WAIT_MS = 3 * 3_600_000;
// Bu kadar başarısız denemeden sonra rapor LLM'siz yazılır.
export const GA_REPORT_NARRATIVE_MAX_ATTEMPTS = 2;
// Bu kadar başarısız denemeden sonra dönem atlanır.
export const GA_REPORT_MAX_ATTEMPTS = 5;
const ATTEMPT_KEYS_MAX = 12;

// Projenin yerel saatiyle "YYYY-MM-DDTHH:mm".
export type LocalStamp = string;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// "2026-10-05" → 1 (Pazartesi) … 7 (Pazar).
export function isoWeekdayOf(day: string): number {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

// "2026-12" → "2027-01".
export function nextMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, m ?? 1, 1)).toISOString().slice(0, 7);
}

// "2027-01" → "2026-12".
export function previousMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 1))
    .toISOString()
    .slice(0, 7);
}

export type WeeklyDue = {
  week: { monday: string; sunday: string } | null;
  dueAt: LocalStamp | null;
  state: "done" | "stale" | "wait_data" | "wait_insights" | "due";
  insights: "on" | "pending" | "off";
};

// Haftalık rapor: seçilen hafta gününün 08:00'inden itibaren, bir önceki ISO
// haftası için. Pazar verisi gelene dek bekler; GA-F4 haftalık analizi için
// en çok 24 saat bekler; 6 gün sonra bayatlar.
export function weeklyReportDue(input: {
  localNow: LocalStamp;
  weekday: number;
  completeThrough: string | null;
  lastWeek: string | null;
  insightsOn: boolean;
  insightsWeek: string | null;
}): WeeklyDue {
  const localDate = input.localNow.slice(0, 10);
  const time = input.localNow.slice(11, 16);
  // En yakın geçmiş "rapor günü": bugün ise saat 08:00'i geçmiş olmalı.
  let due = localDate;
  for (let back = 0; back <= 7; back += 1) {
    const candidate = addDays(localDate, -back);
    if (
      isoWeekdayOf(candidate) === input.weekday &&
      (candidate < localDate || time >= GA_REPORT_LOCAL_TIME)
    ) {
      due = candidate;
      break;
    }
  }
  const monday = addDays(isoWeekMonday(due), -7);
  const week = { monday, sunday: weekSunday(monday) };
  const dueAt = `${due}T${GA_REPORT_LOCAL_TIME}`;
  if (input.lastWeek !== null && input.lastWeek >= monday) {
    return { week, dueAt, state: "done", insights: "off" };
  }
  const insights = input.insightsOn ? "pending" : "off";
  if (
    input.localNow >=
    `${addDays(due, GA_WEEKLY_STALE_DAYS)}T${GA_REPORT_LOCAL_TIME}`
  ) {
    return { week, dueAt, state: "stale", insights };
  }
  if (input.completeThrough === null || input.completeThrough < week.sunday) {
    return { week, dueAt, state: "wait_data", insights };
  }
  if (!input.insightsOn) {
    return { week, dueAt, state: "due", insights: "off" };
  }
  if (input.insightsWeek !== null && input.insightsWeek >= monday) {
    return { week, dueAt, state: "due", insights: "on" };
  }
  if (
    input.localNow <
    `${addDays(due, GA_WEEKLY_INSIGHTS_WAIT_HOURS / 24)}T${GA_REPORT_LOCAL_TIME}`
  ) {
    return { week, dueAt, state: "wait_insights", insights: "pending" };
  }
  return { week, dueAt, state: "due", insights: "pending" };
}

export type MonthlyDueState = "done" | "stale" | "wait_data" | "due";
export type MonthlyDue = {
  month: string | null;
  dueAt: LocalStamp | null;
  state: MonthlyDueState;
};

// Aylık rapor: ayın `day`. günü 08:00'den itibaren, bir önceki takvim ayı
// için; ay sonu verisi gelene dek bekler, 10 gün sonra bayatlar.
export function monthlyReportDue(input: {
  localNow: LocalStamp;
  day: number;
  completeThrough: string | null;
  lastMonth: string | null;
}): MonthlyDue {
  const current = input.localNow.slice(0, 7);
  const dueThis = `${current}-${pad2(input.day)}T${GA_REPORT_LOCAL_TIME}`;
  let month: string;
  let dueAt: LocalStamp;
  if (input.localNow >= dueThis) {
    month = previousMonthKey(current);
    dueAt = dueThis;
  } else {
    month = previousMonthKey(previousMonthKey(current));
    dueAt = `${previousMonthKey(current)}-${pad2(input.day)}T${GA_REPORT_LOCAL_TIME}`;
  }
  if (input.lastMonth !== null && input.lastMonth >= month) {
    return { month, dueAt, state: "done" };
  }
  if (
    input.localNow >=
    `${addDays(dueAt.slice(0, 10), GA_MONTHLY_STALE_DAYS)}T${GA_REPORT_LOCAL_TIME}`
  ) {
    return { month, dueAt, state: "stale" };
  }
  if (
    input.completeThrough === null ||
    input.completeThrough < monthEnd(`${month}-01`)
  ) {
    return { month, dueAt, state: "wait_data" };
  }
  return { month, dueAt, state: "due" };
}

export type PlanDue = {
  month: string | null;
  state: "off" | "not_yet" | "done" | "short_history" | "wait_monthly" | "due";
};

// "Gelecek ay planı": aylık raporun günü 08:00'inden önce gönderilmez. Ayın
// 10'una kadar cari ayı, sonra gelecek ayı hedefler; cari ayı hedeflerken
// aylık rapor bitene dek bekler.
export function planDue(input: {
  localNow: LocalStamp;
  day: number;
  enabled: boolean;
  lastPlanMonth: string | null;
  monthlyState: MonthlyDueState | "off";
  historyDays: number;
}): PlanDue {
  if (!input.enabled) return { month: null, state: "off" };
  const current = input.localNow.slice(0, 7);
  if (
    input.localNow < `${current}-${pad2(input.day)}T${GA_REPORT_LOCAL_TIME}`
  ) {
    return { month: current, state: "not_yet" };
  }
  const target =
    Number(input.localNow.slice(8, 10)) <= PLAN_CURRENT_MONTH_MAX_DAY
      ? current
      : nextMonthKey(current);
  if (input.lastPlanMonth !== null && input.lastPlanMonth >= target) {
    return { month: target, state: "done" };
  }
  if (input.historyDays < GA_PLAN_MIN_HISTORY_DAYS) {
    return { month: target, state: "short_history" };
  }
  if (
    target === current &&
    (input.monthlyState === "due" || input.monthlyState === "wait_data")
  ) {
    return { month: target, state: "wait_monthly" };
  }
  return { month: target, state: "due" };
}

export type PulseDue = {
  day: string | null;
  state: "off" | "not_yet" | "done" | "wait_insights" | "due";
};

// Nabız: yeni her completeThrough için bir kez, yalnız completeThrough mülkün
// dünüyken. GA-F4 günlük analizi için ilk görüşten en çok 3 saat bekler.
export function pulseDue(input: {
  propertyToday: string;
  completeThrough: string | null;
  lastPulseDay: string | null;
  mode: "notable" | "off";
  insightsOn: boolean;
  insightsDay: string | null;
  pendingDay: string | null;
  pendingSince: Date | null;
  now: Date;
}): PulseDue {
  if (input.mode === "off") return { day: null, state: "off" };
  const day = input.completeThrough;
  if (day === null || day !== addDays(input.propertyToday, -1)) {
    return { day: null, state: "not_yet" };
  }
  if (input.lastPulseDay === day) return { day, state: "done" };
  const analysisBehind = input.insightsDay === null || input.insightsDay < day;
  const waitOver =
    input.pendingDay === day &&
    input.pendingSince !== null &&
    input.now.getTime() - input.pendingSince.getTime() >=
      GA_PULSE_INSIGHTS_WAIT_MS;
  if (input.insightsOn && analysisBehind && !waitOver) {
    return { day, state: "wait_insights" };
  }
  return { day, state: "due" };
}

// Günlük hedef yenilemesi: yeni her completeThrough için bir kez.
export function goalsDue(input: {
  completeThrough: string | null;
  lastGoalsDay: string | null;
}): boolean {
  return (
    input.completeThrough !== null &&
    input.completeThrough !== input.lastGoalsDay
  );
}

// Başarısız deneme sayacı: `<çeşit>:<dönem>` → sayı.
export type ReportAttempts = Readonly<Record<string, number>>;

export function attemptKey(
  variant: WebsiteReportVariant,
  periodKey: string,
): string {
  return `${variant}:${periodKey}`;
}

// Hoşgörülü okuyucu: nesne olmayan {} olur, tam sayı olmayan sayılar atılır.
export function readAttempts(value: unknown): ReportAttempts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
      out[key] = count;
    }
  }
  return out;
}

export function attemptsOf(attempts: ReportAttempts, key: string): number {
  return attempts[key] ?? 0;
}

// Sayacı bir artırır; anahtar en sona taşınır, en son artırılan 12 anahtar
// kalır (eski dönemler kendiliğinden düşer).
export function bumpAttempt(
  attempts: ReportAttempts,
  key: string,
): Record<string, number> {
  const next = attemptsOf(attempts, key) + 1;
  const entries = Object.entries(attempts).filter(([name]) => name !== key);
  entries.push([key, next]);
  return Object.fromEntries(entries.slice(-ATTEMPT_KEYS_MAX));
}

export function clearAttempt(
  attempts: ReportAttempts,
  key: string,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(attempts).filter(([name]) => name !== key),
  );
}

// Anlatı kipi: tekrarlanan hatada LLM harcaması durur; bütçe bitince
// veri yüklenmeden ertelenir.
export function narrativeModeFor(input: {
  attempts: number;
  llmBudget: number;
}): NarrativeMode {
  if (input.attempts >= GA_REPORT_NARRATIVE_MAX_ATTEMPTS) return "skip";
  if (input.llmBudget <= 0) return "defer";
  return "allow";
}
