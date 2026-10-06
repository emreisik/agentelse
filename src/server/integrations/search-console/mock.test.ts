import { describe, expect, it } from "vitest";

import {
  brandTotalsRequest,
  GSC_COUNTRY_TOP,
  periodRequest,
  sliceDayRequest,
  sliceRequest,
  totalsRequest,
  type GscQueryRequest,
} from "@/lib/seo/catalog";
import { parseGscResponse, type GscRow } from "@/lib/seo/response";
import { GoogleApiError } from "@/server/integrations/google/errors";

import {
  mockSearchAnalytics,
  mockSitemaps,
  mockSite,
  MOCK_GSC_BRAND_TERM,
} from "./mock";

// Bu dosyanın kanıtladığı: mock belirlenimcidir; final bugün−3'te, all
// bugün−1'de durur ve first_incomplete_date verir; 2025-01-01'den önce veri
// yoktur; discover boştur; marka ifadesi yalnız "acme" sorgularını tutar;
// sorgu toplamı tarih toplamından küçüktür (anonim pay); tek boyutlu
// kırılım, sayfalama ve PII örnekleri çalışır.

// 2026-10-06 10:00 PDT
const NOW = new Date("2026-10-06T17:00:00Z");
const SITE = "sc-domain:example.com";

function run(request: GscQueryRequest) {
  return parseGscResponse(mockSearchAnalytics(SITE, request, NOW));
}

function sum(rows: GscRow[], field: "clicks" | "impressions"): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

describe("mockSearchAnalytics", () => {
  it("is deterministic", () => {
    const request = periodRequest("query", "2026-09-01", "2026-09-30");
    expect(mockSearchAnalytics(SITE, request, NOW)).toEqual(
      mockSearchAnalytics(SITE, request, NOW),
    );
    expect(mockSearchAnalytics(SITE, request, NOW)).not.toEqual(
      mockSearchAnalytics("sc-domain:other.test", request, NOW),
    );
  });

  it("final stops at today−3; all stops at today−1 with first_incomplete_date", () => {
    const final = run(
      totalsRequest("web", "2026-09-27", "2026-10-06", "final"),
    );
    expect(final.rows.at(-1)!.keys[0]).toBe("2026-10-03");
    expect(final.firstIncompleteDate).toBeNull();

    const all = run(totalsRequest("web", "2026-09-27", "2026-10-06", "all"));
    expect(all.rows.at(-1)!.keys[0]).toBe("2026-10-05");
    expect(all.rows).toHaveLength(9);
    expect(all.firstIncompleteDate).toBe("2026-10-04");

    const old = run(totalsRequest("web", "2026-09-01", "2026-09-10", "all"));
    expect(old.firstIncompleteDate).toBeNull();
  });

  it("has no data before 2025-01-01", () => {
    const response = run(
      totalsRequest("web", "2024-12-20", "2025-01-05", "final"),
    );
    expect(response.rows[0]!.keys[0]).toBe("2025-01-01");
    expect(response.rows).toHaveLength(5);
    expect(
      run(totalsRequest("web", "2024-10-01", "2024-12-31", "final")).rows,
    ).toEqual([]);
  });

  it("returns no rows for discover, news and googleNews; small rows for image", () => {
    for (const type of ["discover", "news", "googleNews"] as const) {
      const raw = mockSearchAnalytics(
        SITE,
        totalsRequest(type, "2026-09-01", "2026-09-30", "final"),
        NOW,
      );
      // Google boş yanıtta `rows` alanını hiç göndermez.
      expect(raw).not.toHaveProperty("rows");
      expect(parseGscResponse(raw).rows).toEqual([]);
    }
    const web = run(totalsRequest("web", "2026-09-01", "2026-09-30", "final"));
    const image = run(
      totalsRequest("image", "2026-09-01", "2026-09-30", "final"),
    );
    expect(image.rows.length).toBeGreaterThan(0);
    expect(sum(image.rows, "impressions")).toBeLessThan(
      sum(web.rows, "impressions") / 5,
    );
  });

  it("echoes the aggregation type", () => {
    expect(
      run(totalsRequest("web", "2026-09-01", "2026-09-30", "final"))
        .responseAggregationType,
    ).toBe("byProperty");
    expect(
      run(periodRequest("page", "2026-09-01", "2026-09-07"))
        .responseAggregationType,
    ).toBe("byPage");
  });

  it("the brand regex keeps only 'acme' queries", () => {
    const filtered = run({
      ...periodRequest("query", "2026-09-01", "2026-09-30"),
      dimensionFilterGroups: [
        {
          groupType: "and",
          filters: [
            {
              dimension: "query",
              operator: "includingRegex",
              expression: `(?i)(?:${MOCK_GSC_BRAND_TERM.toUpperCase()})`,
            },
          ],
        },
      ],
    });
    expect(filtered.rows.length).toBeGreaterThanOrEqual(2);
    expect(
      filtered.rows.every((row) => row.keys[0]!.includes(MOCK_GSC_BRAND_TERM)),
    ).toBe(true);

    // Marka günlük serisi = eşleşen sorguların toplamı (anonim pay yok).
    const brand = run(
      brandTotalsRequest(
        `(?i)(?:${MOCK_GSC_BRAND_TERM})`,
        "2026-09-01",
        "2026-09-30",
      ),
    );
    expect(brand.rows).toHaveLength(30);
    expect(sum(brand.rows, "clicks")).toBe(sum(filtered.rows, "clicks"));
    expect(sum(brand.rows, "impressions")).toBe(
      sum(filtered.rows, "impressions"),
    );
  });

  it("supports Unicode classes in the regex and rejects an invalid one", () => {
    const turkish = run({
      ...periodRequest("query", "2026-09-01", "2026-09-07"),
      dimensionFilterGroups: [
        {
          groupType: "and",
          filters: [
            {
              dimension: "query",
              operator: "includingRegex",
              expression:
                "(?i)(?:^|[^\\p{L}\\p{N}])ışıklı(?:$|[^\\p{L}\\p{N}])",
            },
          ],
        },
      ],
    });
    expect(turkish.rows.map((row) => row.keys[0])).toEqual([
      "ışıklı ayakkabı fiyatları",
    ]);
    expect(() =>
      mockSearchAnalytics(
        SITE,
        brandTotalsRequest("(?i)(acme", "2026-09-01", "2026-09-07"),
        NOW,
      ),
    ).toThrow(GoogleApiError);
  });

  it("query rows sum to less than the date totals (anonymous queries)", () => {
    const queries = run(periodRequest("query", "2026-09-01", "2026-09-30"));
    const totals = run(
      totalsRequest("web", "2026-09-01", "2026-09-30", "final"),
    );
    const queryClicks = sum(queries.rows, "clicks");
    const totalClicks = sum(totals.rows, "clicks");
    expect(queryClicks).toBeGreaterThan(0);
    expect(queryClicks).toBeLessThan(totalClicks);
    expect(sum(totals.rows, "impressions")).toBeCloseTo(
      sum(queries.rows, "impressions") * 1.18,
      -2,
    );
  });

  it("query×page rows are consistent with query rows", () => {
    const queries = run(periodRequest("query", "2026-09-01", "2026-09-07"));
    const pairs = run(periodRequest("query_page", "2026-09-01", "2026-09-07"));
    for (const row of queries.rows) {
      const parts = pairs.rows.filter((pair) => pair.keys[0] === row.keys[0]);
      expect(sum(parts, "clicks")).toBe(row.clicks);
      expect(sum(parts, "impressions")).toBe(row.impressions);
    }
    const pages = new Set(pairs.rows.map((pair) => pair.keys[1]));
    expect(pages.size).toBeGreaterThanOrEqual(6);
    expect(
      [...pages].every((page) => page!.startsWith("https://www.example.com/")),
    ).toBe(true);
    expect(pages.has("https://www.example.com/sale?ref=abc")).toBe(true);
  });

  it("sums the days for a non-date dimension and supports both slice forms", () => {
    const byDay = run(sliceRequest("device", "2026-09-01", "2026-09-07"));
    const range = run({
      ...sliceRequest("device", "2026-09-01", "2026-09-07"),
      dimensions: ["device"],
    });
    expect(range.rows.map((row) => row.keys[0]).sort()).toEqual([
      "DESKTOP",
      "MOBILE",
      "TABLET",
    ]);
    expect(
      Math.abs(sum(range.rows, "impressions") - sum(byDay.rows, "impressions")),
    ).toBeLessThanOrEqual(byDay.rows.length);

    const appearance = run(sliceDayRequest("appearance", "2026-09-15"));
    expect(appearance.rows.length).toBeGreaterThan(0);
    expect(appearance.rows.every((row) => row.keys.length === 1)).toBe(true);

    const withDate = run(
      sliceRequest("appearance", "2026-09-15", "2026-09-15"),
    );
    expect(withDate.rows.every((row) => row.keys[0] === "2026-09-15")).toBe(
      true,
    );
  });

  it("uses lowercase ISO alpha-3 countries, more than the top 50", () => {
    const countries = run(sliceRequest("country", "2026-09-15", "2026-09-15"));
    expect(countries.rows.length).toBeGreaterThan(GSC_COUNTRY_TOP);
    expect(countries.rows.every((row) => /^[a-z]{3}$/.test(row.keys[1]!))).toBe(
      true,
    );
    expect(countries.rows.map((row) => row.keys[1])).toContain("mkd");
  });

  it("honours startRow and rowLimit", () => {
    const full = run(periodRequest("query", "2026-09-01", "2026-09-30"));
    const first = run({
      ...periodRequest("query", "2026-09-01", "2026-09-30"),
      rowLimit: 5,
    });
    const second = run({
      ...periodRequest("query", "2026-09-01", "2026-09-30"),
      rowLimit: 5,
      startRow: 5,
    });
    expect(first.rows).toEqual(full.rows.slice(0, 5));
    expect(second.rows).toEqual(full.rows.slice(5, 10));
    expect(full.rows.length).toBeGreaterThanOrEqual(12);
  });

  it("includes PII samples in the raw query texts", () => {
    const texts = run(
      periodRequest("query", "2026-09-01", "2026-09-30"),
    ).rows.map((row) => row.keys[0]);
    expect(texts.some((text) => text!.includes("john.doe@example.com"))).toBe(
      true,
    );
    expect(texts.some((text) => text!.includes("+90 555 123 45 67"))).toBe(
      true,
    );
    expect(
      texts.some((text) => /[ış]/.test(text!) && !text!.includes("acme")),
    ).toBe(true);
  });

  it("has a lower weekend", () => {
    // 2026-09-12 Cumartesi, 2026-09-14 Pazartesi; dört hafta ortalaması.
    const totals = run(
      totalsRequest("web", "2026-08-17", "2026-09-13", "final"),
    );
    const weekend = totals.rows.filter((row) => {
      const day = new Date(`${row.keys[0]}T00:00:00Z`).getUTCDay();
      return day === 0 || day === 6;
    });
    const weekdays = totals.rows.filter((row) => !weekend.includes(row));
    expect(sum(weekend, "impressions") / weekend.length).toBeLessThan(
      sum(weekdays, "impressions") / weekdays.length,
    );
  });
});

describe("mockSite / mockSitemaps", () => {
  it("returns an owner and the property type", () => {
    expect(mockSite(SITE)).toEqual({
      siteUrl: SITE,
      permissionLevel: "siteOwner",
      propertyType: "DOMAIN",
    });
    expect(mockSite("https://shop.example.com/").propertyType).toBe(
      "URL_PREFIX",
    );
  });

  it("lists /sitemap.xml with 42 submitted web URLs", () => {
    expect(mockSitemaps(SITE)).toEqual([
      expect.objectContaining({
        path: "https://www.example.com/sitemap.xml",
        contents: [{ type: "web", submitted: 42 }],
      }),
    ]);
    expect(mockSitemaps("https://shop.example.com/")[0]!.path).toBe(
      "https://shop.example.com/sitemap.xml",
    );
  });
});
