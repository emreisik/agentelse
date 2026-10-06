import { addDays, daysInRange } from "@/lib/website-analytics/days";
import { weekSunday } from "@/lib/website-analytics/weeks";

import type {
  GaAnalysisDay,
  GaDailyAnalysisInput,
  GaRange,
  GaWeeklyAnalysisInput,
  GaWindowReport,
  GaWindowTables,
} from "./types";

// GA-F4 test yardımcıları: deterministik varsayılanlarla girdi kurucuları.
// Yalnız *.test.ts dosyaları içe aktarır; üretim kodu kullanmaz.
// Varsayılanlar: bağ "link-1", bugün 2026-10-07, completeThrough 2026-10-05,
// haftalık turda 2026-09-28 … 2026-10-04 haftası; tablolar boş, toplamlar 0,
// kapsam tam, ölçüm sağlığı temiz.

export const FIXTURE_LINK_ID = "link-1";
export const FIXTURE_TODAY = "2026-10-07";
export const FIXTURE_COMPLETE_THROUGH = "2026-10-05";
export const FIXTURE_WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };

const WINDOW_REPORTS: readonly GaWindowReport[] = [
  "channel",
  "landing",
  "sourceMedium",
  "campaign",
  "device",
  "country",
  "pages",
  "events",
  "newReturning",
];

// Gün başına oturum `sessions(day, index)`; keyEvents = round(oturum × oran)
// (varsayılan oran 0.02), engagedSessions = round(oturum × 0.6), revenue =
// keyEvents × revenuePerKeyEvent (varsayılan 0), transactions = revenue
// varsa keyEvents. isFinal varsayılan true.
export function makeDays(input: {
  from: string;
  to: string;
  sessions: (day: string, index: number) => number;
  keyEventRate?: number;
  revenuePerKeyEvent?: number;
  isFinal?: boolean;
}): GaAnalysisDay[] {
  const rate = input.keyEventRate ?? 0.02;
  const revenuePerKeyEvent = input.revenuePerKeyEvent ?? 0;
  const days: GaAnalysisDay[] = [];
  const count = daysInRange(input.from, input.to);
  for (let index = 0; index < count; index++) {
    const day = addDays(input.from, index);
    const sessions = input.sessions(day, index);
    const keyEvents = Math.round(sessions * rate);
    const revenue = keyEvents * revenuePerKeyEvent;
    days.push({
      day,
      sessions,
      engagedSessions: Math.round(sessions * 0.6),
      keyEvents,
      revenue,
      transactions: revenue > 0 ? keyEvents : 0,
      isFinal: input.isFinal ?? true,
    });
  }
  return days;
}

// Boş tablolar; days aralıktan hesaplanır, usedDays = days, her rapor için
// kapsam = usedDays (kapsam kapısı tetiklenmez). partial her alanı ezer.
export function makeWindowTables(
  range: GaRange,
  partial: Partial<GaWindowTables> = {},
): GaWindowTables {
  const days = daysInRange(range.from, range.to);
  const usedDays = partial.usedDays ?? days;
  const coverage: Partial<Record<GaWindowReport, number>> = {};
  for (const report of WINDOW_REPORTS) coverage[report] = usedDays;
  return {
    from: range.from,
    to: range.to,
    days,
    usedDays,
    excludedDays: [],
    missingDays: 0,
    totals: {
      sessions: 0,
      engagedSessions: 0,
      keyEvents: 0,
      revenue: 0,
      transactions: 0,
      engagementSec: 0,
      screenPageViews: 0,
    },
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
    coverage,
    ...partial,
  };
}

// Günlük tur girdisi: [ct-400, ct] boyunca günde 100 oturum, hedefler son üç
// gün, şüpheli/tatil yok, hedef yok.
export function makeDailyInput(
  partial: Partial<GaDailyAnalysisInput> = {},
): GaDailyAnalysisInput {
  const ct = FIXTURE_COMPLETE_THROUGH;
  return {
    linkId: FIXTURE_LINK_ID,
    today: FIXTURE_TODAY,
    targets: [addDays(ct, -2), addDays(ct, -1), ct],
    country: null,
    days: makeDays({ from: addDays(ct, -400), to: ct, sessions: () => 100 }),
    suspect: new Set<string>(),
    holidays: new Set<string>(),
    channelDays: [],
    goals: [],
    measurementDegraded: false,
    ...partial,
  };
}

// Haftalık tur girdisi: FIXTURE_WEEK haftası; [sunday-400, sunday] boyunca
// günde 100 oturum; bütün pencere tabloları boş ve tam kapsamlı.
export function makeWeeklyInput(
  partial: Partial<GaWeeklyAnalysisInput> = {},
): GaWeeklyAnalysisInput {
  const week = partial.week ?? FIXTURE_WEEK;
  const { monday, sunday } = week;
  const weeks: GaWindowTables[] = [];
  for (let offset = 7; offset >= 0; offset--) {
    const start = addDays(monday, -7 * offset);
    weeks.push(makeWindowTables({ from: start, to: weekSunday(start) }));
  }
  return {
    linkId: FIXTURE_LINK_ID,
    today: FIXTURE_TODAY,
    week,
    country: null,
    days: makeDays({
      from: addDays(sunday, -400),
      to: sunday,
      sessions: () => 100,
    }),
    suspect: new Set<string>(),
    holidays: new Set<string>(),
    current: makeWindowTables({ from: monday, to: sunday }),
    previous: makeWindowTables({
      from: addDays(monday, -7),
      to: addDays(sunday, -7),
    }),
    lastYear: null,
    window28: makeWindowTables({ from: addDays(sunday, -27), to: sunday }),
    window28Previous: makeWindowTables({
      from: addDays(sunday, -55),
      to: addDays(sunday, -28),
    }),
    weeks,
    month: null,
    siteSearch: null,
    currency: null,
    measurementDegraded: false,
    ...partial,
  };
}
