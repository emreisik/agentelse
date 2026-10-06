import { describe, expect, it } from "vitest";

import {
  baseMetricsOf,
  livePlanOf,
  planWebsiteQuery,
  type WebsiteQueryArgs,
} from "./query-plan";

// Bu dosyanın kanıtladığı: yönlendirme tablosu (boyutsuz → totals; tarihli →
// gün/hafta/ay tanesi; kanal → dilimler; kaynak + açılış sayfası → canlı;
// 28 günün activeUsers'ı → canlı); 400 günden eski aralık ve gelecekteki gün
// hata; satır sınırı 1–20'ye kırpılır; canlı istek türetilmiş metrik adını hiç
// taşımaz, temel metriklerini taşır.

const TODAY = "2026-10-06";

function plan(args: WebsiteQueryArgs) {
  return planWebsiteQuery(args, { today: TODAY });
}

describe("planWebsiteQuery", () => {
  it("routes a request without dimensions to the daily totals", () => {
    expect(plan({ metrics: ["sessions", "keyEvents"] })).toEqual({
      kind: "totals",
      range: { from: "2026-09-08", to: "2026-10-05" },
      grain: "all",
      metrics: ["sessions", "keyEvents"],
    });
  });

  it("picks the date grain by range length", () => {
    const grain = (from: string, to: string) => {
      const result = plan({
        dimensions: ["date"],
        metrics: ["sessions"],
        period: "custom",
        from,
        to,
      });
      return result.kind === "totals" ? result.grain : result.kind;
    };
    expect(grain("2026-09-16", "2026-10-05")).toBe("day"); // 20 gün
    expect(grain("2026-09-15", "2026-10-05")).toBe("week"); // 21 gün
    expect(grain("2026-05-19", "2026-10-05")).toBe("week"); // 140 gün
    expect(grain("2026-05-18", "2026-10-05")).toBe("month"); // 141 gün
  });

  it("serves a channel breakdown from the slices", () => {
    expect(
      plan({
        dimensions: ["sessionDefaultChannelGroup"],
        metrics: ["sessions", "engagementRate"],
        period: "7d",
      }),
    ).toEqual({
      kind: "slices",
      reportKey: "channel",
      range: { from: "2026-09-29", to: "2026-10-05" },
      groupBy: ["sessionDefaultChannelGroup"],
      baseMetrics: ["sessions", "engagedSessions"],
      metrics: ["sessions", "engagementRate"],
      filter: null,
      limit: 10,
    });
  });

  it("uses source_medium, not the filtered campaign report, for sources", () => {
    const result = plan({
      dimensions: ["sessionSource"],
      metrics: ["sessions"],
    });
    expect(result.kind === "slices" && result.reportKey).toBe("source_medium");
    const campaign = plan({
      dimensions: ["sessionCampaignName"],
      metrics: ["keyEvents"],
    });
    expect(campaign.kind === "slices" && campaign.reportKey).toBe("campaign");
  });

  it("goes live for a source by landing page breakdown", () => {
    const result = plan({
      dimensions: ["sessionSource", "landingPage"],
      metrics: ["sessions", "keyEventRate"],
      filter: { dimension: "landingPage", contains: "/blog" },
    });
    expect(result.kind).toBe("live");
    if (result.kind !== "live") return;
    expect(result.dimensions).toEqual(["sessionSource", "landingPage"]);
    expect(result.request.dimensionFilter).toEqual({
      filter: {
        fieldName: "landingPage",
        stringFilter: {
          matchType: "CONTAINS",
          value: "/blog",
          caseSensitive: false,
        },
      },
    });
    expect(result.request.orderBys).toEqual([
      { metric: { metricName: "sessions" }, desc: true },
    ]);
    expect(result.request.returnPropertyQuota).toBe(true);
    expect(result.request.keepEmptyRows).toBe(false);
  });

  it("never serves activeUsers over 28 days from totals or slices", () => {
    expect(plan({ metrics: ["activeUsers"] }).kind).toBe("live");
    expect(
      plan({
        dimensions: ["sessionDefaultChannelGroup"],
        metrics: ["activeUsers"],
      }).kind,
    ).toBe("live");
    // Tek gün dilimden okunabilir.
    expect(
      plan({
        dimensions: ["sessionDefaultChannelGroup"],
        metrics: ["activeUsers"],
        period: "custom",
        from: "2026-10-05",
        to: "2026-10-05",
      }).kind,
    ).toBe("slices");
  });

  it("rejects ranges older than 400 days, in the future or incomplete", () => {
    const old = plan({
      metrics: ["sessions"],
      period: "custom",
      from: "2025-08-31",
      to: "2026-10-01",
    });
    expect(old.kind).toBe("error");
    const future = plan({
      metrics: ["sessions"],
      period: "custom",
      from: "2026-10-01",
      to: "2026-10-06",
    });
    expect(future.kind).toBe("error");
    const half = plan({
      metrics: ["sessions"],
      period: "custom",
      from: "2026-10-01",
    });
    expect(half.kind).toBe("error");
    const reversed = plan({
      metrics: ["sessions"],
      period: "custom",
      from: "2026-10-03",
      to: "2026-10-01",
    });
    expect(reversed.kind).toBe("error");
  });

  it("clamps the row limit to 1–20", () => {
    const limitOf = (limit: number) => {
      const result = plan({
        dimensions: ["landingPage"],
        metrics: ["sessions"],
        limit,
      });
      return result.kind === "slices" ? result.limit : null;
    };
    expect(limitOf(500)).toBe(20);
    expect(limitOf(0)).toBe(1);
    expect(limitOf(7)).toBe(7);
  });

  it("rejects too many dimensions or metrics", () => {
    expect(
      plan({
        dimensions: ["country", "deviceCategory", "landingPage"],
        metrics: ["sessions"],
      }).kind,
    ).toBe("error");
    expect(plan({ metrics: [] }).kind).toBe("error");
  });
});

describe("live requests", () => {
  it("never carry derived metric names and always their base metrics", () => {
    const live = livePlanOf(
      {
        dimensions: ["sessionSource", "landingPage"],
        metrics: ["engagementRate", "keyEventRate", "averageEngagementSeconds"],
      },
      { from: "2026-09-01", to: "2026-09-30" },
      50,
    );
    const names = live.request.metrics.map((metric) => metric.name);
    for (const derived of [
      "engagementRate",
      "keyEventRate",
      "averageEngagementSeconds",
    ]) {
      expect(names).not.toContain(derived);
    }
    expect(names).toEqual([
      "engagedSessions",
      "sessions",
      "keyEvents",
      "userEngagementDuration",
    ]);
    expect(live.limit).toBe(20);
    expect(live.request.limit).toBe(20);
  });

  it("expands derived metrics once and in order", () => {
    expect(baseMetricsOf(["sessions", "engagementRate", "keyEvents"])).toEqual([
      "sessions",
      "engagedSessions",
      "keyEvents",
    ]);
  });
});
