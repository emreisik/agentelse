import { describe, expect, it } from "vitest";

import {
  applyWebsitesFilter,
  attentionRank,
  overviewMetrics,
  parseWebsitesFilter,
  rowStatus,
  sortOverviewRows,
  summarizeOverview,
  windowTotals,
  type WebsitesOverviewRow,
} from "./overview";

// Bu dosyanın kanıtladığı (GA-F8, /websites): dikkat sırası, kararlı sıralama,
// özet sayıları, süzgeçler ve yalnız tam 7 günlük pencerelerin sayılması.

const TODAY = "2026-10-07";

function row(over: Partial<WebsitesOverviewRow> = {}): WebsitesOverviewRow {
  return {
    linkId: "l1",
    projectId: "p1",
    projectName: "Acme",
    projectStatus: "ACTIVE",
    propertyId: "111",
    propertyName: "Acme web",
    role: "main",
    serviceLevel: "standard",
    currency: "USD",
    health: "OK",
    healthReason: null,
    connection: "ok",
    measurementScore: 90,
    dataThrough: "2026-10-06",
    sessions7d: 100,
    sessionsChangePct: 5,
    keyEvents7d: 10,
    keyEventsChangePct: 1,
    revenue7d: 0,
    openFindings: 0,
    alertsCritical: 0,
    alertsWarn: 0,
    agentelseChanges: 0,
    bigQuery: "off",
    activeShares: 0,
    isMock: false,
    ...over,
  };
}

// through gününe biten `count` ardışık gün, her gün aynı değerlerle.
function daysEndingAt(through: string, count: number, sessions = 10) {
  const out: {
    day: string;
    sessions: number;
    keyEvents: number;
    revenueMicros: bigint;
  }[] = [];
  const end = new Date(`${through}T00:00:00.000Z`).getTime();
  for (let i = 0; i < count; i += 1) {
    out.push({
      day: new Date(end - i * 86_400_000).toISOString().slice(0, 10),
      sessions,
      keyEvents: 1,
      revenueMicros: BigInt(2_500_000),
    });
  }
  return out;
}

describe("parseWebsitesFilter", () => {
  it("accepts the four filters and falls back to all", () => {
    expect(parseWebsitesFilter("attention")).toBe("attention");
    expect(parseWebsitesFilter("extras")).toBe("extras");
    expect(parseWebsitesFilter("bigquery")).toBe("bigquery");
    expect(parseWebsitesFilter("all")).toBe("all");
    expect(parseWebsitesFilter("nope")).toBe("all");
    expect(parseWebsitesFilter(undefined)).toBe("all");
    expect(parseWebsitesFilter(["attention"])).toBe("all");
  });
});

describe("attentionRank", () => {
  it("orders reconnect > critical > health > warn > stale > 0", () => {
    const rank = (over: Partial<WebsitesOverviewRow>) =>
      attentionRank(row(over), TODAY);
    expect(rank({ connection: "needs_reconnect", alertsCritical: 3 })).toBe(5);
    expect(rank({ alertsCritical: 1, health: "AUTH" })).toBe(4);
    expect(rank({ health: "ACCESS_LOST", alertsWarn: 2 })).toBe(3);
    expect(rank({ alertsWarn: 1 })).toBe(2);
    expect(rank({ dataThrough: "2026-10-03" })).toBe(1);
    expect(rank({})).toBe(0);
  });

  it("treats UNKNOWN health and a missing data day as fine", () => {
    expect(attentionRank(row({ health: "UNKNOWN", dataThrough: null }), TODAY)).toBe(0);
    // 3 gün tam sınır: gecikmiş sayılmaz.
    expect(attentionRank(row({ dataThrough: "2026-10-04" }), TODAY)).toBe(0);
  });
});

describe("sortOverviewRows", () => {
  it("sorts by attention, then project name, with the main property first", () => {
    const rows = [
      row({ linkId: "a-extra", projectId: "pa", projectName: "Alpha", role: "extra", propertyName: "Z" }),
      row({ linkId: "a-main", projectId: "pa", projectName: "Alpha", role: "main" }),
      row({ linkId: "b-main", projectId: "pb", projectName: "Beta", alertsCritical: 1 }),
      row({ linkId: "c-main", projectId: "pc", projectName: "Charlie", connection: "needs_reconnect" }),
    ];
    expect(sortOverviewRows(rows, TODAY).map((r) => r.linkId)).toEqual([
      "c-main",
      "b-main",
      "a-main",
      "a-extra",
    ]);
  });

  it("is stable and does not mutate its input", () => {
    const rows = [
      row({ linkId: "x1", propertyName: "Same" }),
      row({ linkId: "x2", propertyName: "Same" }),
    ];
    const copy = [...rows];
    expect(sortOverviewRows(rows, TODAY).map((r) => r.linkId)).toEqual(["x1", "x2"]);
    expect(rows).toEqual(copy);
  });
});

describe("summarizeOverview", () => {
  it("counts properties, projects, attention, critical alerts and extras", () => {
    const rows = [
      row({ linkId: "1" }),
      row({ linkId: "2", role: "extra", alertsCritical: 2 }),
      row({ linkId: "3", projectId: "p2", health: "AUTH" }),
    ];
    expect(summarizeOverview(rows, TODAY)).toEqual({
      properties: 3,
      projects: 2,
      needAttention: 2,
      critical: 2,
      extras: 1,
    });
  });

  it("is all zero for no rows", () => {
    expect(summarizeOverview([], TODAY)).toEqual({
      properties: 0,
      projects: 0,
      needAttention: 0,
      critical: 0,
      extras: 0,
    });
  });
});

describe("applyWebsitesFilter", () => {
  const rows = [
    row({ linkId: "ok" }),
    row({ linkId: "bad", alertsWarn: 1 }),
    row({ linkId: "extra", role: "extra" }),
    row({ linkId: "bq", bigQuery: "ok" }),
  ];
  it("filters", () => {
    const ids = (filter: Parameters<typeof applyWebsitesFilter>[1]) =>
      applyWebsitesFilter(rows, filter, TODAY).map((r) => r.linkId);
    expect(ids("all")).toEqual(["ok", "bad", "extra", "bq"]);
    expect(ids("attention")).toEqual(["bad"]);
    expect(ids("extras")).toEqual(["extra"]);
    expect(ids("bigquery")).toEqual(["bq"]);
  });
});

describe("windowTotals", () => {
  it("sums the last 7 days and the 7 before", () => {
    const days = daysEndingAt("2026-10-06", 14);
    const { current, previous } = windowTotals(days, "2026-10-06");
    expect(current).toEqual({ sessions: 70, keyEvents: 7, revenue: 17.5, days: 7 });
    expect(previous).toEqual({ sessions: 70, keyEvents: 7, days: 7 });
  });

  it("converts revenue micros to major units", () => {
    const days = [
      ...daysEndingAt("2026-10-06", 7),
    ].map((d) => ({ ...d, revenueMicros: BigInt(1_234_567) }));
    expect(windowTotals(days, "2026-10-06").current.revenue).toBeCloseTo(8.641969, 6);
  });

  it("counts only complete windows", () => {
    const days = daysEndingAt("2026-10-06", 10);
    const { current, previous } = windowTotals(days, "2026-10-06");
    expect(current.days).toBe(7);
    expect(previous.days).toBe(3);
    // Eksik önceki pencere toplamı 0 kalır (yarım rakam göstermez).
    expect(previous.sessions).toBe(0);
    const partial = windowTotals(daysEndingAt("2026-10-06", 5), "2026-10-06");
    expect(partial.current).toEqual({ sessions: 0, keyEvents: 0, revenue: 0, days: 5 });
  });
});

describe("overviewMetrics", () => {
  it("fills the row numbers and the change percentage", () => {
    const current = daysEndingAt("2026-10-06", 7, 20);
    const previous = daysEndingAt("2026-09-29", 7, 10);
    const metrics = overviewMetrics([...current, ...previous], "2026-10-06", TODAY);
    expect(metrics.sessions7d).toBe(140);
    expect(metrics.sessionsChangePct).toBe(100);
    expect(metrics.keyEvents7d).toBe(7);
    expect(metrics.keyEventsChangePct).toBe(0);
    expect(metrics.revenue7d).toBe(17.5);
  });

  it("has no change figure without a complete previous window", () => {
    const metrics = overviewMetrics(daysEndingAt("2026-10-06", 7), "2026-10-06", TODAY);
    expect(metrics.sessions7d).toBe(70);
    expect(metrics.sessionsChangePct).toBeNull();
  });

  it("returns nothing for a missing or stale last day", () => {
    const days = daysEndingAt("2026-08-01", 14);
    const none = {
      sessions7d: null,
      sessionsChangePct: null,
      keyEvents7d: null,
      keyEventsChangePct: null,
      revenue7d: null,
    };
    expect(overviewMetrics(days, null, TODAY)).toEqual(none);
    // 2026-08-01, bugünden 45 günden eski.
    expect(overviewMetrics(days, "2026-08-01", TODAY)).toEqual(none);
    // Eksik pencere de rakam üretmez.
    expect(overviewMetrics(daysEndingAt("2026-10-06", 4), "2026-10-06", TODAY)).toEqual(none);
  });
});

describe("rowStatus", () => {
  it("maps the attention rank to a tone and a fixed label", () => {
    const status = (over: Partial<WebsitesOverviewRow>) => rowStatus(row(over), TODAY);
    expect(status({ connection: "needs_reconnect" })).toEqual({ tone: "bad", label: "Needs reconnect" });
    expect(status({ alertsCritical: 1 }).tone).toBe("bad");
    expect(status({ health: "GONE" }).tone).toBe("bad");
    expect(status({ alertsWarn: 1 }).tone).toBe("warn");
    expect(status({ dataThrough: "2026-10-01" })).toEqual({ tone: "warn", label: "Data is late" });
    expect(status({ health: "UNKNOWN", dataThrough: null })).toEqual({ tone: "idle", label: "Waiting for data" });
    expect(status({})).toEqual({ tone: "ok", label: "Healthy" });
  });

  it("never puts the stored health reason into the label", () => {
    const status = rowStatus(row({ health: "AUTH", healthReason: "boss@agency.test" }), TODAY);
    expect(status.label).not.toContain("boss@agency.test");
  });
});
