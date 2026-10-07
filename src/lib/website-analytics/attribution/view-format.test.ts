import { describe, expect, it } from "vitest";

import { ATTRIBUTION_COPY } from "./copy";
import type {
  AdsOnWebsiteView,
  FromAgentelseView,
  MetaVsGaRow,
} from "./types";
import {
  fromAgentelseTable,
  googleAdsTable,
  metaVsGaTable,
  round1,
} from "./view-format";

// Bu dosyanın kanıtladığı: sütun başlıkları kaynağı taşır, null "—" yazılır,
// gelir sütunu yalnız gelir varsa görünür, bayraklar doğru çipe düşer, izlenmeyen
// satırlar "pending" alt etiketi alır ve ROAS "2.50×" biçiminde yazılır.

const RANGE = { from: "2026-09-01", to: "2026-09-28" };

function fromView(overrides: Partial<FromAgentelseView> = {}): FromAgentelseView {
  return {
    range: RANGE,
    currency: "EUR",
    rows: [
      {
        key: "meta:1",
        label: "Spring sale",
        kindLabel: "Meta ads",
        channel: "meta_ads",
        sessions: 1200,
        engagementRate: 61.234,
        keyEvents: 30,
        revenue: 0,
      },
    ],
    other: null,
    total: { sessions: 1200, engagementRate: 61.2, keyEvents: 30, revenue: 0 },
    sitePct: null,
    trackedLinks: 2,
    days: 28,
    coveredDays: 28,
    truncated: false,
    notes: [],
    ...overrides,
  };
}

function metaRow(overrides: Partial<MetaVsGaRow> = {}): MetaVsGaRow {
  return {
    groupKey: "meta:1",
    campaignExternalId: "1",
    label: "Spring sale",
    tracked: true,
    spend: 120.5,
    linkClicks: 900,
    sessions: 700,
    clickToSessionPct: 77.8,
    results: 40,
    resultLabel: "Purchases",
    websiteResults: true,
    keyEvents: 35,
    costPerResult: 3.01,
    costPerKeyEvent: 3.44,
    flags: [],
    ...overrides,
  };
}

function metaView(
  rows: MetaVsGaRow[],
): NonNullable<AdsOnWebsiteView["meta"]> {
  return { currency: "EUR", gaCurrency: "EUR", synced: true, rows, notes: [] };
}

describe("round1", () => {
  it("rounds to one decimal", () => {
    expect(round1(61.234)).toBe(61.2);
    expect(round1(61.25)).toBe(61.3);
    expect(round1(0)).toBe(0);
  });
});

describe("fromAgentelseTable", () => {
  it("labels columns with their source and hides revenue without revenue", () => {
    const table = fromAgentelseTable(fromView());
    expect(table.columns.map((column) => column.label)).toEqual([
      "Sessions (GA4)",
      "Engagement rate",
      "Key events (GA4)",
    ]);
    expect(table.title).toBe("From Agentelse");
    expect(table.firstColumn).toBe("Source");
    expect(table.rows[0]?.sublabel).toBe("Meta ads");
    expect(table.rows[0]?.cells).toEqual(["1,200", "61.2%", "30"]);
  });

  it("adds the revenue column when any row has revenue", () => {
    const table = fromAgentelseTable(
      fromView({
        rows: [{ ...fromView().rows[0]!, revenue: 450 }],
        total: { sessions: 1200, engagementRate: 61.2, keyEvents: 30, revenue: 450 },
      }),
    );
    expect(table.columns.at(-1)?.label).toBe("Revenue (GA4)");
    expect(table.rows[0]?.cells.at(-1)).toBe("450 EUR");
  });

  it("adds the revenue column when only the other row has revenue", () => {
    const table = fromAgentelseTable(
      fromView({
        other: { sessions: 10, engagementRate: null, keyEvents: 0, revenue: 12.5 },
        total: { sessions: 1210, engagementRate: 61, keyEvents: 30, revenue: 12.5 },
      }),
    );
    expect(table.columns).toHaveLength(4);
    expect(table.other?.label).toBe("Other tagged links");
    expect(table.other?.cells).toEqual(["10", "—", "0", "12.50 EUR"]);
  });

  it("prints the share of site sessions rounded to one decimal", () => {
    const table = fromAgentelseTable(fromView({ sitePct: 12.3456, notes: ["a"] }));
    expect(table.notes).toEqual(["a", "12.3% of all sessions in this period"]);
  });

  it("has an empty text", () => {
    const table = fromAgentelseTable(fromView({ rows: [] }));
    expect(table.rows).toEqual([]);
    expect(table.empty).toBe("No visits through tagged links in this period yet.");
  });
});

describe("metaVsGaTable", () => {
  it("orders source-labelled columns", () => {
    const table = metaVsGaTable(metaView([metaRow()]));
    expect(table.firstColumn).toBe("Campaign");
    expect(table.columns.map((column) => column.label)).toEqual([
      "Spend (Meta)",
      "Link clicks (Meta)",
      "Sessions (GA4)",
      "Clicks → sessions",
      "Results (Meta)",
      "Key events (GA4)",
      "Cost per result (Meta)",
      "Cost per key event (GA4)",
    ]);
    expect(table.rows[0]?.cells).toEqual([
      "120.50 EUR",
      "900",
      "700",
      "77.8%",
      "40",
      "35",
      "3.01 EUR",
      "3.44 EUR",
    ]);
    expect(table.rows[0]?.sublabel).toBe("Purchases");
  });

  it("prints a dash for null values and marks untracked rows as pending", () => {
    const table = metaVsGaTable(
      metaView([
        metaRow({
          tracked: false,
          spend: null,
          linkClicks: null,
          clickToSessionPct: null,
          results: null,
          resultLabel: null,
          costPerResult: null,
          costPerKeyEvent: null,
        }),
      ]),
    );
    const row = table.rows[0]!;
    expect(row.sublabel).toBe(ATTRIBUTION_COPY.metaPending);
    expect(row.cells[0]).toBe("—");
    expect(row.cells[1]).toBe("—");
    expect(row.cells[3]).toBe("—");
    expect(row.cells[7]).toBe("—");
    expect(row.flags).toEqual([]);
  });

  it("maps flags to chips", () => {
    const table = metaVsGaTable(
      metaView([metaRow({ flags: ["click_loss", "results_gap"] })]),
    );
    expect(table.rows[0]?.flags).toEqual([
      { label: ATTRIBUTION_COPY.clickLossFlag, tone: "warn" },
      { label: ATTRIBUTION_COPY.resultsGapFlag, tone: "info" },
    ]);
  });

  it("carries the notes and an empty text", () => {
    const table = metaVsGaTable({ ...metaView([]), notes: ["x"] });
    expect(table.notes).toEqual(["x"]);
    expect(table.empty).toBe(ATTRIBUTION_COPY.notSynced);
  });
});

describe("googleAdsTable", () => {
  it("formats ROAS with two decimals and the multiplication sign", () => {
    const table = googleAdsTable({
      currency: "EUR",
      rows: [
        {
          campaign: "Brand",
          cost: 100,
          clicks: 250,
          sessions: 240,
          keyEvents: 20,
          revenue: 250,
          roas: 2.5,
          costPerKeyEvent: 5,
          previousRoas: null,
          previousCostPerKeyEvent: null,
        },
        {
          campaign: "Generic",
          cost: 50,
          clicks: 100,
          sessions: 90,
          keyEvents: 0,
          revenue: 0,
          roas: null,
          costPerKeyEvent: null,
          previousRoas: null,
          previousCostPerKeyEvent: null,
        },
      ],
      notes: ["n"],
    });
    expect(table.title).toBe("Google Ads (from GA4)");
    expect(table.columns.map((column) => column.label)).toContain("ROAS");
    expect(table.rows[0]?.cells).toEqual([
      "100 EUR",
      "250",
      "240",
      "20",
      "250 EUR",
      "2.50×",
      "5 EUR",
    ]);
    expect(table.rows[1]?.cells.slice(5)).toEqual(["—", "—"]);
    expect(table.notes).toEqual(["n"]);
  });
});
