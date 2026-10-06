import { describe, expect, it } from "vitest";

import {
  aggregationFor,
  brandTotalsRequest,
  GSC_OPTIONAL_TYPES,
  GSC_ROW_LIMIT,
  isHeavyRequest,
  periodRequest,
  sliceDayRequest,
  sliceRequest,
  totalsRequest,
} from "./catalog";

// Bu dosyanın kanıtladığı: istek kurucuları türe göre doğru toplama türünü
// seçer, marka isteği Google tarafında süzer, tek günlük kırılım yalnız
// kırılım boyutunu taşır ve "ağır" tanımı plan §3.3'e uyar.

describe("aggregation", () => {
  it("uses byProperty for web/image/video/news and auto for discover/googleNews", () => {
    expect(aggregationFor("web")).toBe("byProperty");
    expect(aggregationFor("image")).toBe("byProperty");
    expect(aggregationFor("video")).toBe("byProperty");
    expect(aggregationFor("news")).toBe("byProperty");
    expect(aggregationFor("discover")).toBe("auto");
    expect(aggregationFor("googleNews")).toBe("auto");
    expect(GSC_OPTIONAL_TYPES).not.toContain("web");
    expect(GSC_OPTIONAL_TYPES).toHaveLength(5);
  });

  it("builds totals requests by date", () => {
    const request = totalsRequest(
      "discover",
      "2026-09-01",
      "2026-09-30",
      "all",
    );
    expect(request).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["date"],
      type: "discover",
      aggregationType: "auto",
      dataState: "all",
      rowLimit: GSC_ROW_LIMIT,
      startRow: 0,
    });
    expect(request.dimensionFilterGroups).toBeUndefined();
  });
});

describe("brand totals", () => {
  it("carries the includingRegex filter on query", () => {
    const request = brandTotalsRequest(
      "(?i)(?:acme)",
      "2026-07-01",
      "2026-09-28",
    );
    expect(request.type).toBe("web");
    expect(request.dimensions).toEqual(["date"]);
    expect(request.aggregationType).toBe("byProperty");
    expect(request.dataState).toBe("final");
    expect(request.dimensionFilterGroups).toEqual([
      {
        groupType: "and",
        filters: [
          {
            dimension: "query",
            operator: "includingRegex",
            expression: "(?i)(?:acme)",
          },
        ],
      },
    ]);
  });
});

describe("slices", () => {
  it("adds the slice dimension next to date", () => {
    expect(
      sliceRequest("appearance", "2026-09-01", "2026-09-30"),
    ).toMatchObject({
      dimensions: ["date", "searchAppearance"],
      aggregationType: "auto",
      dataState: "final",
      type: "web",
    });
    expect(
      sliceRequest("country", "2026-09-01", "2026-09-30").dimensions,
    ).toEqual(["date", "country"]);
  });

  it("a per-day slice request has one dimension and start = end", () => {
    const request = sliceDayRequest("appearance", "2026-10-01");
    expect(request.dimensions).toEqual(["searchAppearance"]);
    expect(request.startDate).toBe("2026-10-01");
    expect(request.endDate).toBe("2026-10-01");
    expect(request.dataState).toBe("final");
  });
});

describe("period requests", () => {
  it("uses byPage only for pages", () => {
    expect(periodRequest("page", "2026-09-28", "2026-10-04")).toMatchObject({
      dimensions: ["page"],
      aggregationType: "byPage",
    });
    expect(periodRequest("query", "2026-09-28", "2026-10-04")).toMatchObject({
      dimensions: ["query"],
      aggregationType: "auto",
    });
    expect(
      periodRequest("query_page", "2026-09-28", "2026-10-04"),
    ).toMatchObject({
      dimensions: ["query", "page"],
      aggregationType: "auto",
    });
  });
});

describe("heavy requests", () => {
  it("query×page is heavy even for a week", () => {
    expect(
      isHeavyRequest(periodRequest("query_page", "2026-09-28", "2026-10-04")),
    ).toBe(true);
    expect(
      isHeavyRequest(periodRequest("query", "2026-09-28", "2026-10-04")),
    ).toBe(false);
  });

  it("a 91-day range is heavy, a 90-day range is not", () => {
    // 2026-07-01 … 2026-09-28 = 90 gün; …09-29 = 91 gün.
    expect(
      isHeavyRequest(totalsRequest("web", "2026-07-01", "2026-09-28", "final")),
    ).toBe(false);
    expect(
      isHeavyRequest(totalsRequest("web", "2026-07-01", "2026-09-29", "final")),
    ).toBe(true);
  });
});
