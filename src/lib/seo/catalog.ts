import { daysInRange } from "@/lib/website-analytics/days";

// Search Analytics istek kataloğu (docs/google-search-console-plan.md §3.3,
// §5.1). Ambarın attığı her istek buradaki kurucularla üretilir; gövde
// searchanalytics.query'nin JSON'udur. Toplamlar web/image/video/news için
// byProperty, discover/googleNews için auto ister (Google bu ikisinde
// byProperty'yi kabul etmeyebilir, doğrulanmalı). Sayfa boyutu 25.000 satır;
// Google gün başına en çok 50.000 satır verir.
//
// "Ağır" istek (plan §3.3): sorgu×sayfa ya da 90 günden uzun aralık. Load
// kotası hatasında önce bunlar durur; ambar sorgu×sayfa dışında hiçbir ağır
// istek atmaz.

export const GSC_SEARCH_TYPES = [
  "web",
  "image",
  "video",
  "news",
  "discover",
  "googleNews",
] as const;
export type GscSearchType = (typeof GSC_SEARCH_TYPES)[number];
export const GSC_OPTIONAL_TYPES: readonly GscSearchType[] =
  GSC_SEARCH_TYPES.filter((type) => type !== "web");

export type GscDimension =
  "date" | "query" | "page" | "country" | "device" | "searchAppearance";
export type GscAggregation = "auto" | "byProperty" | "byPage";
export type GscDataState = "final" | "all";
export type GscFilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "includingRegex"
  | "excludingRegex";
export type GscFilter = {
  dimension: Exclude<GscDimension, "date">;
  operator: GscFilterOperator;
  expression: string;
};

export type GscQueryRequest = {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  type: GscSearchType;
  aggregationType: GscAggregation;
  dataState: GscDataState;
  dimensionFilterGroups?: { groupType: "and"; filters: GscFilter[] }[];
  rowLimit: number;
  startRow: number;
};

export const GSC_ROW_LIMIT = 25_000;
export const GSC_DAILY_ROW_CAP = 50_000;
export const GSC_HEAVY_RANGE_DAYS = 90;
// Ülke kırılımında gün başına tutulan en büyük ülke sayısı (kalanı "other").
export const GSC_COUNTRY_TOP = 50;

export const GSC_SLICE_KINDS = ["country", "device", "appearance"] as const;
export type GscSliceKind = (typeof GSC_SLICE_KINDS)[number];
export const GSC_SLICE_DIMENSION: Readonly<Record<GscSliceKind, GscDimension>> =
  {
    country: "country",
    device: "device",
    appearance: "searchAppearance",
  };

export const GSC_PERIOD_KEYS = ["query", "page", "query_page"] as const;
export type GscPeriodKey = (typeof GSC_PERIOD_KEYS)[number];
export type GscGrain = "WEEK" | "MONTH";

// Sayfa sınırları (25.000 satırlık sayfa): sorgu ve sayfa 100 bin satır,
// sorgu×sayfa tek sayfa (ağır istek).
export const GSC_PERIOD_MAX_PAGES: Readonly<Record<GscPeriodKey, number>> = {
  query: 4,
  page: 4,
  query_page: 1,
};
export const GSC_TOTALS_MAX_PAGES = 1;
export const GSC_SLICE_MAX_PAGES = 2;

export function aggregationFor(type: GscSearchType): GscAggregation {
  return type === "discover" || type === "googleNews" ? "auto" : "byProperty";
}

function base(
  start: string,
  end: string,
  fields: Pick<
    GscQueryRequest,
    "dimensions" | "type" | "aggregationType" | "dataState"
  >,
): GscQueryRequest {
  return {
    startDate: start,
    endDate: end,
    ...fields,
    rowLimit: GSC_ROW_LIMIT,
    startRow: 0,
  };
}

// Arama türünün günlük toplamları.
export function totalsRequest(
  type: GscSearchType,
  start: string,
  end: string,
  dataState: GscDataState,
): GscQueryRequest {
  return base(start, end, {
    dimensions: ["date"],
    type,
    aggregationType: aggregationFor(type),
    dataState,
  });
}

// Marka serisi: web günlük toplamları, sorgu Google tarafında marka
// ifadesiyle süzülür (RE2; (?i) ve \p{L} desteği doğrulanmalı).
export function brandTotalsRequest(
  regex: string,
  start: string,
  end: string,
): GscQueryRequest {
  return {
    ...base(start, end, {
      dimensions: ["date"],
      type: "web",
      aggregationType: "byProperty",
      dataState: "final",
    }),
    dimensionFilterGroups: [
      {
        groupType: "and",
        filters: [
          { dimension: "query", operator: "includingRegex", expression: regex },
        ],
      },
    ],
  };
}

// Günlük kırılım (yalnız kesin günler).
export function sliceRequest(
  kind: GscSliceKind,
  start: string,
  end: string,
): GscQueryRequest {
  return base(start, end, {
    dimensions: ["date", GSC_SLICE_DIMENSION[kind]],
    type: "web",
    aggregationType: "auto",
    dataState: "final",
  });
}

// Tek günlük kırılım, tarih boyutu olmadan: Google ['date','searchAppearance']
// birleşimini reddederse gün gün yedek yol.
export function sliceDayRequest(
  kind: GscSliceKind,
  day: string,
): GscQueryRequest {
  return base(day, day, {
    dimensions: [GSC_SLICE_DIMENSION[kind]],
    type: "web",
    aggregationType: "auto",
    dataState: "final",
  });
}

// Haftalık/aylık özet istekleri (yalnız web, kesin günler).
export function periodRequest(
  key: GscPeriodKey,
  start: string,
  end: string,
): GscQueryRequest {
  if (key === "page") {
    return base(start, end, {
      dimensions: ["page"],
      type: "web",
      aggregationType: "byPage",
      dataState: "final",
    });
  }
  return base(start, end, {
    dimensions: key === "query" ? ["query"] : ["query", "page"],
    type: "web",
    aggregationType: "auto",
    dataState: "final",
  });
}

export function isHeavyRequest(request: GscQueryRequest): boolean {
  return (
    (request.dimensions.includes("query") &&
      request.dimensions.includes("page")) ||
    daysInRange(request.startDate, request.endDate) > GSC_HEAVY_RANGE_DAYS
  );
}
