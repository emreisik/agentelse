import "server-only";

import { dayKeyInTimezone } from "@/lib/timezone";
import { safeTimezone } from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";
import {
  overviewTrend,
  overviewWindow,
  websiteHealthTone,
  type WebsiteOverview,
} from "@/lib/website-analytics/overview";
import { changePercent } from "@/lib/website-analytics/periods";
import { sumTotals } from "@/lib/website-analytics/totals";

import { loadMeasurementSummaryForLink } from "./health/read";
import { gaDataThrough, primaryGaLink, readDailyTotals } from "./store";

// Brand sekmesindeki "Website" kartının verisi (GA-F2 bölüm 2,
// GA_BRAND_CARD): ambarın son günü ile dünden erken olanında biten 28 tam
// gün, önceki 28 günle karşılaştırmalı. Yalnız ambardan okur, Google'a
// çağrı yapmaz.

const DAYS = 28;

export async function loadWebsiteOverview(
  projectId: string,
  now: Date = new Date(),
): Promise<WebsiteOverview> {
  if (!GaFlags.sync() || !GaFlags.websitePage() || !GaFlags.brandCard()) {
    return { ok: false, reason: "off" };
  }
  const link = await primaryGaLink(projectId);
  if (!link) return { ok: false, reason: "not_connected" };

  const today = dayKeyInTimezone(now, safeTimezone(link.timeZone));
  const { through } = await gaDataThrough(link.id);
  const window = overviewWindow(today, through);
  if (!window) return { ok: false, reason: "not_synced" };

  const [currentRows, previousRows] = await Promise.all([
    readDailyTotals(link.id, window.current.from, window.current.to),
    readDailyTotals(link.id, window.previous.from, window.previous.to),
  ]);
  // Eksik günlü pencere yanlış toplam verir: kart gizlenir.
  if (currentRows.length < DAYS) return { ok: false, reason: "not_synced" };

  const current = sumTotals(currentRows);
  const previous = sumTotals(previousRows);
  const comparable = previousRows.length === DAYS;
  const sessionsChange = comparable
    ? changePercent(current.sessions, previous.sessions)
    : null;
  const keyEventsChange = comparable
    ? changePercent(current.keyEvents, previous.keyEvents)
    : null;
  const health = websiteHealthTone({
    health: link.health,
    dataThrough: through,
    today,
  });
  const measurement = gaHealthEnabled()
    ? await loadMeasurementSummaryForLink(link.id).catch(() => null)
    : null;

  return {
    ok: true,
    propertyName: link.propertyName,
    days: DAYS,
    sessions: current.sessions,
    keyEvents: current.keyEvents,
    sessionsChange,
    keyEventsChange,
    trend: overviewTrend(sessionsChange),
    health: health.tone,
    healthLabel: health.label,
    dataThrough: through,
    ...(measurement
      ? {
          measurement: {
            score: measurement.score,
            tone: measurement.tone,
            label: measurement.label,
          },
        }
      : {}),
  };
}
