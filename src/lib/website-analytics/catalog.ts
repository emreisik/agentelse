import { addDays, daysInRange } from "@/lib/website-analytics/days";

// Google Analytics ambarının rapor kataloğu (docs/google-analytics-plan.md
// §3.3). Her rapor, mülk günü (`date` boyutu) başına bir GaReportSlice olarak
// saklanır; KPI'lar her zaman GaDailyTotal'dan (totals raporu) gelir.
// Demografik ve kitle boyutları bilinçli olarak yoktur (eşikleme ve gizlilik).
// Bir isteğe en çok 9 boyut ve 10 metrik sığar.

export const GA_TOTALS_METRICS = [
  "activeUsers",
  "newUsers",
  "sessions",
  "engagedSessions",
  "userEngagementDuration",
  // Oturum süresi toplanabilir değil; ortalama × oturum = toplam süre
  // olarak saklanır ve dönem ortalaması buradan kesin hesaplanır.
  "averageSessionDuration",
  "screenPageViews",
  "keyEvents",
  "totalRevenue",
  "transactions",
] as const;
export type GaTotalsMetric = (typeof GA_TOTALS_METRICS)[number];

export const GA_REPORT_KEYS = [
  "channel",
  "source_medium",
  "campaign",
  "landing_page",
  "page",
  "events",
  "key_events_channel",
  "attribution",
  "device_country",
  "new_returning",
] as const;
export type GaReportKey = (typeof GA_REPORT_KEYS)[number];

// Katalog denetiminin açtığı isteğe bağlı günlük raporlar (GA-F2 bölüm 2;
// GA_CATALOG_CHECKS). GA_REPORTS'ta ve temel geri doldurmada yoktur.
export const GA_OPTIONAL_DAILY_KEYS = ["google_ads"] as const;
export type GaOptionalDailyKey = (typeof GA_OPTIONAL_DAILY_KEYS)[number];

// GA Data API FilterExpression (JSON olduğu gibi gönderilir).
export type GaFilterExpression = Record<string, unknown>;

export type GaReportSpec = {
  key: GaReportKey | GaOptionalDailyKey;
  // Boyut/metrik listesi değişince artar; eski dilimler okunurken ayrılır.
  version: number;
  // `date` her isteğe ayrıca eklenir.
  dimensions: readonly string[];
  metrics: readonly string[];
  // Gün başına satırlar bu metriğe göre azalan sıralanır ve kırpılır.
  orderBy: string;
  // Gün başına tutulan en çok satır; null = hepsi.
  rowsPerDay: number | null;
  filter?: GaFilterExpression;
  // Günlük çekimde her gün yeniden çekilen geçmiş gün sayısı (D-1…D-n).
  revisionDays: number;
  // Günlük dilimlerin saklama süresi.
  retentionDays: number;
  // Bağlanınca geriye doğru doldurulan gün sayısı.
  backfillDays: number;
  // Geri doldurmada tek isteğin kapsadığı gün sayısı.
  chunkDays: number;
  // Saklanmadan önce PII süzgecinden geçen boyutlar (sayfa yolu, başlık).
  pathDimensions: readonly string[];
};

const LONG = {
  revisionDays: 7,
  retentionDays: 400,
  backfillDays: 400,
  chunkDays: 90,
} as const;
// Yüksek kardinaliteli raporlar: günlük 95 gün (haftalık dilimler sonraki fazda).
const SHORT = {
  revisionDays: 7,
  retentionDays: 95,
  backfillDays: 95,
  chunkDays: 30,
} as const;

// Kampanya raporunda kampanya olmayan sahte adlar.
const NOT_CAMPAIGNS = ["(not set)", "(organic)", "(direct)", "(referral)"];

export const GA_REPORTS: readonly GaReportSpec[] = [
  {
    key: "channel",
    version: 1,
    dimensions: ["sessionDefaultChannelGroup"],
    metrics: [
      "sessions",
      "engagedSessions",
      "activeUsers",
      "newUsers",
      "keyEvents",
      "totalRevenue",
    ],
    orderBy: "sessions",
    rowsPerDay: null,
    ...LONG,
    pathDimensions: [],
  },
  {
    key: "source_medium",
    version: 1,
    dimensions: ["sessionSource", "sessionMedium"],
    metrics: ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
    orderBy: "sessions",
    rowsPerDay: 250,
    ...SHORT,
    pathDimensions: [],
  },
  {
    key: "campaign",
    version: 1,
    dimensions: [
      "sessionCampaignName",
      "sessionSource",
      "sessionMedium",
      "sessionManualAdContent",
    ],
    metrics: ["sessions", "engagedSessions", "keyEvents", "totalRevenue"],
    orderBy: "sessions",
    rowsPerDay: 250,
    filter: {
      notExpression: {
        filter: {
          fieldName: "sessionCampaignName",
          inListFilter: { values: NOT_CAMPAIGNS },
        },
      },
    },
    ...SHORT,
    pathDimensions: [],
  },
  {
    key: "landing_page",
    version: 1,
    dimensions: ["landingPage"],
    metrics: [
      "sessions",
      "engagedSessions",
      "keyEvents",
      "totalRevenue",
      "userEngagementDuration",
    ],
    orderBy: "sessions",
    rowsPerDay: 500,
    ...SHORT,
    pathDimensions: ["landingPage"],
  },
  {
    key: "page",
    version: 1,
    dimensions: ["pagePath", "pageTitle"],
    metrics: ["screenPageViews", "activeUsers", "userEngagementDuration"],
    orderBy: "screenPageViews",
    rowsPerDay: 500,
    ...SHORT,
    pathDimensions: ["pagePath", "pageTitle"],
  },
  {
    key: "events",
    version: 1,
    dimensions: ["eventName", "isKeyEvent"],
    metrics: ["eventCount", "keyEvents", "totalUsers"],
    orderBy: "eventCount",
    rowsPerDay: null,
    ...LONG,
    pathDimensions: [],
  },
  {
    key: "key_events_channel",
    version: 1,
    dimensions: ["sessionDefaultChannelGroup", "eventName"],
    metrics: ["keyEvents", "totalRevenue"],
    orderBy: "keyEvents",
    rowsPerDay: null,
    filter: {
      filter: {
        fieldName: "isKeyEvent",
        stringFilter: { matchType: "EXACT", value: "true" },
      },
    },
    ...LONG,
    pathDimensions: [],
  },
  {
    // Olay kapsamlı: key event'in hangi kanala yazıldığı mülkün atıf
    // modeliyle hesaplanır ve 12 güne kadar değişebilir.
    key: "attribution",
    version: 1,
    dimensions: ["defaultChannelGroup"],
    metrics: ["keyEvents", "totalRevenue"],
    orderBy: "keyEvents",
    rowsPerDay: null,
    ...LONG,
    revisionDays: 13,
    pathDimensions: [],
  },
  {
    key: "device_country",
    version: 1,
    dimensions: ["deviceCategory", "country"],
    metrics: ["sessions", "engagedSessions", "keyEvents"],
    orderBy: "sessions",
    rowsPerDay: 100,
    ...SHORT,
    pathDimensions: [],
  },
  {
    key: "new_returning",
    version: 1,
    dimensions: ["newVsReturning"],
    metrics: ["activeUsers", "sessions", "keyEvents"],
    orderBy: "sessions",
    rowsPerDay: null,
    ...LONG,
    pathDimensions: [],
  },
];

// Google Ads kampanya maliyeti (mülk Google Ads'e bağlıysa ve katalog
// denetimi alanları uyumlu bulduysa açılır). Günlük, 400 gün; geri doldurma
// temel geçmişten sonra eklenti durumuyla (addon-backfill.ts) yapılır.
export const GA_OPTIONAL_DAILY_REPORTS: readonly GaReportSpec[] = [
  {
    key: "google_ads",
    version: 1,
    dimensions: ["sessionGoogleAdsCampaignName"],
    metrics: [
      "advertiserAdCost",
      "advertiserAdClicks",
      "sessions",
      "keyEvents",
      "totalRevenue",
    ],
    orderBy: "advertiserAdCost",
    rowsPerDay: 100,
    filter: {
      notExpression: {
        filter: {
          fieldName: "sessionGoogleAdsCampaignName",
          inListFilter: { values: ["(not set)"] },
        },
      },
    },
    ...LONG,
    pathDimensions: [],
  },
];

// Önce temel katalog, sonra isteğe bağlı günlük raporlar.
export function gaReportSpec(key: string): GaReportSpec | undefined {
  return (
    GA_REPORTS.find((spec) => spec.key === key) ??
    GA_OPTIONAL_DAILY_REPORTS.find((spec) => spec.key === key)
  );
}

export const GA_TOTALS_SCHEDULE = LONG;

// Dönem kullanıcıları günlük değerlerden toplanamaz (aynı kişi her gün
// sayılır): standart pencereler için her gün ayrı bir istek tutulur.
export const ROLLING_USERS_KEY = "rolling_users";
export const ROLLING_WINDOWS = [7, 28, 90] as const;
export type RollingWindow = (typeof ROLLING_WINDOWS)[number];
export const ROLLING_USERS_RETENTION_DAYS = 95;
export const ROLLING_USERS_METRICS = [
  "activeUsers",
  "newUsers",
  "totalUsers",
] as const;

// Data API istek gövdesi (yalnız kullandığımız alanlar).
export type GaRunReportRequest = {
  dateRanges: { startDate: string; endDate: string; name?: string }[];
  dimensions?: { name: string }[];
  metrics: { name: string }[];
  dimensionFilter?: GaFilterExpression;
  orderBys?: Record<string, unknown>[];
  limit?: number;
  keepEmptyRows?: boolean;
  returnPropertyQuota?: boolean;
};

// Tek istekte istenen en çok satır (Google sınırı 250.000).
export const GA_MAX_ROWS = 100_000;

export function totalsRequest(
  startDate: string,
  endDate: string,
): GaRunReportRequest {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: GA_TOTALS_METRICS.map((name) => ({ name })),
    limit: Math.min(GA_MAX_ROWS, daysInRange(startDate, endDate) + 10),
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
}

// Satırlar ana metriğe göre bütün aralıkta azalan gelir; gün başına kırpma
// yerelde yapılır (gün sırasına göre sıralamak, sınıra takılınca son günleri
// tümden düşürürdü).
export function sliceRequest(
  spec: GaReportSpec,
  startDate: string,
  endDate: string,
): GaRunReportRequest {
  const days = daysInRange(startDate, endDate);
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [
      { name: "date" },
      ...spec.dimensions.map((name) => ({ name })),
    ],
    metrics: spec.metrics.map((name) => ({ name })),
    ...(spec.filter ? { dimensionFilter: spec.filter } : {}),
    orderBys: [{ metric: { metricName: spec.orderBy }, desc: true }],
    limit: spec.rowsPerDay
      ? Math.min(GA_MAX_ROWS, spec.rowsPerDay * days * 2)
      : GA_MAX_ROWS,
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
}

// Pencere adı "d7", "d28", "d90"; birden çok aralıkta Google satırlara
// `dateRange` boyutunu kendisi ekler.
export function rollingUsersRequest(endDate: string): GaRunReportRequest {
  return {
    dateRanges: ROLLING_WINDOWS.map((days) => ({
      startDate: addDays(endDate, -(days - 1)),
      endDate,
      name: `d${days}`,
    })),
    metrics: ROLLING_USERS_METRICS.map((name) => ({ name })),
    keepEmptyRows: true,
    returnPropertyQuota: true,
  };
}

// Tamamlanmış ayların tekil kullanıcıları (en çok 4 ay tek istekte).
export function monthlyUsersRequest(
  months: { start: string; end: string }[],
): GaRunReportRequest {
  return {
    dateRanges: months.slice(0, 4).map((month) => ({
      startDate: month.start,
      endDate: month.end,
      name: `m${month.start.slice(0, 7)}`,
    })),
    metrics: ROLLING_USERS_METRICS.map((name) => ({ name })),
    keepEmptyRows: true,
    returnPropertyQuota: true,
  };
}
