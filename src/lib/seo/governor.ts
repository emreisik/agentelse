import { nextQuotaDay } from "@/lib/website-analytics/governor";

import { gscToday } from "./dates";

// Search Console kota yöneticisinin saf kararları
// (docs/google-search-console-plan.md §3.3 "Kota yöneticisi", §5.1). Durum
// GscSiteLink satırındadır ve anahtar siteUrl'dir: aynı kipteki birincil
// bağların hepsine yazılır, böylece aynı site iki projeye bağlıysa da tek
// kova kullanılır.
//
// Kurallar:
// - RATE (dakikalık sınır): en az 60 sn ya da Google'ın Retry-After'ı kadar
//   bekle. DAILY: Pasifik gece yarısına kadar bekle.
// - LOAD (Search Analytics "load" kotası): PT gününün ilk hatası her şeyi
//   15 dk durdurur; ikinci ve sonrakiler ayrıca ağır istekleri (sorgu×sayfa,
//   90 günden uzun aralık) PT gece yarısına kadar durdurur.
// - Öncelik: RATE > LOAD > HEAVY.
// Dakikada 30 istek ve 2 eşzamanlı istek süreç içinde tutulur (Google sınırı
// site başına dakikada 1.200).

export const GSC_REQUESTS_PER_MINUTE = 30;
export const GSC_MAX_CONCURRENT = 2;
export const GSC_LOAD_SHORT_WAIT_MS = 15 * 60_000;
export const GSC_RATE_WAIT_MS = 60_000;

export type GscQuotaKind = "RATE" | "LOAD" | "DAILY";

export type GscLoadErrors = { day: string; count: number };

export type GscQuotaState = {
  rateLimitedUntil: Date | null;
  loadLimitedUntil: Date | null;
  heavyLimitedUntil: Date | null;
  loadErrors: GscLoadErrors | null;
};

export type GscQuotaDecision =
  | { ok: true }
  | { ok: false; reason: "RATE" | "LOAD" | "HEAVY"; retryAt: Date };

function active(until: Date | null, now: Date): until is Date {
  return until !== null && until.getTime() > now.getTime();
}

function later(a: Date | null, b: Date): Date {
  return a && a.getTime() > b.getTime() ? a : b;
}

export function gscQuotaDecision(input: {
  heavy: boolean;
  now: Date;
  state: GscQuotaState;
}): GscQuotaDecision {
  const { heavy, now, state } = input;
  if (active(state.rateLimitedUntil, now)) {
    return { ok: false, reason: "RATE", retryAt: state.rateLimitedUntil };
  }
  if (active(state.loadLimitedUntil, now)) {
    return { ok: false, reason: "LOAD", retryAt: state.loadLimitedUntil };
  }
  if (heavy && active(state.heavyLimitedUntil, now)) {
    return { ok: false, reason: "HEAVY", retryAt: state.heavyLimitedUntil };
  }
  return { ok: true };
}

// Ağır istekler bugün (PT) durduruldu mu? Haftalık sorgu×sayfa bunu önceden
// sorar ve engelliyse işi ağır kuyruğa koyar.
export function heavyBlocked(state: GscQuotaState, now: Date): boolean {
  return active(state.heavyLimitedUntil, now);
}

// Bir kota hatasını duruma işler. Var olan daha uzun bekletme kısaltılmaz
// (ör. DAILY'den sonra gelen RATE gece yarısı bekletmesini silmez).
export function applyQuotaError(input: {
  kind: GscQuotaKind;
  state: GscQuotaState;
  now: Date;
  retryAfterMs?: number;
}): GscQuotaState {
  const { kind, state, now } = input;
  if (kind === "RATE") {
    const wait = Math.max(GSC_RATE_WAIT_MS, input.retryAfterMs ?? 0);
    return {
      ...state,
      rateLimitedUntil: later(
        state.rateLimitedUntil,
        new Date(now.getTime() + wait),
      ),
    };
  }
  if (kind === "DAILY") {
    return {
      ...state,
      rateLimitedUntil: later(state.rateLimitedUntil, nextPacificMidnight(now)),
    };
  }
  const day = gscToday(now);
  const count =
    state.loadErrors && state.loadErrors.day === day
      ? state.loadErrors.count + 1
      : 1;
  return {
    ...state,
    loadErrors: { day, count },
    loadLimitedUntil: later(
      state.loadLimitedUntil,
      new Date(now.getTime() + GSC_LOAD_SHORT_WAIT_MS),
    ),
    heavyLimitedUntil:
      count >= 2
        ? later(state.heavyLimitedUntil, nextPacificMidnight(now))
        : state.heavyLimitedUntil,
  };
}

// Bir sonraki Pasifik gece yarısı (GA kota yöneticisiyle ortak hesap).
export function nextPacificMidnight(now: Date): Date {
  return nextQuotaDay(now);
}

// GscSiteLink.loadErrors Json kolonu; tanınmayan biçim null.
export function parseLoadErrors(value: unknown): GscLoadErrors | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { day, count } = value as { day?: unknown; count?: unknown };
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return null;
  }
  return { day, count };
}

export function quotaStateOf(link: {
  rateLimitedUntil: Date | null;
  loadLimitedUntil: Date | null;
  heavyLimitedUntil: Date | null;
  loadErrors: unknown;
}): GscQuotaState {
  return {
    rateLimitedUntil: link.rateLimitedUntil,
    loadLimitedUntil: link.loadLimitedUntil,
    heavyLimitedUntil: link.heavyLimitedUntil,
    loadErrors: parseLoadErrors(link.loadErrors),
  };
}

export type MinuteLimiter = {
  take(
    key: string,
    nowMs: number,
  ): { ok: true } | { ok: false; retryAt: number };
};

// Kayan pencereli dakika sınırı (anahtar: siteUrl). Süreç içidir; birden çok
// işçide hedef kısa süre aşılabilir ama Google sınırının çok altında kalır.
export function createMinuteLimiter(
  limit: number = GSC_REQUESTS_PER_MINUTE,
  windowMs: number = 60_000,
): MinuteLimiter {
  const taken = new Map<string, number[]>();
  return {
    take(key, nowMs) {
      const recent = (taken.get(key) ?? []).filter(
        (at) => nowMs - at < windowMs,
      );
      if (recent.length >= limit) {
        taken.set(key, recent);
        return { ok: false, retryAt: Math.min(...recent) + windowMs };
      }
      recent.push(nowMs);
      taken.set(key, recent);
      return { ok: true };
    },
  };
}
