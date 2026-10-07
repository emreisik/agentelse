import { describe, expect, it } from "vitest";

import { ATTRIBUTION_COPY } from "./copy";
import { agentelseReportSection } from "./report-section";
import type {
  FromAgentelseRow,
  FromAgentelseView,
  GoogleAdsViewRow,
  MetaVsGaRow,
  WebsiteAttributionView,
} from "./types";
import { REPORT_CAPS } from "../reports/types";

// Bu dosyanın kanıtladığı: para sütunları yalnız Meta ve GA para birimi aynıysa
// girer (yoksa not düşer), izlenmeyen satırlar dışarıda kalır, üst sınırlar
// uygulanır, boş görünüm null olur ve ROAS sütunu yoktur.

const RANGE = { from: "2026-09-21", to: "2026-09-27" };

function fromRow(index: number, revenue = 0): FromAgentelseRow {
  return {
    key: `link:${index}`,
    label: `Link ${index}`,
    kindLabel: "Meta ads",
    channel: "meta_ads",
    sessions: 100 + index,
    engagementRate: 55.55,
    keyEvents: index,
    revenue,
  };
}

function from(rows: FromAgentelseRow[]): FromAgentelseView {
  return {
    range: RANGE,
    currency: "EUR",
    rows,
    other: null,
    total: { sessions: 500, engagementRate: 50, keyEvents: 5, revenue: 0 },
    sitePct: null,
    trackedLinks: rows.length,
    days: 7,
    coveredDays: 7,
    truncated: false,
    notes: [],
  };
}

function metaRow(index: number, tracked = true): MetaVsGaRow {
  return {
    groupKey: `meta:${index}`,
    campaignExternalId: String(index),
    label: `Campaign ${index}`,
    tracked,
    spend: tracked ? 100.456 : null,
    linkClicks: tracked ? 300 : null,
    sessions: 200,
    clickToSessionPct: null,
    results: tracked ? 12 : null,
    resultLabel: null,
    websiteResults: true,
    keyEvents: 10,
    costPerResult: null,
    costPerKeyEvent: tracked ? 10.0456 : null,
    flags: [],
  };
}

function metaView(
  rows: MetaVsGaRow[],
  currency: string | null = "EUR",
): WebsiteAttributionView {
  return {
    from: null,
    ads: {
      range: RANGE,
      meta: { currency, gaCurrency: "EUR", synced: true, rows, notes: [] },
      googleAds: null,
    },
  };
}

function googleRow(index: number): GoogleAdsViewRow {
  return {
    campaign: `G ${index}`,
    cost: 10.126,
    clicks: 40.4,
    sessions: 30,
    keyEvents: 3,
    revenue: 99.999,
    roas: 9.9,
    costPerKeyEvent: 3.375,
    previousRoas: null,
    previousCostPerKeyEvent: null,
  };
}

describe("agentelseReportSection", () => {
  it("returns null for an empty view", () => {
    expect(
      agentelseReportSection({ view: { from: null, ads: null }, gaCurrency: "EUR" }),
    ).toBeNull();
    expect(
      agentelseReportSection({
        view: { from: from([]), ads: null },
        gaCurrency: "EUR",
      }),
    ).toBeNull();
  });

  it("builds the tracked table with rounded numbers and no revenue column", () => {
    const section = agentelseReportSection({
      view: { from: from([fromRow(1)]), ads: null },
      gaCurrency: "EUR",
    });
    expect(section?.tracked?.columns.map((column) => column.label)).toEqual([
      "Sessions (GA4)",
      "Engagement rate",
      "Key events (GA4)",
    ]);
    expect(section?.tracked?.columns.map((column) => column.format)).toEqual([
      "count",
      "percent",
      "count",
    ]);
    expect(section?.tracked?.rows[0]).toEqual({
      label: "Meta ads: Link 1",
      values: [101, 55.6, 1],
    });
    expect(section?.ads).toBeNull();
    expect(section?.notes).toEqual([ATTRIBUTION_COPY.trackedOnly]);
  });

  it("adds revenue when there is any, and the other row", () => {
    const view = from([fromRow(1, 20.256)]);
    view.other = {
      sessions: 7.4,
      engagementRate: null,
      keyEvents: 1,
      revenue: 0,
    };
    const section = agentelseReportSection({
      view: { from: view, ads: null },
      gaCurrency: "EUR",
    });
    expect(section?.tracked?.columns.at(-1)).toEqual({
      label: "Revenue (GA4)",
      format: "money",
    });
    expect(section?.tracked?.rows[0]?.values.at(-1)).toBe(20.26);
    expect(section?.tracked?.other).toEqual([7, null, 1, 0]);
  });

  it("caps the tracked rows", () => {
    const rows = Array.from({ length: 12 }, (_, index) => fromRow(index));
    const section = agentelseReportSection({
      view: { from: from(rows), ads: null },
      gaCurrency: "EUR",
    });
    expect(section?.tracked?.rows).toHaveLength(REPORT_CAPS.agentelse);
  });

  it("adds money columns only when the currencies match", () => {
    const same = agentelseReportSection({
      view: metaView([metaRow(1)]),
      gaCurrency: "EUR",
    });
    expect(same?.ads?.columns.map((column) => column.label)).toEqual([
      "Spend (Meta)",
      "Link clicks (Meta)",
      "Sessions (GA4)",
      "Results (Meta)",
      "Key events (GA4)",
      "Cost per key event (GA4)",
    ]);
    expect(same?.ads?.rows[0]?.values).toEqual([100.46, 300, 200, 12, 10, 10.05]);
    expect(same?.notes).toContain(ATTRIBUTION_COPY.metaWindowNote);
    expect(same?.notes).toContain(ATTRIBUTION_COPY.adLevelNote);

    const other = agentelseReportSection({
      view: metaView([metaRow(1)]),
      gaCurrency: "USD",
    });
    expect(other?.ads?.columns.map((column) => column.label)).toEqual([
      "Link clicks (Meta)",
      "Sessions (GA4)",
      "Results (Meta)",
      "Key events (GA4)",
    ]);
    expect(other?.ads?.rows[0]?.values).toEqual([300, 200, 12, 10]);
    expect(other?.notes).toContain(ATTRIBUTION_COPY.currencyNote("EUR", "USD"));
  });

  it("explains mixed Meta currencies", () => {
    const section = agentelseReportSection({
      view: metaView([metaRow(1)], null),
      gaCurrency: "EUR",
    });
    expect(section?.ads?.columns).toHaveLength(4);
    expect(section?.notes).toContain(ATTRIBUTION_COPY.mixedCurrency);
  });

  it("leaves untracked rows out and honours the cap", () => {
    const rows = [
      metaRow(1, false),
      ...Array.from({ length: 8 }, (_, index) => metaRow(index + 2)),
    ];
    const section = agentelseReportSection({
      view: metaView(rows),
      gaCurrency: "EUR",
    });
    expect(section?.ads?.rows).toHaveLength(REPORT_CAPS.agentelseAds);
    expect(section?.ads?.rows.map((row) => row.label)).not.toContain("Campaign 1");
    const onlyUntracked = agentelseReportSection({
      view: metaView([metaRow(1, false)]),
      gaCurrency: "EUR",
    });
    expect(onlyUntracked).toBeNull();
  });

  it("builds a Google Ads table without ROAS", () => {
    const section = agentelseReportSection({
      view: {
        from: null,
        ads: {
          range: RANGE,
          meta: null,
          googleAds: {
            currency: "EUR",
            rows: Array.from({ length: 8 }, (_, index) => googleRow(index)),
            notes: [],
          },
        },
      },
      gaCurrency: "EUR",
    });
    const table = section?.googleAds;
    expect(table?.rows).toHaveLength(5);
    expect(table?.columns.map((column) => column.label)).toEqual([
      "Cost",
      "Clicks",
      "Key events (GA4)",
      "Revenue (GA4)",
      "Cost per key event (GA4)",
    ]);
    expect(table?.columns.some((column) => /roas/i.test(column.label))).toBe(false);
    expect(table?.rows[0]?.values).toEqual([10.13, 40, 3, 100, 3.38]);
    expect(section?.notes).toEqual([ATTRIBUTION_COPY.trackedOnly]);
  });
});
