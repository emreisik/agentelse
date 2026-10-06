import { describe, expect, it } from "vitest";

import { sumGscDays, type GscDayLike } from "@/lib/seo/totals";

import { buildKpis, kpiChangePct, primaryMetric } from "./kpis";

function day(
  clicks: number,
  impressions: number,
  position: number,
  brand: { clicks: number; impressions: number; position: number } | null,
): GscDayLike {
  return {
    clicks,
    impressions,
    positionWeighted: position * impressions,
    brandClicks: brand?.clicks ?? null,
    brandImpressions: brand?.impressions ?? null,
    brandPositionWeighted: brand ? brand.position * brand.impressions : null,
  };
}

const CURRENT = sumGscDays([
  day(100, 4000, 7, { clicks: 30, impressions: 500, position: 1.5 }),
  day(120, 5000, 8, { clicks: 40, impressions: 600, position: 1.5 }),
]);
const PREVIOUS = sumGscDays([
  day(150, 4500, 6, { clicks: 50, impressions: 700, position: 1.2 }),
]);
const NO_SPLIT = sumGscDays([day(80, 2000, 9, null)]);

function find(kpis: ReturnType<typeof buildKpis>, key: string) {
  return kpis.find((kpi) => kpi.key === key);
}

describe("primaryMetric", () => {
  it("is non-brand clicks only with a brand split", () => {
    expect(primaryMetric(CURRENT)).toBe("nonBrandClicks");
    expect(primaryMetric(NO_SPLIT)).toBe("clicks");
  });
});

describe("buildKpis", () => {
  it("lists brand and non-brand first when the split exists", () => {
    const kpis = buildKpis({ current: CURRENT, previous: PREVIOUS, yearAgo: null });
    expect(kpis.map((kpi) => kpi.key)).toEqual([
      "nonBrandClicks",
      "brandClicks",
      "clicks",
      "impressions",
      "ctr",
      "position",
    ]);
    expect(kpis.map((kpi) => kpi.label)).toEqual([
      "Non-brand clicks",
      "Brand clicks",
      "Clicks",
      "Impressions",
      "CTR",
      "Avg. position",
    ]);
  });

  it("leaves the brand KPIs out without a split", () => {
    const kpis = buildKpis({ current: NO_SPLIT, previous: null, yearAgo: null });
    expect(kpis.map((kpi) => kpi.key)).toEqual([
      "clicks",
      "impressions",
      "ctr",
      "position",
    ]);
  });

  it("uses the GscSplit sums exactly", () => {
    const kpis = buildKpis({ current: CURRENT, previous: PREVIOUS, yearAgo: null });
    expect(find(kpis, "clicks")?.value).toBe(CURRENT.total.clicks);
    expect(find(kpis, "impressions")?.value).toBe(CURRENT.total.impressions);
    expect(find(kpis, "brandClicks")?.value).toBe(CURRENT.brand?.clicks);
    expect(find(kpis, "nonBrandClicks")?.value).toBe(CURRENT.nonBrand?.clicks);
    expect(find(kpis, "clicks")?.previous).toBe(PREVIOUS.total.clicks);
    expect(find(kpis, "nonBrandClicks")?.previous).toBe(PREVIOUS.nonBrand?.clicks);
  });

  it("writes CTR as a percent with two decimals and position with one", () => {
    const kpis = buildKpis({ current: CURRENT, previous: null, yearAgo: null });
    // 220 / 9000 = 2.4444...
    expect(find(kpis, "ctr")?.value).toBe(2.44);
    expect(find(kpis, "ctr")?.format).toBe("percent");
    // (7 * 4000 + 8 * 5000) / 9000 = 7.5555...
    expect(find(kpis, "position")?.value).toBe(7.6);
    expect(find(kpis, "position")?.format).toBe("position");
  });

  it("marks position as lower-is-better only", () => {
    const kpis = buildKpis({ current: CURRENT, previous: null, yearAgo: null });
    expect(kpis.filter((kpi) => kpi.lowerIsBetter).map((kpi) => kpi.key)).toEqual([
      "position",
    ]);
  });

  it("nulls previous and last-year values whose split is missing", () => {
    const kpis = buildKpis({
      current: CURRENT,
      previous: NO_SPLIT,
      yearAgo: null,
    });
    expect(find(kpis, "clicks")?.previous).toBe(80);
    expect(find(kpis, "nonBrandClicks")?.previous).toBeNull();
    expect(find(kpis, "brandClicks")?.previous).toBeNull();
    expect(find(kpis, "clicks")?.yearAgo).toBeNull();
    expect(find(kpis, "position")?.yearAgo).toBeNull();
  });

  it("nulls ratios without impressions", () => {
    const empty = sumGscDays([day(0, 0, 0, null)]);
    const kpis = buildKpis({ current: empty, previous: null, yearAgo: null });
    expect(find(kpis, "ctr")?.value).toBeNull();
    expect(find(kpis, "position")?.value).toBeNull();
  });
});

describe("kpiChangePct", () => {
  it("is a percent rounded to one decimal", () => {
    const kpis = buildKpis({ current: CURRENT, previous: PREVIOUS, yearAgo: PREVIOUS });
    const clicks = find(kpis, "clicks")!;
    // (220 − 150) / 150 = 46.666...
    expect(kpiChangePct(clicks, "previous")).toBe(46.7);
    expect(kpiChangePct(clicks, "yearAgo")).toBe(46.7);
  });

  it("is null without a comparison or with a zero base", () => {
    const kpis = buildKpis({ current: CURRENT, previous: null, yearAgo: null });
    expect(kpiChangePct(find(kpis, "clicks")!, "previous")).toBeNull();
    const zero = buildKpis({
      current: CURRENT,
      previous: sumGscDays([day(0, 10, 3, { clicks: 0, impressions: 1, position: 1 })]),
      yearAgo: null,
    });
    expect(kpiChangePct(find(zero, "clicks")!, "previous")).toBeNull();
  });
});
