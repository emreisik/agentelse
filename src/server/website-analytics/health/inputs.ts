import "server-only";

import type { GaHealthRun, GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  gaOptionalReportEnabled,
  parseGaCatalogState,
} from "@/lib/website-analytics/catalog-state";
import {
  addDays,
  dateToDayKey,
  dayKeyToDate,
  hourInTimezone,
  safeTimezone,
} from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import { completeThroughOf } from "@/lib/website-analytics/health/schedule";
import {
  parseGaPiiProbeResult,
  parseGaRealtimeState,
  parseGaSiteTagResult,
} from "@/lib/website-analytics/health/stored";
import { parseSuspectDays } from "@/lib/website-analytics/health/suspect";
import type {
  GaHealthBreakdownDay,
  GaHealthDay,
  GaHealthInputs,
  GaHealthSliceQuality,
} from "@/lib/website-analytics/health/types";
import type { GaQuality } from "@/lib/website-analytics/response";
import {
  aggregateSlices,
  type GaStoredSlice,
} from "@/lib/website-analytics/slices";
import {
  readDailyTotals,
  readSlices,
  type GaDayTotals,
} from "@/server/website-analytics/store";

// GA-F3 ölçüm sağlığının girdileri (docs/measurement-health.md): yalnız
// ambar (GaDailyTotal, GaReportSlice) ve GaPropertyLink yönetim metadata'sı
// okunur; Google'a çağrı yok. Değerlendirme günleri completeThrough'a
// (günlük çekimin bitirdiği son gün) kadardır; o aralıkta ambarda olmayan
// gün sıfır oturumlu yapay gün olarak eklenir (etiket kaldırıldı durumu).

const DAYS_BACK = 70;
const BREAKDOWN_DAYS = 35;
const WINDOW_DAYS = 28;
const PII_MARKERS = ["[email]", "[phone]"];

type HealthReportKey = keyof GaHealthInputs["window28"]["coverage"];

function healthDay(row: GaDayTotals): GaHealthDay {
  return {
    day: row.day,
    sessions: row.sessions,
    engagedSessions: row.engagedSessions,
    engagementSec: row.engagementSec,
    screenPageViews: row.screenPageViews,
    keyEvents: row.keyEvents,
    revenueMicros: Number(row.revenueMicros),
    transactions: row.transactions,
    isFinal: row.isFinal,
    synthetic: false,
  };
}

function zeroDay(day: string): GaHealthDay {
  return {
    day,
    sessions: 0,
    engagedSessions: 0,
    engagementSec: 0,
    screenPageViews: 0,
    keyEvents: 0,
    revenueMicros: 0,
    transactions: 0,
    isFinal: false,
    synthetic: true,
  };
}

// Saf: [ilk saklanan gün, completeThrough] aralığında ambarda olmayan her
// güne sıfır satır (synthetic) ekler; aralık dışına dokunmaz. completeThrough
// null ya da saklanan gün yoksa liste olduğu gibi (artan) döner. Çağıran
// completeThrough'u dünle sınırlar.
export function fillMissingDays(
  stored: readonly GaHealthDay[],
  completeThrough: string | null,
): GaHealthDay[] {
  const sorted = [...stored].sort((a, b) => a.day.localeCompare(b.day));
  const first = sorted[0];
  if (!completeThrough || !first) return sorted;
  const have = new Set(sorted.map((row) => row.day));
  const filled = [...sorted];
  for (let day = first.day; day <= completeThrough; day = addDays(day, 1)) {
    if (!have.has(day)) filled.push(zeroDay(day));
  }
  return filled.sort((a, b) => a.day.localeCompare(b.day));
}

// Saf: ambar satırları + yapay günler; completeThrough dünle sınırlanır.
export function healthDaysOf(
  totals: readonly GaDayTotals[],
  completeThrough: string | null,
  yesterday: string,
): GaHealthDay[] {
  const end =
    completeThrough === null
      ? null
      : completeThrough < yesterday
        ? completeThrough
        : yesterday;
  return fillMissingDays(totals.map(healthDay), end);
}

function within(slices: GaStoredSlice[], from: string): GaStoredSlice[] {
  return slices.filter((slice) => slice.day >= from);
}

function distinctDays(slices: GaStoredSlice[]): number {
  return new Set(slices.map((slice) => slice.day)).size;
}

function hasMarker(row: GaStoredSlice["rows"][number], width: number) {
  for (let index = 0; index < width; index += 1) {
    const value = String(row[index] ?? "");
    if (PII_MARKERS.some((marker) => value.includes(marker))) return true;
  }
  return false;
}

// Gün başına açılış sayfası + sayfa dilimlerinde maske işaretli satır sayısı.
function piiMarkersOf(slices: GaStoredSlice[]): GaHealthInputs["piiMarkers"] {
  const byDay = new Map<string, number>();
  for (const slice of slices) {
    const width = slice.dimensionHeaders.length;
    const count = slice.rows.filter((row) => hasMarker(row, width)).length;
    if (count > 0) byDay.set(slice.day, (byDay.get(slice.day) ?? 0) + count);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, count }));
}

function breakdownsOf(
  deviceCountry: GaStoredSlice[],
  sourceMedium: GaStoredSlice[],
): GaHealthBreakdownDay[] {
  const days = new Set([
    ...deviceCountry.map((slice) => slice.day),
    ...sourceMedium.map((slice) => slice.day),
  ]);
  const metrics = ["sessions", "engagedSessions"];
  return [...days].sort().map((day) => ({
    day,
    country: aggregateSlices(
      deviceCountry.filter((slice) => slice.day === day),
      ["country"],
      metrics,
    ),
    source: aggregateSlices(
      sourceMedium.filter((slice) => slice.day === day),
      ["sessionSource"],
      metrics,
    ),
  }));
}

function qualityOf(
  rows: { reportKey: string; periodStart: Date; quality: unknown }[],
): GaHealthSliceQuality[] {
  return rows.map((row) => {
    const quality = (row.quality ?? {}) as GaQuality;
    return {
      reportKey: row.reportKey,
      day: dateToDayKey(row.periodStart),
      thresholded: quality.thresholded === true,
      otherRow: quality.otherRow === true,
    };
  });
}

function keyEventsOf(json: unknown): GaHealthInputs["link"]["keyEvents"] {
  if (!Array.isArray(json)) return null;
  const events: { eventName: string; countingMethod: string | null }[] = [];
  for (const item of json as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { eventName?: unknown; countingMethod?: unknown };
    if (typeof entry.eventName !== "string") continue;
    events.push({
      eventName: entry.eventName,
      countingMethod:
        typeof entry.countingMethod === "string" ? entry.countingMethod : null,
    });
  }
  return events;
}

function googleAdsLinksOf(json: unknown): number | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const value = (json as { googleAds?: unknown }).googleAds;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// MH16: GA-F2b katalog denetiminin search_console durumu.
function searchConsoleReportOf(
  catalog: unknown,
): GaHealthInputs["link"]["searchConsoleReport"] {
  if (!GaFlags.catalogChecks()) return "unknown";
  const state = parseGaCatalogState(catalog);
  if (!state.check || state.check.error) return "unknown";
  if (!state.optional.search_console) return "unknown";
  return gaOptionalReportEnabled(catalog, "search_console") ? "on" : "off";
}

function credentialStatusOf(
  credential: { status: string; encryptedSecret: string } | null,
): string {
  if (!credential) return "MISSING";
  if (!credential.encryptedSecret) return "REVOKED";
  return credential.status;
}

export async function loadGaHealthInputs(
  link: GaPropertyLink,
  run: GaHealthRun | null,
  now: Date,
): Promise<GaHealthInputs> {
  const timeZone = safeTimezone(link.timeZone);
  const today = dayKeyInTimezone(now, timeZone);
  const propertyHour = hourInTimezone(now, timeZone);
  const yesterday = addDays(today, -1);
  const completeThrough = completeThroughOf(link.lastDailyDate);
  const from28 = addDays(yesterday, -(WINDOW_DAYS - 1));
  const from35 = addDays(today, -BREAKDOWN_DAYS);

  const [
    totals,
    channel,
    landing,
    page,
    events,
    deviceCountry,
    sourceMedium,
    qualityRows,
    project,
    schedule,
    credential,
  ] = await Promise.all([
    readDailyTotals(link.id, addDays(today, -DAYS_BACK), yesterday),
    readSlices(link.id, "channel", from28, yesterday),
    readSlices(link.id, "landing_page", from28, yesterday),
    readSlices(link.id, "page", from28, yesterday),
    readSlices(link.id, "events", from28, yesterday),
    readSlices(link.id, "device_country", from35, yesterday),
    readSlices(link.id, "source_medium", from35, yesterday),
    prisma.gaReportSlice.findMany({
      where: {
        linkId: link.id,
        grain: "DAY",
        periodStart: {
          gte: dayKeyToDate(from28),
          lte: dayKeyToDate(yesterday),
        },
      },
      select: { reportKey: true, periodStart: true, quality: true },
    }),
    prisma.project.findUnique({
      where: { id: link.projectId },
      select: { domain: true },
    }),
    prisma.projectSchedule.findFirst({
      where: { projectId: link.projectId, capability: "INSTAGRAM_PUBLISH" },
      select: { timezone: true },
    }),
    prisma.integrationCredential.findUnique({
      where: { id: link.credentialId },
      select: { status: true, encryptedSecret: true },
    }),
  ]);

  const days = healthDaysOf(totals, completeThrough, yesterday);
  const latestStoredDay = totals.at(-1)?.day ?? null;
  const deviceCountry28 = within(deviceCountry, from28);
  const sourceMedium28 = within(sourceMedium, from28);
  const metrics = ["sessions", "engagedSessions"];
  const coverage: Partial<Record<HealthReportKey, number>> = {
    channel: distinctDays(channel),
    source_medium: distinctDays(sourceMedium28),
    landing_page: distinctDays(landing),
    page: distinctDays(page),
    events: distinctDays(events),
    device_country: distinctDays(deviceCountry28),
  };

  return {
    now,
    today,
    propertyHour,
    completeThrough,
    latestStoredDay,
    link: {
      id: link.id,
      propertyId: link.propertyId,
      health: link.health,
      createdAt: link.createdAt,
      measurementId: link.measurementId,
      streamUri: link.streamUri,
      timeZone: link.timeZone,
      dataRetention: link.dataRetention,
      keyEvents: keyEventsOf(link.keyEvents),
      googleAdsLinks: googleAdsLinksOf(link.linkedProducts),
      lastDailyDate: link.lastDailyDate,
      lastDailyAt: link.lastDailyAt,
      credentialStatus: credentialStatusOf(credential),
      searchConsoleReport: searchConsoleReportOf(link.catalog),
    },
    project: {
      domain: project?.domain ?? null,
      timeZone: schedule?.timezone ?? null,
    },
    days,
    window28: {
      from: from28,
      to: yesterday,
      coverage,
      channel: aggregateSlices(
        channel,
        ["sessionDefaultChannelGroup"],
        metrics,
      ),
      sourceMedium: aggregateSlices(
        sourceMedium28,
        ["sessionSource", "sessionMedium"],
        metrics,
      ),
      landing: aggregateSlices(landing, ["landingPage"], ["sessions"]),
      pages: aggregateSlices(page, ["pagePath"], ["screenPageViews"]),
      events: aggregateSlices(
        events,
        ["eventName"],
        ["eventCount", "keyEvents"],
      ),
      country: aggregateSlices(deviceCountry28, ["country"], metrics),
    },
    piiMarkers: piiMarkersOf([...landing, ...page]),
    breakdowns: breakdownsOf(deviceCountry, sourceMedium),
    quality: qualityOf(qualityRows),
    suspectDays: Object.keys(parseSuspectDays(run?.suspectDays ?? null)).sort(),
    siteTag: parseGaSiteTagResult(run?.siteTag ?? null),
    piiProbe: parseGaPiiProbeResult(run?.piiProbe ?? null),
    realtime: parseGaRealtimeState(run?.realtime ?? null),
  };
}
