import { ATTRIBUTION_COPY } from "@/lib/website-analytics/attribution/copy";
import type { WebsiteAttributionView } from "@/lib/website-analytics/attribution/types";
import { round1 } from "@/lib/website-analytics/attribution/view-format";
import {
  REPORT_CAPS,
  type ReportAgentelseSection,
  type ReportTable,
} from "@/lib/website-analytics/reports/types";

// GA-F6: haftalık rapora giren "From Agentelse" bölümü. Kartın değişmez
// gövdesine girer; bu yüzden sayılar burada yuvarlanır (sayı tam, yüzde 1
// ondalık, para 2 ondalık). ROAS sütunu yoktur: ReportValueFormat'ta oran yok,
// ROAS yalnız Website sayfasında gösterilir. Saf ve izomorfik.

const COLUMNS = ATTRIBUTION_COPY.columns;

function whole(value: number): number {
  return Math.round(value);
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function wholeOrNull(value: number | null): number | null {
  return value === null ? null : whole(value);
}

function centsOrNull(value: number | null): number | null {
  return value === null ? null : cents(value);
}

function trackedTable(
  from: NonNullable<WebsiteAttributionView["from"]>,
): ReportTable | null {
  const rows = from.rows.slice(0, REPORT_CAPS.agentelse);
  const other = from.other;
  if (rows.length === 0 && !other) return null;
  const revenue =
    from.total.revenue > 0 ||
    rows.some((row) => row.revenue > 0) ||
    (other?.revenue ?? 0) > 0;
  const valuesOf = (value: {
    sessions: number;
    engagementRate: number | null;
    keyEvents: number;
    revenue: number;
  }): (number | null)[] => [
    whole(value.sessions),
    value.engagementRate === null ? null : round1(value.engagementRate),
    whole(value.keyEvents),
    ...(revenue ? [cents(value.revenue)] : []),
  ];
  return {
    columns: [
      { label: COLUMNS.sessions, format: "count" },
      { label: COLUMNS.engagement, format: "percent" },
      { label: COLUMNS.keyEvents, format: "count" },
      ...(revenue ? [{ label: COLUMNS.revenue, format: "money" as const }] : []),
    ],
    rows: rows.map((row) => ({
      label: `${row.kindLabel}: ${row.label}`,
      values: valuesOf(row),
    })),
    other: other ? valuesOf(other) : null,
    notes: [],
  };
}

type AdsResult = { table: ReportTable | null; currencyNote: string | null };

function adsTable(
  meta: NonNullable<NonNullable<WebsiteAttributionView["ads"]>["meta"]>,
  gaCurrency: string | null,
): AdsResult {
  const rows = meta.rows
    .filter((row) => row.tracked)
    .slice(0, REPORT_CAPS.agentelseAds);
  if (rows.length === 0) return { table: null, currencyNote: null };
  // Para sütunları yalnız Meta ve GA para birimi aynıysa girer.
  const sameCurrency = meta.currency !== null && meta.currency === gaCurrency;
  const currencyNote = sameCurrency
    ? null
    : meta.currency === null
      ? ATTRIBUTION_COPY.mixedCurrency
      : ATTRIBUTION_COPY.currencyNote(meta.currency, gaCurrency ?? "unknown");
  return {
    table: {
      columns: [
        ...(sameCurrency
          ? [{ label: COLUMNS.spend, format: "money" as const }]
          : []),
        { label: COLUMNS.linkClicks, format: "count" },
        { label: COLUMNS.sessions, format: "count" },
        { label: COLUMNS.results, format: "count" },
        { label: COLUMNS.keyEvents, format: "count" },
        ...(sameCurrency
          ? [{ label: COLUMNS.costPerKeyEvent, format: "money" as const }]
          : []),
      ],
      rows: rows.map((row) => ({
        label: row.label,
        values: [
          ...(sameCurrency ? [centsOrNull(row.spend)] : []),
          wholeOrNull(row.linkClicks),
          whole(row.sessions),
          wholeOrNull(row.results),
          whole(row.keyEvents),
          ...(sameCurrency ? [centsOrNull(row.costPerKeyEvent)] : []),
        ],
      })),
      other: null,
      notes: [],
    },
    currencyNote,
  };
}

function googleAdsReportTable(
  googleAds: NonNullable<NonNullable<WebsiteAttributionView["ads"]>["googleAds"]>,
): ReportTable | null {
  const rows = googleAds.rows.slice(0, REPORT_CAPS.agentelseAds);
  if (rows.length === 0) return null;
  return {
    columns: [
      { label: COLUMNS.cost, format: "money" },
      { label: COLUMNS.clicks, format: "count" },
      { label: COLUMNS.keyEvents, format: "count" },
      { label: COLUMNS.revenue, format: "money" },
      { label: COLUMNS.costPerKeyEvent, format: "money" },
    ],
    rows: rows.map((row) => ({
      label: row.campaign,
      values: [
        cents(row.cost),
        whole(row.clicks),
        whole(row.keyEvents),
        cents(row.revenue),
        centsOrNull(row.costPerKeyEvent),
      ],
    })),
    other: null,
    notes: [],
  };
}

export function agentelseReportSection(input: {
  view: WebsiteAttributionView;
  gaCurrency: string | null;
}): ReportAgentelseSection | null {
  const { view, gaCurrency } = input;
  const tracked = view.from ? trackedTable(view.from) : null;
  const ads = view.ads?.meta
    ? adsTable(view.ads.meta, gaCurrency)
    : { table: null, currencyNote: null };
  const googleAds = view.ads?.googleAds
    ? googleAdsReportTable(view.ads.googleAds)
    : null;
  if (!tracked && !ads.table && !googleAds) return null;
  const notes: string[] = [ATTRIBUTION_COPY.trackedOnly];
  if (ads.table) {
    notes.push(ATTRIBUTION_COPY.metaWindowNote, ATTRIBUTION_COPY.adLevelNote);
    if (ads.currencyNote) notes.push(ads.currencyNote);
  }
  return { tracked, ads: ads.table, googleAds, notes };
}
