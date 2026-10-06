import type { GaRunReportRequest } from "./catalog";
import { metricOf, type GaParsedReport } from "./response";

// Website sayfasının canlı sayıları (docs/google-analytics-plan.md §3.9,
// GA-F2 bölüm 2, GA_LIVE): "Today so far" mülk saatinde bugünün kısmi
// toplamları, "Right now" son 30 dakikanın aktif kullanıcıları. İkisi de
// yalnız süreç belleğinde tutulur, veritabanına yazılmaz. Saf ve izomorfik
// modül: istemci bileşeni de tipleri buradan alır.

// Bugünün toplamı bağ başına en çok 2 saat bellekte kalır.
export const GA_TODAY_TTL_MS = 2 * 3_600_000;
// Realtime mülk başına dakikada en çok bir istek.
export const GA_REALTIME_TTL_MS = 60_000;
// Realtime 429'u: mülk 15 dakika denenmez (çekirdek kotadan ayrı).
export const GA_REALTIME_BACKOFF_MS = 15 * 60_000;

export type GaTodaySoFar = {
  // Mülk saatinde bugün (YYYY-MM-DD).
  day: string;
  // Sayının okunduğu an (ISO).
  asOf: string;
  timeZone: string;
  sessions: number;
  activeUsers: number;
  newUsers: number;
  keyEvents: number;
  screenPageViews: number;
};

export type GaRightNow = { activeUsers: number; asOf: string };

export type GaLiveUnavailable = {
  ok: false;
  reason: "off" | "not_connected" | "reconnect" | "quota" | "busy" | "error";
};

export type GaTodayResult =
  { ok: true; today: GaTodaySoFar; cached: boolean } | GaLiveUnavailable;

export type GaRightNowResult =
  { ok: true; now: GaRightNow; cached: boolean } | GaLiveUnavailable;

const TODAY_METRICS = [
  "sessions",
  "activeUsers",
  "newUsers",
  "keyEvents",
  "screenPageViews",
] as const;

// Tek gün, boyutsuz: Google tek satır döner. Gün boşsa da satır gelsin diye
// keepEmptyRows açık.
export function todaySoFarRequest(today: string): GaRunReportRequest {
  return {
    dateRanges: [{ startDate: today, endDate: today }],
    metrics: TODAY_METRICS.map((name) => ({ name })),
    keepEmptyRows: true,
    returnPropertyQuota: true,
  };
}

// İlk satırın metrikleri başlık adıyla; satır yoksa sıfırlar (gece yarısından
// hemen sonra "Partial" sıfır gösterir).
export function parseTodaySoFar(
  report: GaParsedReport,
  input: { day: string; asOf: string; timeZone: string },
): GaTodaySoFar {
  const row = report.rows[0];
  const metric = (name: (typeof TODAY_METRICS)[number]) =>
    row ? metricOf(report, row, name) : 0;
  return {
    day: input.day,
    asOf: input.asOf,
    timeZone: input.timeZone,
    sessions: metric("sessions"),
    activeUsers: metric("activeUsers"),
    newUsers: metric("newUsers"),
    keyEvents: metric("keyEvents"),
    screenPageViews: metric("screenPageViews"),
  };
}

// Önbellek kaydı hâlâ taze mi: `at`tan bu yana ttlMs dolmadıysa (sınır
// dahil değil). Kayıt yoksa ya da saat geri gittiyse taze değil.
export function cacheFresh(
  at: number | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (at === undefined) return false;
  const age = now - at;
  return age >= 0 && age < ttlMs;
}
