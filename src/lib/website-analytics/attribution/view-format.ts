import {
  formatCount,
  formatMoney,
  formatPercent,
} from "@/lib/module-flows/analytics/format";
import { ATTRIBUTION_COPY } from "@/lib/website-analytics/attribution/copy";
import type {
  AdsOnWebsiteView,
  CrossCheckFlag,
  FromAgentelseView,
} from "@/lib/website-analytics/attribution/types";

// GA-F6 tabloları için ekranda gösterilecek metin biçimi. Biçimleme burada
// yapılır; bileşen yalnız çizer. Saf ve istemci güvenli.

export type DisplayTable = {
  title: string;
  hint: string | null;
  firstColumn: string;
  columns: { label: string }[];
  rows: {
    key: string;
    label: string;
    sublabel: string | null;
    cells: string[];
    flags: { label: string; tone: "warn" | "info" }[];
  }[];
  other: { label: string; cells: string[] } | null;
  notes: string[];
  empty: string;
};

const DASH = "—";
const COLUMNS = ATTRIBUTION_COPY.columns;

// formatPercent ondalık parametresi almaz: önce 1 ondalığa yuvarlanır.
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function count(value: number | null): string {
  return value === null ? DASH : formatCount(value);
}

function percent(value: number | null): string {
  return value === null ? DASH : formatPercent(round1(value));
}

function money(value: number | null, currency: string | null): string {
  return value === null ? DASH : formatMoney(value, currency);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item.length > 0))];
}

export function fromAgentelseTable(view: FromAgentelseView): DisplayTable {
  const showRevenue =
    view.total.revenue > 0 ||
    view.rows.some((row) => row.revenue > 0) ||
    (view.other?.revenue ?? 0) > 0;
  const columns = [
    { label: COLUMNS.sessions },
    { label: COLUMNS.engagement },
    { label: COLUMNS.keyEvents },
    ...(showRevenue ? [{ label: COLUMNS.revenue }] : []),
  ];
  const cellsOf = (value: {
    sessions: number;
    engagementRate: number | null;
    keyEvents: number;
    revenue: number;
  }): string[] => [
    count(value.sessions),
    percent(value.engagementRate),
    count(value.keyEvents),
    ...(showRevenue ? [money(value.revenue, view.currency)] : []),
  ];
  const notes = [...view.notes];
  if (view.sitePct !== null) {
    notes.push(`${formatPercent(round1(view.sitePct))} of all sessions in this period`);
  }
  return {
    title: ATTRIBUTION_COPY.fromTitle,
    hint: ATTRIBUTION_COPY.fromHint,
    firstColumn: "Source",
    columns,
    rows: view.rows.map((row) => ({
      key: row.key,
      label: row.label,
      sublabel: row.kindLabel,
      cells: cellsOf(row),
      flags: [],
    })),
    other: view.other
      ? { label: ATTRIBUTION_COPY.otherTagged, cells: cellsOf(view.other) }
      : null,
    notes: unique(notes),
    empty: "No visits through tagged links in this period yet.",
  };
}

function flagOf(flag: CrossCheckFlag): { label: string; tone: "warn" | "info" } {
  return flag === "click_loss"
    ? { label: ATTRIBUTION_COPY.clickLossFlag, tone: "warn" }
    : { label: ATTRIBUTION_COPY.resultsGapFlag, tone: "info" };
}

export function metaVsGaTable(
  meta: NonNullable<AdsOnWebsiteView["meta"]>,
): DisplayTable {
  return {
    title: ATTRIBUTION_COPY.adsTitle,
    hint: ATTRIBUTION_COPY.metaWindowNote,
    firstColumn: "Campaign",
    columns: [
      { label: COLUMNS.spend },
      { label: COLUMNS.linkClicks },
      { label: COLUMNS.sessions },
      { label: COLUMNS.clickToSession },
      { label: COLUMNS.results },
      { label: COLUMNS.keyEvents },
      { label: COLUMNS.costPerResult },
      { label: COLUMNS.costPerKeyEvent },
    ],
    rows: meta.rows.map((row) => ({
      key: row.groupKey,
      label: row.label,
      sublabel: row.tracked ? row.resultLabel : ATTRIBUTION_COPY.metaPending,
      cells: [
        money(row.spend, meta.currency),
        count(row.linkClicks),
        count(row.sessions),
        percent(row.clickToSessionPct),
        count(row.results),
        count(row.keyEvents),
        money(row.costPerResult, meta.currency),
        money(row.costPerKeyEvent, meta.currency),
      ],
      flags: row.flags.map(flagOf),
    })),
    other: null,
    notes: unique(meta.notes),
    empty: ATTRIBUTION_COPY.notSynced,
  };
}

export function googleAdsTable(
  googleAds: NonNullable<AdsOnWebsiteView["googleAds"]>,
): DisplayTable {
  return {
    title: ATTRIBUTION_COPY.googleAdsTitle,
    hint: ATTRIBUTION_COPY.googleAdsNote,
    firstColumn: "Campaign",
    columns: [
      { label: COLUMNS.cost },
      { label: COLUMNS.clicks },
      { label: COLUMNS.sessions },
      { label: COLUMNS.keyEvents },
      { label: COLUMNS.revenue },
      { label: COLUMNS.roas },
      { label: COLUMNS.costPerKeyEvent },
    ],
    rows: googleAds.rows.map((row) => ({
      key: row.campaign,
      label: row.campaign,
      sublabel: null,
      cells: [
        money(row.cost, googleAds.currency),
        count(row.clicks),
        count(row.sessions),
        count(row.keyEvents),
        money(row.revenue, googleAds.currency),
        row.roas === null ? DASH : `${row.roas.toFixed(2)}×`,
        money(row.costPerKeyEvent, googleAds.currency),
      ],
      flags: [],
    })),
    other: null,
    notes: unique(googleAds.notes),
    empty: "No Google Ads traffic in this period.",
  };
}
