import { describe, expect, it } from "vitest";

import {
  clickLoss,
  costPer,
  crossCheckFlags,
  isWebsiteResultType,
  metaVsGaRows,
  resultsGap,
} from "./ads-compare";
import type {
  AttributionGroup,
  AttributionMetrics,
  MetaAdsWindow,
} from "./types";

// Meta AD düzeyi ile GA karşılaştırması: eşikler ve satır kuralları.

function ga(sessions: number, keyEvents = 0): AttributionMetrics {
  return { sessions, engagedSessions: 0, keyEvents, revenue: 0 };
}

function window(overrides: Partial<MetaAdsWindow> = {}): MetaAdsWindow {
  return {
    groupKey: "meta:c1",
    ads: 2,
    spend: 200,
    linkClicks: 1000,
    landingPageViews: 800,
    results: null,
    resultActionType: null,
    activeDays: 14,
    ...overrides,
  };
}

function group(overrides: Partial<AttributionGroup> = {}): AttributionGroup {
  return {
    key: "meta:c1",
    kind: "meta_campaign",
    entityType: "meta_ad",
    channel: "meta_ads",
    label: "Spring",
    campaignExternalId: "c1",
    linkIds: ["l1"],
    adExternalIds: ["a1"],
    metrics: ga(500, 5),
    adMetrics: ga(400, 8),
    ...overrides,
  };
}

describe("helpers", () => {
  it("clickLoss is null without clicks and never negative", () => {
    expect(clickLoss(0, 10)).toBeNull();
    expect(clickLoss(100, 150)).toBe(0);
    expect(clickLoss(100, 60)).toBeCloseTo(0.4);
  });

  it("resultsGap is null for missing results or zero counts", () => {
    expect(resultsGap(null, 10)).toBeNull();
    expect(resultsGap(0, 0)).toBeNull();
    expect(resultsGap(100, 70)).toBeCloseTo(0.3);
    expect(resultsGap(0, 10)).toBe(1);
  });

  it("costPer is null unless there is spend and a positive count", () => {
    expect(costPer(null, 5)).toBeNull();
    expect(costPer(100, null)).toBeNull();
    expect(costPer(100, 0)).toBeNull();
    expect(costPer(100, 4)).toBe(25);
    expect(costPer(0, 4)).toBe(0);
  });

  it("recognises website result types", () => {
    expect(isWebsiteResultType("offsite_conversion.fb_pixel_lead")).toBe(true);
    expect(isWebsiteResultType("link_click")).toBe(false);
    expect(isWebsiteResultType(null)).toBe(false);
  });
});

describe("crossCheckFlags", () => {
  it("returns nothing without a window", () => {
    expect(crossCheckFlags(null, ga(0))).toEqual([]);
  });

  it("needs at least 100 link clicks", () => {
    expect(crossCheckFlags(window({ linkClicks: 99 }), ga(0))).toEqual([]);
    expect(crossCheckFlags(window({ linkClicks: 100 }), ga(0))).toEqual([
      "click_loss",
    ]);
  });

  it("flags click loss above 40% only", () => {
    expect(crossCheckFlags(window({ linkClicks: 100 }), ga(60))).toEqual([]);
    expect(crossCheckFlags(window({ linkClicks: 100 }), ga(59))).toEqual([
      "click_loss",
    ]);
  });

  it("flags a results gap above 30% for website results only", () => {
    const base = {
      linkClicks: 100,
      results: 100,
      resultActionType: "offsite_conversion.fb_pixel_purchase",
    };
    expect(crossCheckFlags(window(base), ga(100, 70))).toEqual([]);
    expect(crossCheckFlags(window(base), ga(100, 69))).toEqual(["results_gap"]);
    expect(
      crossCheckFlags(
        window({ ...base, resultActionType: "link_click" }),
        ga(100, 10),
      ),
    ).toEqual([]);
  });

  it("gives no results gap while both counts stay under 10", () => {
    const small = window({
      linkClicks: 100,
      results: 9,
      resultActionType: "offsite_conversion.fb_pixel_lead",
    });
    expect(crossCheckFlags(small, ga(100, 1))).toEqual([]);
    expect(crossCheckFlags(small, ga(100, 14))).toEqual(["results_gap"]);
  });
});

describe("metaVsGaRows", () => {
  it("uses adMetrics for tracked groups and fills Meta columns", () => {
    const rows = metaVsGaRows({
      groups: [group()],
      meta: new Map([
        [
          "meta:c1",
          window({
            results: 20,
            resultActionType: "offsite_conversion.fb_pixel_lead",
          }),
        ],
      ]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tracked: true,
      spend: 200,
      linkClicks: 1000,
      sessions: 400,
      clickToSessionPct: 40,
      results: 20,
      resultLabel: "Leads",
      websiteResults: true,
      keyEvents: 8,
      costPerResult: 10,
      costPerKeyEvent: 25,
      flags: ["click_loss", "results_gap"],
    });
  });

  it("shows untracked groups with GA group totals and no Meta numbers or flags", () => {
    const rows = metaVsGaRows({
      groups: [
        group({ adExternalIds: [] }),
        group({ key: "meta:c2", campaignExternalId: "c2" }),
      ],
      meta: new Map(),
    });
    for (const row of rows) {
      expect(row.tracked).toBe(false);
      expect(row.spend).toBeNull();
      expect(row.linkClicks).toBeNull();
      expect(row.costPerKeyEvent).toBeNull();
      expect(row.flags).toEqual([]);
      expect(row.sessions).toBe(500);
      expect(row.keyEvents).toBe(5);
    }
  });

  it("ignores link groups and a null Meta map", () => {
    const rows = metaVsGaRows({
      groups: [group({ kind: "link", key: "link:l9" }), group()],
      meta: null,
    });
    expect(rows.map((row) => row.groupKey)).toEqual(["meta:c1"]);
    expect(rows[0]?.tracked).toBe(false);
  });

  it("sorts by spend desc with null last, then sessions, and honours the limit", () => {
    const groups = [
      group({ key: "meta:a", campaignExternalId: "a", metrics: ga(10), adMetrics: ga(10) }),
      group({ key: "meta:b", campaignExternalId: "b", metrics: ga(99), adMetrics: ga(5) }),
      group({ key: "meta:c", campaignExternalId: "c", adExternalIds: [], metrics: ga(999) }),
      group({ key: "meta:d", campaignExternalId: "d", metrics: ga(20), adMetrics: ga(20) }),
    ];
    const meta = new Map([
      ["meta:a", window({ groupKey: "meta:a", spend: 50 })],
      ["meta:b", window({ groupKey: "meta:b", spend: 100 })],
      ["meta:d", window({ groupKey: "meta:d", spend: 50 })],
    ]);
    const rows = metaVsGaRows({ groups, meta });
    expect(rows.map((row) => row.groupKey)).toEqual([
      "meta:b",
      "meta:d",
      "meta:a",
      "meta:c",
    ]);
    expect(metaVsGaRows({ groups, meta, limit: 2 })).toHaveLength(2);
  });

  it("keeps a null spend (mixed currencies) without cost columns", () => {
    const rows = metaVsGaRows({
      groups: [group()],
      meta: new Map([["meta:c1", window({ spend: null })]]),
    });
    expect(rows[0]?.tracked).toBe(true);
    expect(rows[0]?.spend).toBeNull();
    expect(rows[0]?.costPerKeyEvent).toBeNull();
  });
});
