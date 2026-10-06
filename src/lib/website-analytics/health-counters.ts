import { readAddonState } from "@/lib/website-analytics/addon-backfill";
import {
  gaDisabledReports,
  gaOptionalReportEnabled,
  parseGaCatalogState,
} from "@/lib/website-analytics/catalog-state";
import { addDays, safeTimezone } from "@/lib/website-analytics/days";
import { dayKeyInTimezone } from "@/lib/timezone";

// /health "Google Analytics" kartının sayaçları (docs/google-analytics-plan.md
// §3.9 /health, §3.11 Limited Use): yalnız sayılar. Mülk kimliği, adı ya da
// müşteri rakamı burada hiç yer almaz; kart operatöre senkronun genel
// sağlığını gösterir. Saf modül; veri server/website-analytics/health-counters.ts'te
// okunur.

export type GaHealthCounters = {
  links: { total: number; mock: number; byHealth: Record<string, number> };
  sync: {
    failing: number;
    rateLimited: number;
    neverSynced: number;
    lagOver2Days: number;
    backfillPending: number;
    addonsPending: number;
    heartbeatMinutesAgo: number | null;
  };
  quota: {
    maxDailyShare: number | null;
    overHalfDaily: number;
    overHalfHourly: number;
  };
  api: {
    windowHours: 24;
    calls: number;
    errors: Partial<Record<string, number>>;
  };
  catalog: {
    droppedReports: number;
    linksWithDeprecated: number;
    googleAdsEnabled: number;
    searchConsoleEnabled: number;
  };
};

export type GaLinkHealthInput = {
  health: string;
  isMock: boolean;
  consecutiveFailures: number;
  rateLimitedUntil: Date | null;
  lastDailyAt: Date | null;
  backfillDoneAt: Date | null;
  lastQuota: unknown;
  catalog: unknown;
  backfill: unknown;
  timeZone: string | null;
  // GaDailyTotal'daki en yeni gün (mülk saatiyle YYYY-MM-DD).
  latestDay: string | null;
};

const HOUR_MS = 3_600_000;
// Günlük kotalar Pasifik saatiyle gece yarısı sıfırlanır (governor.ts ile aynı).
const QUOTA_TIMEZONE = "America/Los_Angeles";
const HOURLY_KEYS = ["tokensPerHour", "tokensPerProjectPerHour"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// consumed / (consumed + remaining); bozuk değerde null.
function usedShare(status: unknown): number | null {
  if (!isRecord(status)) return null;
  const { consumed, remaining } = status;
  if (typeof consumed !== "number" || typeof remaining !== "number") {
    return null;
  }
  if (!Number.isFinite(consumed) || !Number.isFinite(remaining)) return null;
  if (consumed < 0 || remaining < 0) return null;
  const total = consumed + remaining;
  return total > 0 ? consumed / total : null;
}

type QuotaShares = { daily: number | null; hourly: number | null };

// Son kota okuması (StoredGaQuota). Günlük pay yalnız bugünün Pasifik günüyse,
// saatlik pay yalnız son bir saatteyse geçerlidir.
function quotaShares(lastQuota: unknown, now: Date): QuotaShares {
  const none = { daily: null, hourly: null };
  if (!isRecord(lastQuota) || typeof lastQuota.at !== "string") return none;
  if (!isRecord(lastQuota.quota)) return none;
  const at = new Date(lastQuota.at);
  if (Number.isNaN(at.getTime())) return none;
  const quota = lastQuota.quota;

  const daily =
    dayKeyInTimezone(at, QUOTA_TIMEZONE) ===
    dayKeyInTimezone(now, QUOTA_TIMEZONE)
      ? usedShare(quota.tokensPerDay)
      : null;
  const age = now.getTime() - at.getTime();
  let hourly: number | null = null;
  if (age >= 0 && age < HOUR_MS) {
    for (const key of HOURLY_KEYS) {
      const share = usedShare(quota[key]);
      if (share !== null && (hourly === null || share > hourly)) hourly = share;
    }
  }
  return { daily, hourly };
}

// Ek geçmişlerden (haftalık, google_ads) biri hâlâ sürüyor mu.
function addonsPending(backfill: unknown): boolean {
  const state = readAddonState(backfill);
  return Object.entries(state.next).some(
    ([key, next]) => Boolean(next) && !state.doneAt[key],
  );
}

function dataLate(link: GaLinkHealthInput, now: Date): boolean {
  if (!link.latestDay) return false;
  const today = dayKeyInTimezone(now, safeTimezone(link.timeZone));
  return link.latestDay < addDays(today, -3);
}

export function summarizeGaLinks(
  links: GaLinkHealthInput[],
  now: Date,
): Omit<GaHealthCounters, "api"> {
  const byHealth: Record<string, number> = {};
  const sync = {
    failing: 0,
    rateLimited: 0,
    neverSynced: 0,
    lagOver2Days: 0,
    backfillPending: 0,
    addonsPending: 0,
    heartbeatMinutesAgo: null,
  };
  let maxDaily: number | null = null;
  let overHalfDaily = 0;
  let overHalfHourly = 0;
  const catalog = {
    droppedReports: 0,
    linksWithDeprecated: 0,
    googleAdsEnabled: 0,
    searchConsoleEnabled: 0,
  };
  let mock = 0;

  for (const link of links) {
    byHealth[link.health] = (byHealth[link.health] ?? 0) + 1;
    if (link.isMock) mock += 1;

    if (link.consecutiveFailures > 0) sync.failing += 1;
    if (link.rateLimitedUntil && link.rateLimitedUntil > now) {
      sync.rateLimited += 1;
    }
    if (!link.lastDailyAt) sync.neverSynced += 1;
    if (dataLate(link, now)) sync.lagOver2Days += 1;
    if (!link.backfillDoneAt) sync.backfillPending += 1;
    if (addonsPending(link.backfill)) sync.addonsPending += 1;

    // Mock bağların kotası gerçek değildir.
    if (!link.isMock) {
      const shares = quotaShares(link.lastQuota, now);
      if (shares.daily !== null) {
        maxDaily = Math.max(maxDaily ?? 0, shares.daily);
        if (shares.daily > 0.5) overHalfDaily += 1;
      }
      if (shares.hourly !== null && shares.hourly > 0.5) overHalfHourly += 1;
    }

    catalog.droppedReports += gaDisabledReports(link.catalog).size;
    if (parseGaCatalogState(link.catalog).check?.deprecated.length) {
      catalog.linksWithDeprecated += 1;
    }
    if (gaOptionalReportEnabled(link.catalog, "google_ads")) {
      catalog.googleAdsEnabled += 1;
    }
    if (gaOptionalReportEnabled(link.catalog, "search_console")) {
      catalog.searchConsoleEnabled += 1;
    }
  }

  return {
    links: { total: links.length, mock, byHealth },
    sync,
    quota: {
      maxDailyShare: maxDaily === null ? null : Math.round(maxDaily * 100),
      overHalfDaily,
      overHalfHourly,
    },
    catalog,
  };
}
