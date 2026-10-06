import {
  GA_MAX_ROWS,
  GA_REPORTS,
  type GaFilterExpression,
  type GaRunReportRequest,
} from "./catalog";
import { addDays } from "./days";
import type { GaParsedReport } from "./response";
import { splitReportByPeriod, type GaDaySlice } from "./slices";
import {
  isoWeekMonday,
  mondayOfIsoYearIsoWeek,
  mondaysBetween,
  weekSunday,
} from "./weeks";

// Haftalık dilimler (docs/google-analytics-plan.md §3.3 "Haftalık dilimler",
// GA-F2 bölüm 2; GA_WEEKLY ve GA_CATALOG_CHECKS). Yüksek kardinaliteli
// raporların günlük dilimleri 95 gün tutulur; 400 güne kadar haftalık
// (grain WEEK, periodStart = ISO Pazartesi) özetler saklanır. Yalnız
// kesinleşmiş haftalar çekilir (Pazar ≤ D-8: revizyon penceresi + 1) ve bir
// daha çekilmez. site_search (sitede aranan sözcükler) yalnız haftalıktır,
// search_console ise Pazar'da biten 28 günlük tek pencere olarak saklanır.
// Okuyucular günleri ve haftaları planSliceSources ile birleştirir: hiçbir
// gün iki kez sayılmaz. Saf modül.

export const GA_WEEKLY_BREAKDOWN_KEYS = [
  "source_medium",
  "campaign",
  "landing_page",
  "page",
  "device_country",
] as const;
export type GaWeeklyBreakdownKey = (typeof GA_WEEKLY_BREAKDOWN_KEYS)[number];
export const SITE_SEARCH_KEY = "site_search";
export const SEARCH_CONSOLE_KEY = "search_console";
export const GA_WEEKLY_RETENTION_DAYS = 400;

export type GaWeeklySpec = {
  key: GaWeeklyBreakdownKey | typeof SITE_SEARCH_KEY;
  version: number;
  // `isoYearIsoWeek` her isteğe ayrıca eklenir.
  dimensions: readonly string[];
  metrics: readonly string[];
  orderBy: string;
  // Hafta başına tutulan en çok satır.
  rowsPerWeek: number;
  filter?: GaFilterExpression;
  retentionDays: number;
  // Tek isteğin kapsadığı hafta sayısı: tek yanıt ≤ 6.000 satır.
  chunkWeeks: number;
  // Hafta, Pazar'ı today-lagDays'ten sonra değilse çekilir.
  lagDays: number;
  pathDimensions: readonly string[];
};

const BREAKDOWN_LAG_DAYS = 8;
const SITE_SEARCH_LAG_DAYS = 3;

function chunkWeeksFor(rowsPerWeek: number): number {
  return rowsPerWeek >= 500 ? 6 : 13;
}

// Haftalık kırılımlar günlük katalogdan türetilir (aynı sürüm, boyut, metrik,
// süzgeç ve maskeleme).
const BREAKDOWNS: GaWeeklySpec[] = GA_WEEKLY_BREAKDOWN_KEYS.map((key) => {
  const base = GA_REPORTS.find((spec) => spec.key === key);
  if (!base) throw new Error(`GA weekly report ${key} has no daily spec`);
  const rowsPerWeek = base.rowsPerDay ?? 250;
  return {
    key,
    version: base.version,
    dimensions: base.dimensions,
    metrics: base.metrics,
    orderBy: base.orderBy,
    rowsPerWeek,
    ...(base.filter ? { filter: base.filter } : {}),
    retentionDays: GA_WEEKLY_RETENTION_DAYS,
    chunkWeeks: chunkWeeksFor(rowsPerWeek),
    lagDays: BREAKDOWN_LAG_DAYS,
    pathDimensions: base.pathDimensions,
  };
});

export const GA_WEEKLY_REPORTS: readonly GaWeeklySpec[] = [
  ...BREAKDOWNS,
  {
    // Günlük karşılığı yok: tazelik için 3 gün gecikme yeter.
    key: SITE_SEARCH_KEY,
    version: 1,
    dimensions: ["searchTerm"],
    metrics: ["eventCount"],
    orderBy: "eventCount",
    rowsPerWeek: 200,
    filter: {
      filter: {
        fieldName: "eventName",
        stringFilter: { matchType: "EXACT", value: "view_search_results" },
      },
    },
    retentionDays: GA_WEEKLY_RETENTION_DAYS,
    chunkWeeks: 13,
    lagDays: SITE_SEARCH_LAG_DAYS,
    pathDimensions: ["searchTerm"],
  },
];

export function gaWeeklySpec(key: string): GaWeeklySpec | undefined {
  return GA_WEEKLY_REPORTS.find((spec) => spec.key === key);
}

// Katalogdaki düşürme anahtarı: kırılımlar yalnız haftalık çekimi durduran
// "week:<k>" ile, site_search kendi adıyla düşer.
export function weeklyDisableKey(spec: GaWeeklySpec): string {
  return spec.key === SITE_SEARCH_KEY ? SITE_SEARCH_KEY : `week:${spec.key}`;
}

export type GaWindowSpec = {
  key: typeof SEARCH_CONSOLE_KEY;
  version: 1;
  dimensions: readonly ["landingPagePlusQueryString"];
  metrics: readonly [
    "organicGoogleSearchClicks",
    "organicGoogleSearchImpressions",
    "organicGoogleSearchAveragePosition",
  ];
  // CTR ve ortalama pozisyon saklanmaz: birleşen satırlar kesin kalsın diye
  // tıklama, gösterim ve gösterim ağırlıklı pozisyon tutulur.
  storedMetrics: readonly [
    "organicGoogleSearchClicks",
    "organicGoogleSearchImpressions",
    "positionWeighted",
  ];
  orderBy: "organicGoogleSearchClicks";
  rows: 500;
  windowDays: 28;
  lagDays: 3;
  retentionDays: 95;
  pathDimensions: readonly ["landingPagePlusQueryString"];
};

export const GA_WINDOW_REPORTS: readonly GaWindowSpec[] = [
  {
    key: SEARCH_CONSOLE_KEY,
    version: 1,
    dimensions: ["landingPagePlusQueryString"],
    metrics: [
      "organicGoogleSearchClicks",
      "organicGoogleSearchImpressions",
      "organicGoogleSearchAveragePosition",
    ],
    storedMetrics: [
      "organicGoogleSearchClicks",
      "organicGoogleSearchImpressions",
      "positionWeighted",
    ],
    orderBy: "organicGoogleSearchClicks",
    rows: 500,
    windowDays: 28,
    lagDays: 3,
    retentionDays: 95,
    pathDimensions: ["landingPagePlusQueryString"],
  },
];

// [firstMonday, lastMonday] haftaları tek istekte; satırlar ana metriğe göre
// bütün aralıkta azalan gelir, hafta başına kırpma yerelde yapılır.
export function weeklySliceRequest(
  spec: GaWeeklySpec,
  firstMonday: string,
  lastMonday: string,
): GaRunReportRequest {
  const weeks = Math.max(1, mondaysBetween(firstMonday, lastMonday).length);
  return {
    dateRanges: [{ startDate: firstMonday, endDate: weekSunday(lastMonday) }],
    dimensions: [
      { name: "isoYearIsoWeek" },
      ...spec.dimensions.map((name) => ({ name })),
    ],
    metrics: spec.metrics.map((name) => ({ name })),
    ...(spec.filter ? { dimensionFilter: spec.filter } : {}),
    orderBys: [{ metric: { metricName: spec.orderBy }, desc: true }],
    limit: Math.min(GA_MAX_ROWS, spec.rowsPerWeek * weeks * 2),
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
}

// `monday` haftasının Pazar'ında biten windowDays günlük pencere; tarih
// boyutu yok.
export function windowRequest(
  spec: GaWindowSpec,
  monday: string,
): GaRunReportRequest {
  const end = weekSunday(monday);
  return {
    dateRanges: [
      { startDate: addDays(end, -(spec.windowDays - 1)), endDate: end },
    ],
    dimensions: spec.dimensions.map((name) => ({ name })),
    metrics: spec.metrics.map((name) => ({ name })),
    orderBys: [{ metric: { metricName: spec.orderBy }, desc: true }],
    limit: spec.rows * 2,
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
}

// Yanıtı haftalara böler (.day = Pazartesi); maskeleme, birleştirme, kırpma
// ve otherRow kuralları günlük bölmeyle aynıdır.
export function splitReportByWeek(
  report: GaParsedReport,
  spec: GaWeeklySpec,
  weeks: string[],
): GaDaySlice[] {
  return splitReportByPeriod(
    report,
    {
      rowLimit: spec.rowsPerWeek,
      orderBy: spec.orderBy,
      pathDimensions: spec.pathDimensions,
      periodDimension: "isoYearIsoWeek",
      periodKey: mondayOfIsoYearIsoWeek,
    },
    weeks,
  );
}

// Pencere yanıtı tek dilim olur. Gösterim ağırlıklı pozisyon (ortalama
// pozisyon × gösterim) maskeleme birleştirmesinden ÖNCE satır başına
// hesaplanır; okuyucu pozisyonu positionWeighted / gösterim olarak bulur.
export function splitWindowReport(
  report: GaParsedReport,
  spec: GaWindowSpec,
  monday: string,
): GaDaySlice {
  const at = (name: string) => report.metricHeaders.indexOf(name);
  const clicksAt = at("organicGoogleSearchClicks");
  const impressionsAt = at("organicGoogleSearchImpressions");
  const positionAt = at("organicGoogleSearchAveragePosition");
  const value = (metrics: number[], index: number) =>
    index < 0 ? 0 : (metrics[index] ?? 0);
  const stored: GaParsedReport = {
    ...report,
    metricHeaders: [...spec.storedMetrics],
    rows: report.rows.map((row) => {
      const impressions = value(row.metrics, impressionsAt);
      return {
        dimensions: row.dimensions,
        metrics: [
          value(row.metrics, clicksAt),
          impressions,
          value(row.metrics, positionAt) * impressions,
        ],
      };
    }),
  };
  const [slice] = splitReportByPeriod(
    stored,
    {
      rowLimit: spec.rows,
      orderBy: spec.orderBy,
      pathDimensions: spec.pathDimensions,
      periodDimension: null,
      periodKey: () => monday,
    },
    [monday],
  );
  return slice!;
}

export type GaSlicePlan = {
  // DAY dilimi okunacak günler (artan).
  days: string[];
  // WEEK dilimi okunacak haftaların Pazartesi'leri (artan).
  weeks: string[];
  // Ne günü ne haftası olan gün sayısı.
  missingDays: number;
  // Aralığa kısmen giren bir hafta bütünüyle sayıldı ("majority").
  approximate: boolean;
};

// Her ISO hafta için tek kaynak seçer: aralıktaki bütün günleri varsa günler;
// yoksa hafta bütünüyle aralıktaysa WEEK dilimi; yoksa olan günler (kalanlar
// eksik sayılır). Kenar haftalar varsayılan olarak dışarıda kalır; "majority"
// (yalnız ay özetleri) aralıkta ≥ 4 günü olan kısmi haftayı WEEK dilimiyle
// sayar ve planı yaklaşık işaretler. Böylece her hafta tek bir aya düşer.
export function planSliceSources(input: {
  from: string;
  to: string;
  dayKeys: ReadonlySet<string>;
  weekStarts: ReadonlySet<string>;
  edgeWeeks?: "exclude" | "majority";
}): GaSlicePlan {
  const plan: GaSlicePlan = {
    days: [],
    weeks: [],
    missingDays: 0,
    approximate: false,
  };
  if (input.from > input.to) return plan;
  for (const monday of mondaysBetween(
    isoWeekMonday(input.from),
    isoWeekMonday(input.to),
  )) {
    const inside: string[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(monday, offset);
      if (day >= input.from && day <= input.to) inside.push(day);
    }
    const present = inside.filter((day) => input.dayKeys.has(day));
    if (present.length === inside.length) {
      plan.days.push(...present);
    } else if (inside.length === 7 && input.weekStarts.has(monday)) {
      plan.weeks.push(monday);
    } else if (
      input.edgeWeeks === "majority" &&
      inside.length >= 4 &&
      input.weekStarts.has(monday)
    ) {
      plan.weeks.push(monday);
      plan.approximate = true;
    } else {
      plan.days.push(...present);
      plan.missingDays += inside.length - present.length;
    }
  }
  return plan;
}
