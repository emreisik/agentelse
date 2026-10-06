import { describe, expect, it } from "vitest";

import { GA_MAX_ROWS, gaReportSpec } from "./catalog";
import { addDays } from "./days";
import type { GaParsedReport } from "./response";
import {
  GA_WEEKLY_REPORTS,
  GA_WINDOW_REPORTS,
  gaWeeklySpec,
  planSliceSources,
  splitReportByWeek,
  splitWindowReport,
  weeklyDisableKey,
  weeklySliceRequest,
  windowRequest,
} from "./weekly";
import { isoWeekMonday, mondaysBetween } from "./weeks";

// Bu dosyanın kanıtladığı: haftalık istek isoYearIsoWeek'i ilk boyut olarak
// ve Pazartesi…Pazar aralığını ister; büyük raporlar 6, diğerleri 13 haftalık
// parçalarla gelir; haftalık bölme yolları ve arama sözcüklerini maskeler,
// aynılaşan satırları birleştirir, sınırı aşanı otherRow'a toplar; Search
// Console penceresinde ağırlıklı pozisyon birleştirmeden önce hesaplanır ve
// CTR saklanmaz; birleşik okuma planı hiçbir günü iki kez saymaz.

function parsed(
  dimensionHeaders: string[],
  metricHeaders: string[],
  rows: [string[], number[]][],
  rowCount = rows.length,
): GaParsedReport {
  return {
    dimensionHeaders,
    metricHeaders,
    rows: rows.map(([dimensions, metrics]) => ({ dimensions, metrics })),
    rowCount,
    quality: {},
    propertyQuota: null,
  };
}

describe("weekly specs", () => {
  it("derives the five breakdowns from the daily catalog plus site_search", () => {
    expect(GA_WEEKLY_REPORTS.map((spec) => spec.key)).toEqual([
      "source_medium",
      "campaign",
      "landing_page",
      "page",
      "device_country",
      "site_search",
    ]);
    for (const spec of GA_WEEKLY_REPORTS.slice(0, 5)) {
      const daily = gaReportSpec(spec.key)!;
      expect(spec).toMatchObject({
        version: daily.version,
        dimensions: daily.dimensions,
        metrics: daily.metrics,
        orderBy: daily.orderBy,
        rowsPerWeek: daily.rowsPerDay,
        pathDimensions: daily.pathDimensions,
        retentionDays: 400,
        lagDays: 8,
      });
      expect(spec.filter).toEqual(daily.filter);
      expect(spec.chunkWeeks).toBe(
        spec.key === "landing_page" || spec.key === "page" ? 6 : 13,
      );
      // Tek yanıt ≤ 6.000 satır.
      expect(spec.rowsPerWeek * spec.chunkWeeks).toBeLessThanOrEqual(6_000);
    }
    expect(gaWeeklySpec("site_search")).toMatchObject({
      dimensions: ["searchTerm"],
      metrics: ["eventCount"],
      orderBy: "eventCount",
      rowsPerWeek: 200,
      chunkWeeks: 13,
      lagDays: 3,
      pathDimensions: ["searchTerm"],
      filter: {
        filter: {
          fieldName: "eventName",
          stringFilter: { matchType: "EXACT", value: "view_search_results" },
        },
      },
    });
    expect(gaWeeklySpec("channel")).toBeUndefined();
  });

  it("disables breakdowns weekly-only and site_search by its own key", () => {
    expect(weeklyDisableKey(gaWeeklySpec("landing_page")!)).toBe(
      "week:landing_page",
    );
    expect(weeklyDisableKey(gaWeeklySpec("site_search")!)).toBe("site_search");
  });
});

describe("weekly requests", () => {
  it("asks isoYearIsoWeek first over Monday..Sunday with a row cap", () => {
    const spec = gaWeeklySpec("landing_page")!;
    const request = weeklySliceRequest(spec, "2026-08-17", "2026-09-21");
    expect(request.dateRanges).toEqual([
      { startDate: "2026-08-17", endDate: "2026-09-27" },
    ]);
    expect(request.dimensions?.map((d) => d.name)).toEqual([
      "isoYearIsoWeek",
      "landingPage",
    ]);
    expect(request.orderBys).toEqual([
      { metric: { metricName: "sessions" }, desc: true },
    ]);
    // 6 hafta × 500 satır × 2 pay.
    expect(request.limit).toBe(6_000);
    expect(request.keepEmptyRows).toBe(false);
    expect(request.returnPropertyQuota).toBe(true);
    expect(request.limit).toBeLessThanOrEqual(GA_MAX_ROWS);
    const search = weeklySliceRequest(
      gaWeeklySpec("site_search")!,
      "2026-09-21",
      "2026-09-21",
    );
    expect(search.dimensionFilter).toEqual(gaWeeklySpec("site_search")!.filter);
    expect(search.limit).toBe(400);
  });

  it("asks the 28-day Search Console window ending on Sunday", () => {
    const request = windowRequest(GA_WINDOW_REPORTS[0]!, "2026-09-28");
    expect(request.dateRanges).toEqual([
      { startDate: "2026-09-07", endDate: "2026-10-04" },
    ]);
    expect(request.dimensions).toEqual([
      { name: "landingPagePlusQueryString" },
    ]);
    expect(request.metrics.map((m) => m.name)).toEqual([
      "organicGoogleSearchClicks",
      "organicGoogleSearchImpressions",
      "organicGoogleSearchAveragePosition",
    ]);
    expect(request.limit).toBe(1_000);
  });
});

describe("splitReportByWeek", () => {
  it("masks search words, merges duplicates and fills otherRow", () => {
    const spec = { ...gaWeeklySpec("site_search")!, rowsPerWeek: 2 };
    const slices = splitReportByWeek(
      parsed(
        ["isoYearIsoWeek", "searchTerm"],
        ["eventCount"],
        [
          [["202639", "pricing"], [10]],
          [["202639", "jane@example.com"], [3]],
          [["202639", "joe@example.com"], [4]],
          [["202639", "opening  hours"], [1]],
          [["202640", "pricing"], [5]],
          [["202641", "pricing"], [99]],
        ],
      ),
      spec,
      ["2026-09-21", "2026-09-28", "2026-10-12"],
    );
    const [first, second, third] = slices;
    expect(first?.day).toBe("2026-09-21");
    expect(first?.dimensionHeaders).toEqual(["searchTerm"]);
    expect(first?.rows).toEqual([
      ["pricing", 10],
      ["[email]", 7],
    ]);
    expect(first?.otherRow).toEqual([1]);
    expect(first?.rowCount).toBe(3);
    expect(first?.truncated).toBe(true);
    expect(JSON.stringify(slices)).not.toContain("@");
    expect(second).toMatchObject({ day: "2026-09-28", rows: [["pricing", 5]] });
    // İstenmeyen hafta (202641) yazılmaz; istenen boş hafta boş dilimdir.
    expect(third).toMatchObject({ day: "2026-10-12", rows: [], rowCount: 0 });
  });

  it("masks landing page paths", () => {
    const [slice] = splitReportByWeek(
      parsed(
        ["isoYearIsoWeek", "landingPage"],
        [
          "sessions",
          "engagedSessions",
          "keyEvents",
          "totalRevenue",
          "userEngagementDuration",
        ],
        [
          [
            ["202639", "/reset/jane@example.com"],
            [3, 1, 0, 0, 10],
          ],
          [
            ["202639", "/pricing?ref=x"],
            [4, 2, 1, 0, 20],
          ],
          [
            ["202639", "/pricing"],
            [1, 1, 0, 0, 5],
          ],
        ],
      ),
      gaWeeklySpec("landing_page")!,
      ["2026-09-21"],
    );
    expect(slice?.rows).toEqual([
      ["/pricing", 5, 3, 1, 0, 25],
      ["/reset/[email]", 3, 1, 0, 0, 10],
    ]);
  });
});

describe("splitWindowReport", () => {
  it("weights the position before merging and drops CTR", () => {
    const spec = GA_WINDOW_REPORTS[0]!;
    const slice = splitWindowReport(
      parsed(
        ["landingPagePlusQueryString"],
        [
          "organicGoogleSearchClicks",
          "organicGoogleSearchImpressions",
          "organicGoogleSearchAveragePosition",
        ],
        [
          [["/pricing?utm_source=news"], [10, 100, 2]],
          [["/pricing"], [5, 300, 10]],
          [["/"], [20, 200, 1.5]],
        ],
      ),
      spec,
      "2026-09-28",
    );
    expect(slice.day).toBe("2026-09-28");
    expect(slice.metricHeaders).toEqual([
      "organicGoogleSearchClicks",
      "organicGoogleSearchImpressions",
      "positionWeighted",
    ]);
    // /pricing: 2×100 + 10×300 = 3200; okuyucu 3200 / 400 = 8 bulur.
    expect(slice.rows).toEqual([
      ["/", 20, 200, 300],
      ["/pricing", 15, 400, 3200],
    ]);
    expect(slice.otherRow).toBeNull();
  });
});

describe("planSliceSources", () => {
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
    return out;
  };

  it("uses days when a week has them all, the WEEK slice otherwise", () => {
    // 2026-06-01..2026-06-14: iki tam hafta.
    const plan = planSliceSources({
      from: "2026-06-01",
      to: "2026-06-14",
      dayKeys: new Set(days("2026-06-08", "2026-06-14")),
      weekStarts: new Set(["2026-06-01", "2026-06-08"]),
    });
    expect(plan).toEqual({
      days: days("2026-06-08", "2026-06-14"),
      weeks: ["2026-06-01"],
      missingDays: 0,
      approximate: false,
    });
  });

  it("leaves a partial edge week out unless asked for the majority", () => {
    // Haziran 2026: 1 Haziran Pazartesi, 30 Haziran Salı.
    const input = {
      from: "2026-05-28",
      to: "2026-06-30",
      dayKeys: new Set<string>(),
      weekStarts: new Set(mondaysBetween("2026-05-25", "2026-06-29")),
    };
    const exclude = planSliceSources(input);
    expect(exclude.weeks).toEqual(mondaysBetween("2026-06-01", "2026-06-22"));
    // 28-31 Mayıs (4 gün) + 29-30 Haziran (2 gün) eksik.
    expect(exclude.missingDays).toBe(6);
    expect(exclude.approximate).toBe(false);
    const majority = planSliceSources({ ...input, edgeWeeks: "majority" });
    expect(majority.weeks).toEqual(mondaysBetween("2026-05-25", "2026-06-22"));
    expect(majority.missingDays).toBe(2);
    expect(majority.approximate).toBe(true);
  });

  it("never counts a day inside a chosen week (random sets)", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 200; round += 1) {
      const from = addDays("2026-01-01", Math.floor(random() * 300));
      const to = addDays(from, Math.floor(random() * 90));
      const all = days(addDays(from, -7), addDays(to, 7));
      const dayKeys = new Set(all.filter(() => random() < 0.7));
      const weekStarts = new Set(
        mondaysBetween(isoWeekMonday(from), isoWeekMonday(to)).filter(
          () => random() < 0.6,
        ),
      );
      for (const edgeWeeks of ["exclude", "majority"] as const) {
        const plan = planSliceSources({
          from,
          to,
          dayKeys,
          weekStarts,
          edgeWeeks,
        });
        const weekSet = new Set(plan.weeks);
        for (const day of plan.days) {
          expect(weekSet.has(isoWeekMonday(day))).toBe(false);
          expect(day >= from && day <= to).toBe(true);
          expect(dayKeys.has(day)).toBe(true);
        }
        expect(new Set(plan.days).size).toBe(plan.days.length);
        for (const monday of plan.weeks)
          expect(weekStarts.has(monday)).toBe(true);
        if (edgeWeeks === "exclude") expect(plan.approximate).toBe(false);
      }
    }
  });
});
