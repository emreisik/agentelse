import "server-only";

import type {
  GaRange,
  GaWindowReport,
  GaWindowTables,
} from "@/lib/website-analytics/analysis/types";
import {
  windowTablesFrom,
  type GaWindowSliceSource,
} from "@/lib/website-analytics/analysis/window";
import {
  readDailyTotals,
  readMergedSlices,
  readSlices,
} from "@/server/website-analytics/store";

// GA-F4 pencere okuyucusu (docs/website-insights.md "Veri"): istenen raporlar
// ambardan paralel okunur, hiçbir zaman istenmeyen rapor okunmaz. Kısa
// saklamalı raporlar (95 gün) readMergedSlices ile DAY + WEEK birleşik okunur
// (WEEK yalnız GA_WEEKLY açıkken; kenar haftalar dışarıda); device ve
// country tek device_country okumasından iki ayrı toplamadır.

const REPORT_KEYS: Readonly<Record<GaWindowReport, string>> = {
  channel: "channel",
  landing: "landing_page",
  sourceMedium: "source_medium",
  campaign: "campaign",
  device: "device_country",
  country: "device_country",
  pages: "page",
  events: "events",
  newReturning: "new_returning",
};

const SHORT_RETENTION_KEYS: ReadonlySet<string> = new Set([
  "landing_page",
  "page",
  "source_medium",
  "campaign",
  "device_country",
]);

const NO_WEEKS: ReadonlySet<string> = new Set();

async function readSource(
  linkId: string,
  reportKey: string,
  range: GaRange,
): Promise<GaWindowSliceSource> {
  if (SHORT_RETENTION_KEYS.has(reportKey)) {
    const merged = await readMergedSlices(
      linkId,
      reportKey,
      range.from,
      range.to,
      {
        edgeWeeks: "exclude",
      },
    );
    return { slices: merged.slices, weekStarts: new Set(merged.plan.weeks) };
  }
  return {
    slices: await readSlices(linkId, reportKey, range.from, range.to),
    weekStarts: NO_WEEKS,
  };
}

export async function loadGaWindowTables(
  linkId: string,
  range: GaRange,
  options: { exclude: ReadonlySet<string>; reports: readonly GaWindowReport[] },
): Promise<GaWindowTables> {
  const keys = [
    ...new Set(options.reports.map((report) => REPORT_KEYS[report])),
  ];
  const [totals, ...sources] = await Promise.all([
    readDailyTotals(linkId, range.from, range.to),
    ...keys.map((key) => readSource(linkId, key, range)),
  ]);
  const byKey = new Map(keys.map((key, index) => [key, sources[index]!]));
  const slices: Partial<Record<GaWindowReport, GaWindowSliceSource>> = {};
  for (const report of options.reports) {
    const source = byKey.get(REPORT_KEYS[report]);
    if (source) slices[report] = source;
  }
  return windowTablesFrom({
    range,
    exclude: options.exclude,
    totals: totals.map((row) => ({
      day: row.day,
      sessions: row.sessions,
      engagedSessions: row.engagedSessions,
      keyEvents: row.keyEvents,
      revenueMicros: row.revenueMicros,
      transactions: row.transactions,
      engagementSec: row.engagementSec,
      screenPageViews: row.screenPageViews,
    })),
    slices,
  });
}
