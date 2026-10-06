import { describe, expect, it } from "vitest";

import {
  GA_MAX_ROWS,
  GA_REPORTS,
  GA_TOTALS_METRICS,
  gaReportSpec,
  monthlyUsersRequest,
  rollingUsersRequest,
  sliceRequest,
  totalsRequest,
} from "./catalog";

// Bu dosyanın kanıtladığı: her istek Google'ın sınırlarına uyar (9 boyut,
// 10 metrik), kotayı her yanıtta ister, satırları ana metriğe göre bütün
// aralıkta sıralar (gün sırası sınıra takılınca son günleri düşürürdü) ve
// gün başına sınırı aralığın uzunluğuna göre büyütür.

describe("GA report catalog", () => {
  it("keeps every report inside Google's request limits", () => {
    expect(GA_TOTALS_METRICS.length).toBeLessThanOrEqual(10);
    for (const spec of GA_REPORTS) {
      expect(spec.dimensions.length + 1).toBeLessThanOrEqual(9);
      expect(spec.metrics.length).toBeLessThanOrEqual(10);
      expect(spec.metrics).toContain(spec.orderBy);
      expect(spec.retentionDays).toBeGreaterThanOrEqual(spec.backfillDays);
    }
  });

  it("builds a slice request with the date, quota and a global sort", () => {
    const spec = gaReportSpec("landing_page")!;
    const request = sliceRequest(spec, "2026-09-29", "2026-10-05");
    expect(request.dimensions?.map((d) => d.name)).toEqual([
      "date",
      "landingPage",
    ]);
    expect(request.orderBys).toEqual([
      { metric: { metricName: "sessions" }, desc: true },
    ]);
    expect(request.returnPropertyQuota).toBe(true);
    expect(request.keepEmptyRows).toBe(false);
    // 7 gün × 500 satır × 2 pay.
    expect(request.limit).toBe(7_000);
  });

  it("caps the rows of a long request and keeps filters", () => {
    const campaign = gaReportSpec("campaign")!;
    const request = sliceRequest(campaign, "2025-01-01", "2026-10-05");
    expect(request.limit).toBe(GA_MAX_ROWS);
    expect(request.dimensionFilter).toEqual(campaign.filter);
  });

  it("asks the totals day by day", () => {
    const request = totalsRequest("2026-09-29", "2026-10-05");
    expect(request.dimensions).toEqual([{ name: "date" }]);
    expect(request.metrics.map((m) => m.name)).toEqual([...GA_TOTALS_METRICS]);
  });

  it("asks unique users for the 7, 28 and 90 days ending yesterday", () => {
    expect(rollingUsersRequest("2026-10-05").dateRanges).toEqual([
      { startDate: "2026-09-29", endDate: "2026-10-05", name: "d7" },
      { startDate: "2026-09-08", endDate: "2026-10-05", name: "d28" },
      { startDate: "2026-07-08", endDate: "2026-10-05", name: "d90" },
    ]);
  });

  it("asks at most four months of unique users at once", () => {
    const months = Array.from({ length: 6 }, (_, index) => ({
      start: `2026-0${index + 1}-01`,
      end: `2026-0${index + 1}-28`,
    }));
    const request = monthlyUsersRequest(months);
    expect(request.dateRanges).toHaveLength(4);
    expect(request.dateRanges[0]?.name).toBe("m2026-01");
  });
});
