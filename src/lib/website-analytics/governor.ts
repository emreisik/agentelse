import { dayKeyInTimezone } from "@/lib/timezone";

import type { GaPropertyQuota, GaQuotaStatus } from "./response";

// GA Data API kota yöneticisinin saf kararları (docs/google-analytics-plan.md
// §3.3 "Kota yöneticisi", §5.1). Durum GaPropertyLink satırındadır (son
// `propertyQuota`, blok süresi, saatlik sunucu hatası sayacı); anahtar GA
// mülküdür: aynı mülk iki projeye bağlıysa da tek kova kullanılır.
//
// Şeritler: P1 kullanıcının beklediği okuma (Refresh, sohbet), P2 arka plan
// senkronu, P2_BACKFILL geri doldurma (saatlik payın yarısından fazlasını
// kullanmaz).

export type GaLane = "P1" | "P2" | "P2_BACKFILL";

export type StoredGaQuota = { at: string; quota: GaPropertyQuota };

export type GaServerErrors = { hour: string; count: number };

// Google sınırı mülk başına saatte 10 sunucu hatası; aşılırsa proje↔mülk
// çifti bloklanır. Arka plan işi 3 hatada durur.
export const GA_SERVER_ERRORS_PER_HOUR = 3;
// Mülk başına eşzamanlı istek (Google sınırı 10).
export const GA_MAX_CONCURRENT = 2;

const HOURLY_FLOOR: Record<GaLane, number> = {
  P1: 0.05,
  P2: 0.2,
  P2_BACKFILL: 0.5,
};
const DAILY_FLOOR: Record<GaLane, number> = {
  P1: 0.05,
  P2: 0.1,
  P2_BACKFILL: 0.1,
};

const HOUR_MS = 3_600_000;
// Günlük kotalar Pasifik saatiyle gece yarısı sıfırlanır.
const QUOTA_TIMEZONE = "America/Los_Angeles";

function remainingShare(status: GaQuotaStatus | undefined): number | null {
  if (!status) return null;
  const total = status.consumed + status.remaining;
  return total > 0 ? status.remaining / total : null;
}

// Bir sonraki Pasifik gece yarısı (yaklaşık: saat başına yuvarlanmış).
export function nextQuotaDay(now: Date): Date {
  const today = dayKeyInTimezone(now, QUOTA_TIMEZONE);
  let probe = new Date(now.getTime());
  for (let i = 0; i < 26; i += 1) {
    probe = new Date(probe.getTime() + HOUR_MS);
    if (dayKeyInTimezone(probe, QUOTA_TIMEZONE) !== today) {
      return new Date(Math.floor(probe.getTime() / HOUR_MS) * HOUR_MS);
    }
  }
  return new Date(now.getTime() + 24 * HOUR_MS);
}

export type GaQuotaDecision =
  | { ok: true }
  | { ok: false; reason: "BLOCKED" | "HOURLY" | "DAILY"; retryAt: Date };

export function gaQuotaDecision(input: {
  lane: GaLane;
  now: Date;
  stored: StoredGaQuota | null;
  rateLimitedUntil: Date | null;
}): GaQuotaDecision {
  const { lane, now, stored } = input;
  if (input.rateLimitedUntil && input.rateLimitedUntil > now) {
    return { ok: false, reason: "BLOCKED", retryAt: input.rateLimitedUntil };
  }
  if (!stored) return { ok: true };
  const at = new Date(stored.at);
  if (Number.isNaN(at.getTime())) return { ok: true };

  // Günlük pay: son okuma bugünün (Pasifik) kotasına aitse geçerli.
  if (
    dayKeyInTimezone(at, QUOTA_TIMEZONE) ===
    dayKeyInTimezone(now, QUOTA_TIMEZONE)
  ) {
    const daily = remainingShare(stored.quota.tokensPerDay);
    if (daily !== null && daily < DAILY_FLOOR[lane]) {
      return { ok: false, reason: "DAILY", retryAt: nextQuotaDay(now) };
    }
  }
  // Saatlik pay: son bir saatteki okuma geçerli.
  if (now.getTime() - at.getTime() < HOUR_MS) {
    const shares = [
      remainingShare(stored.quota.tokensPerHour),
      remainingShare(stored.quota.tokensPerProjectPerHour),
    ].filter((share): share is number => share !== null);
    if (shares.length > 0 && Math.min(...shares) < HOURLY_FLOOR[lane]) {
      return {
        ok: false,
        reason: "HOURLY",
        retryAt: new Date(at.getTime() + HOUR_MS),
      };
    }
  }
  return { ok: true };
}

function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

// Bu saatteki sunucu hatası sayısı (başka saate aitse 0).
export function serverErrorsThisHour(
  record: GaServerErrors | null,
  now: Date,
): number {
  return record && record.hour === hourKey(now) ? record.count : 0;
}

export function countServerError(
  record: GaServerErrors | null,
  now: Date,
): GaServerErrors {
  return { hour: hourKey(now), count: serverErrorsThisHour(record, now) + 1 };
}

// Arka plan işi bu saat sunucu hatası sınırına ulaştıysa durur (P1 sürer).
export function serverErrorBudgetSpent(
  record: GaServerErrors | null,
  lane: GaLane,
  now: Date,
): boolean {
  return (
    lane !== "P1" &&
    serverErrorsThisHour(record, now) >= GA_SERVER_ERRORS_PER_HOUR
  );
}

// Bir sonraki saat başı (sunucu hatası sınırı dolunca bekleme).
export function nextHour(now: Date): Date {
  return new Date((Math.floor(now.getTime() / HOUR_MS) + 1) * HOUR_MS);
}
