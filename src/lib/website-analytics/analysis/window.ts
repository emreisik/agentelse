import { addDays, daysInRange } from "@/lib/website-analytics/days";
import {
  aggregateSlices,
  droppedTotals,
  type GaStoredSlice,
  type GaTableRow,
} from "@/lib/website-analytics/slices";

import type {
  GaRange,
  GaWindowReport,
  GaWindowTables,
  GaWindowTotals,
} from "./types";

// GA-F4 pencere tabloları (docs/website-insights.md "Veri"): ambarın DAY ve
// WEEK dilimleri bir aralık için tek tabloya toplanır. Hariç tutulan günler
// (şüpheli günler) hem toplamlardan hem dilimlerden düşer; o günlerden birine
// değen WEEK dilimi bütünüyle düşer ve günleri o rapor için kapsanmamış
// sayılır. Kapsam (coverage) rapor başına temiz gün sayısıdır: pencere
// kuralları bunu usedDays ile karşılaştırır (run-rules.ts). Saf modül.

export type GaWindowDayTotal = {
  day: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  revenueMicros: bigint;
  transactions: number;
  engagementSec: number;
  screenPageViews: number;
};

export type GaWindowSliceSource = {
  slices: GaStoredSlice[];
  // WEEK diliminin Pazartesi'leri (readMergedSlices plan.weeks); geri
  // kalanlar DAY dilimidir.
  weekStarts: ReadonlySet<string>;
};

// Rapor başına toplama: GaWindowTables yorumlarındaki boyut × metrik sırası.
const REPORT_SHAPES: Readonly<
  Record<GaWindowReport, { groupBy: string[]; metrics: string[] }>
> = {
  channel: {
    groupBy: ["sessionDefaultChannelGroup"],
    metrics: ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
  },
  landing: {
    groupBy: ["landingPage"],
    metrics: [
      "sessions",
      "engagedSessions",
      "keyEvents",
      "totalRevenue",
      "userEngagementDuration",
    ],
  },
  sourceMedium: {
    groupBy: ["sessionSource", "sessionMedium"],
    metrics: ["sessions", "engagedSessions", "keyEvents"],
  },
  campaign: {
    groupBy: ["sessionCampaignName", "sessionSource", "sessionMedium"],
    metrics: ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
  },
  device: {
    groupBy: ["deviceCategory"],
    metrics: ["sessions", "engagedSessions", "keyEvents"],
  },
  country: { groupBy: ["country"], metrics: ["sessions"] },
  pages: {
    groupBy: ["pagePath", "pageTitle"],
    metrics: ["screenPageViews", "userEngagementDuration"],
  },
  events: {
    groupBy: ["eventName", "isKeyEvent"],
    metrics: ["eventCount", "keyEvents"],
  },
  newReturning: {
    groupBy: ["newVsReturning"],
    metrics: ["activeUsers", "sessions", "keyEvents"],
  },
};

const REPORTS = Object.keys(REPORT_SHAPES) as GaWindowReport[];

function zeroTotals(): GaWindowTotals {
  return {
    sessions: 0,
    engagedSessions: 0,
    keyEvents: 0,
    revenue: 0,
    transactions: 0,
    engagementSec: 0,
    screenPageViews: 0,
  };
}

export function emptyWindowTables(range: GaRange): GaWindowTables {
  const days = daysInRange(range.from, range.to);
  return {
    from: range.from,
    to: range.to,
    days,
    usedDays: 0,
    excludedDays: [],
    missingDays: days,
    totals: zeroTotals(),
    channel: [],
    landing: [],
    landingOther: null,
    sourceMedium: [],
    campaign: [],
    device: [],
    country: [],
    pages: [],
    events: [],
    newReturning: [],
    quality: { thresholded: false, otherRow: false, truncated: false },
    coverage: {},
  };
}

function inRange(day: string, range: GaRange): boolean {
  return day >= range.from && day <= range.to;
}

// Dilimin temiz kalıp kalmadığı ve kapsadığı gün sayısı (DAY 1, WEEK 7);
// düşen dilim null.
function usableDays(
  slice: GaStoredSlice,
  source: GaWindowSliceSource,
  range: GaRange,
  exclude: ReadonlySet<string>,
): number | null {
  if (source.weekStarts.has(slice.day)) {
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(slice.day, offset);
      if (!inRange(day, range) || exclude.has(day)) return null;
    }
    return 7;
  }
  return inRange(slice.day, range) && !exclude.has(slice.day) ? 1 : null;
}

export function windowTablesFrom(input: {
  range: GaRange;
  exclude: ReadonlySet<string>;
  totals: readonly GaWindowDayTotal[];
  slices: Partial<Record<GaWindowReport, GaWindowSliceSource>>;
}): GaWindowTables {
  const { range, exclude } = input;
  const tables = emptyWindowTables(range);
  tables.excludedDays = [...exclude]
    .filter((day) => inRange(day, range))
    .sort();

  const totals = zeroTotals();
  let usedDays = 0;
  for (const row of input.totals) {
    if (!inRange(row.day, range) || exclude.has(row.day)) continue;
    usedDays += 1;
    totals.sessions += row.sessions;
    totals.engagedSessions += row.engagedSessions;
    totals.keyEvents += row.keyEvents;
    totals.revenue += Number(row.revenueMicros) / 1e6;
    totals.transactions += row.transactions;
    totals.engagementSec += row.engagementSec;
    totals.screenPageViews += row.screenPageViews;
  }
  tables.totals = totals;
  tables.usedDays = usedDays;
  tables.missingDays = Math.max(
    0,
    tables.days - usedDays - tables.excludedDays.length,
  );

  const used: GaStoredSlice[] = [];
  for (const report of REPORTS) {
    const source = input.slices[report];
    if (!source) continue;
    const kept: GaStoredSlice[] = [];
    let covered = 0;
    for (const slice of source.slices) {
      const days = usableDays(slice, source, range, exclude);
      if (days === null) continue;
      kept.push(slice);
      covered += days;
    }
    tables.coverage[report] = covered;
    used.push(...kept);
    const shape = REPORT_SHAPES[report];
    const rows: GaTableRow[] = aggregateSlices(
      kept,
      shape.groupBy,
      shape.metrics,
    );
    tables[report] = rows;
    if (report === "landing") {
      tables.landingOther = kept.some((slice) => slice.otherRow !== null)
        ? droppedTotals(kept, shape.metrics)
        : null;
    }
  }

  // device ve country aynı dilimleri paylaşabilir: kalite bir kez sayılır.
  const unique = new Set(used);
  for (const slice of unique) {
    tables.quality.thresholded ||= slice.quality.thresholded === true;
    tables.quality.otherRow ||=
      slice.quality.otherRow === true || slice.otherRow !== null;
    tables.quality.truncated ||= slice.truncated;
  }
  return tables;
}
