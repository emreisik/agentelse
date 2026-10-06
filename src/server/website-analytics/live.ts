import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { gaDisabledReports } from "@/lib/website-analytics/catalog-state";
import { safeTimezone } from "@/lib/website-analytics/days";
import { GaFlags, gaSyncAllowedFor } from "@/lib/website-analytics/flags";
import type {
  GaServerErrors,
  StoredGaQuota,
} from "@/lib/website-analytics/governor";
import {
  GA_REALTIME_BACKOFF_MS,
  GA_REALTIME_TTL_MS,
  GA_TODAY_TTL_MS,
  cacheFresh,
  parseTodaySoFar,
  todaySoFarRequest,
  type GaLiveUnavailable,
  type GaRightNow,
  type GaRightNowResult,
  type GaTodayResult,
  type GaTodaySoFar,
} from "@/lib/website-analytics/live";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import { runGaRealtimeActiveUsers } from "@/server/integrations/google-analytics/realtime";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";

import { flushGaApiCounters } from "./api-counters";
import { primaryGaLink } from "./store";
import type { GaSyncContext } from "./sync/context";
import {
  GaQuotaDeferred,
  runGaRequests,
  type GaRequestOutcome,
} from "./sync/requests";

// Website sayfasının canlı sayıları (GA-F2 bölüm 2, GA_LIVE). Hiçbiri
// veritabanına yazılmaz; yalnız süreç belleğinde tutulur:
// - "Today so far": bağ başına en çok 2 saat; P1 şeridinde tek runReport,
//   çekirdek kota yöneticisinin altında.
// - "Right now": mülk ve bağlantı başına 60 saniye. Aynı mülke bağlı iki
//   proje kaydı paylaşmaz: her proje kendi Google yetkisiyle okur (bir
//   kullanıcının yetkisiyle gelen veri başka kiracıya gösterilmez). Realtime
//   kotası ayrı olduğundan kota yöneticisine girmez; 429'da mülk başına
//   kendi 15 dakikalık beklemesi var (kota mülkündür, veri taşımaz),
//   rateLimitedUntil'e dokunmaz.
// Aynı anda gelen istekler tek Google çağrısını paylaşır. Proje için
// not_connected ya da reconnect dönünce o projenin kayıtları hemen silinir.

const STOPPED_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

type TodayEntry = { at: number; projectId: string; value: GaTodaySoFar };
type RealtimeEntry = { at: number; projectId: string; value: GaRightNow };
type Computed<T> = { ok: true; value: T } | GaLiveUnavailable;

// linkId → bugünün toplamı.
const todayCache = new Map<string, TodayEntry>();
const todayInFlight = new Map<string, Promise<Computed<GaTodaySoFar>>>();
// "propertyId|credentialId" → son 30 dakika.
const realtimeCache = new Map<string, RealtimeEntry>();
const realtimeInFlight = new Map<string, Promise<Computed<GaRightNow>>>();
// propertyId → bu zamana kadar realtime denenmez (ms).
const realtimeBackoff = new Map<string, number>();

function unavailable(reason: GaLiveUnavailable["reason"]): GaLiveUnavailable {
  return { ok: false, reason };
}

// Süresi dolan kayıtlar her çağrıda atılır.
function sweep(now: number): void {
  for (const [key, entry] of todayCache) {
    if (!cacheFresh(entry.at, now, GA_TODAY_TTL_MS)) todayCache.delete(key);
  }
  for (const [key, entry] of realtimeCache) {
    if (!cacheFresh(entry.at, now, GA_REALTIME_TTL_MS)) {
      realtimeCache.delete(key);
    }
  }
  for (const [key, until] of realtimeBackoff) {
    if (until <= now) realtimeBackoff.delete(key);
  }
}

// Bağlantısı kopan ya da yeniden bağlanması gereken projenin kayıtları.
function purgeProject(projectId: string): void {
  for (const [key, entry] of todayCache) {
    if (entry.projectId === projectId) todayCache.delete(key);
  }
  for (const [key, entry] of realtimeCache) {
    if (entry.projectId === projectId) realtimeCache.delete(key);
  }
}

type CredentialRow = { id: string; status: string; encryptedSecret: string };
type Resolved =
  | { ok: true; link: GaPropertyLink; credential: CredentialRow }
  | GaLiveUnavailable;

// Bayraklar, geliştirme izin listesi, bağ ve kimlik. Bağ yoksa ya da
// kullanıcı yeniden bağlanmalıysa projenin önbelleği silinir.
async function resolveLink(projectId: string): Promise<Resolved> {
  if (
    !GaFlags.sync() ||
    !GaFlags.websitePage() ||
    !GaFlags.live() ||
    !gaSyncAllowedFor(projectId)
  ) {
    return unavailable("off");
  }
  const link = await primaryGaLink(projectId);
  if (!link) {
    purgeProject(projectId);
    return unavailable("not_connected");
  }
  if (STOPPED_HEALTH.has(link.health)) {
    purgeProject(projectId);
    return unavailable("reconnect");
  }
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: link.credentialId },
    select: { id: true, status: true, encryptedSecret: true },
  });
  if (!credential || credential.status !== "ACTIVE") {
    purgeProject(projectId);
    return unavailable("reconnect");
  }
  return { ok: true, link, credential };
}

async function accessToken(credential: CredentialRow): Promise<string> {
  return gaMockMode()
    ? "mock-access-token"
    : getFreshGoogleAccessToken(credential);
}

function afterGoogleCall(): void {
  void flushGaApiCounters().catch(() => {});
}

function googleClass(error: unknown): string {
  return error instanceof GoogleApiError ? error.errorClass : "UNKNOWN";
}

// Ortak hata eşlemesi; sayı loglanmaz.
function mapError(part: string, error: unknown): GaLiveUnavailable {
  if (error instanceof GaQuotaDeferred) {
    return unavailable(error.reason === "CONCURRENCY" ? "busy" : "quota");
  }
  if (error instanceof GoogleApiError) {
    switch (error.errorClass) {
      case "AUTH":
      case "SCOPE_MISSING":
      case "PERMISSION":
        return unavailable("reconnect");
      case "RATE_LIMIT":
      case "QUOTA_DAILY":
        return unavailable("quota");
    }
  }
  console.warn(`[ga-live] ${part} could not be read (${googleClass(error)})`);
  return unavailable("error");
}

async function fetchToday(
  link: GaPropertyLink,
  credential: CredentialRow,
  now: Date,
  timeZone: string,
  today: string,
): Promise<Computed<GaTodaySoFar>> {
  try {
    const ctx: GaSyncContext = {
      link,
      accessToken: await accessToken(credential),
      timeZone,
      today,
      now,
      lane: "P1",
      disabled: gaDisabledReports(link.catalog),
      quota: (link.lastQuota ?? null) as StoredGaQuota | null,
      serverErrors: (link.serverErrorsHour ?? null) as GaServerErrors | null,
      rateLimitedUntil: link.rateLimitedUntil,
    };
    let outcome: GaRequestOutcome | undefined;
    try {
      [outcome] = await runGaRequests(ctx, [todaySoFarRequest(today)], "P1");
    } finally {
      afterGoogleCall();
    }
    if (!outcome) return mapError("today so far", null);
    // Geçersiz istek (400) hata olarak döner, atılmaz.
    if (!outcome.ok) return mapError("today so far", outcome.error);
    const value = parseTodaySoFar(outcome.report, {
      day: today,
      asOf: now.toISOString(),
      timeZone,
    });
    todayCache.set(link.id, {
      at: now.getTime(),
      projectId: link.projectId,
      value,
    });
    return { ok: true, value };
  } catch (error) {
    return mapError("today so far", error);
  }
}

async function fetchRealtime(
  key: string,
  propertyId: string,
  credential: CredentialRow,
  projectId: string,
  now: Date,
): Promise<Computed<GaRightNow>> {
  try {
    const token = await accessToken(credential);
    let result: { activeUsers: number };
    try {
      result = await runGaRealtimeActiveUsers(token, propertyId);
    } finally {
      afterGoogleCall();
    }
    const value: GaRightNow = {
      activeUsers: result.activeUsers,
      asOf: now.toISOString(),
    };
    realtimeCache.set(key, { at: now.getTime(), projectId, value });
    return { ok: true, value };
  } catch (error) {
    if (
      error instanceof GoogleApiError &&
      (error.errorClass === "RATE_LIMIT" || error.errorClass === "QUOTA_DAILY")
    ) {
      realtimeBackoff.set(propertyId, now.getTime() + GA_REALTIME_BACKOFF_MS);
    }
    return mapError("right now", error);
  }
}

export const GaLive = {
  async todaySoFar(
    projectId: string,
    now: Date = new Date(),
  ): Promise<GaTodayResult> {
    sweep(now.getTime());
    const resolved = await resolveLink(projectId);
    if (!resolved.ok) return resolved;
    const { link, credential } = resolved;
    const timeZone = safeTimezone(link.timeZone);
    const today = dayKeyInTimezone(now, timeZone);

    const cached = todayCache.get(link.id);
    if (
      cached &&
      cacheFresh(cached.at, now.getTime(), GA_TODAY_TTL_MS) &&
      cached.value.day === today
    ) {
      return { ok: true, today: cached.value, cached: true };
    }

    let pending = todayInFlight.get(link.id);
    if (!pending) {
      pending = fetchToday(link, credential, now, timeZone, today).finally(() =>
        todayInFlight.delete(link.id),
      );
      todayInFlight.set(link.id, pending);
    }
    const result = await pending;
    return result.ok
      ? { ok: true, today: result.value, cached: false }
      : result;
  },

  async rightNow(
    projectId: string,
    now: Date = new Date(),
  ): Promise<GaRightNowResult> {
    sweep(now.getTime());
    const resolved = await resolveLink(projectId);
    if (!resolved.ok) return resolved;
    const { link, credential } = resolved;
    const propertyId = link.propertyId;
    // Önbellek ve bekleyen çağrı bağlantıya özel; geri çekilme mülke özel.
    const key = `${propertyId}|${credential.id}`;

    const until = realtimeBackoff.get(propertyId);
    if (until !== undefined && until > now.getTime()) {
      return unavailable("quota");
    }

    const cached = realtimeCache.get(key);
    if (cached && cacheFresh(cached.at, now.getTime(), GA_REALTIME_TTL_MS)) {
      return { ok: true, now: cached.value, cached: true };
    }

    let pending = realtimeInFlight.get(key);
    if (!pending) {
      pending = fetchRealtime(
        key,
        propertyId,
        credential,
        projectId,
        now,
      ).finally(() => realtimeInFlight.delete(key));
      realtimeInFlight.set(key, pending);
    }
    const result = await pending;
    if (!result.ok) return result;
    return { ok: true, now: result.value, cached: false };
  },
};

// Testler için.
export function resetGaLiveCaches(): void {
  todayCache.clear();
  todayInFlight.clear();
  realtimeCache.clear();
  realtimeInFlight.clear();
  realtimeBackoff.clear();
}
