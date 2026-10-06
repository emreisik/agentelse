import { describe, expect, it, vi } from "vitest";

import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import type { GaStoredSlice } from "@/lib/website-analytics/slices";
import type { GaPeriodTotals } from "@/lib/website-analytics/totals";

import {
  aiAssistantTable,
  bestConvertingPages,
  channelQualityTable,
  channelTable,
  findingSnap,
  forecastSnaps,
  goalSnaps,
  keyEventTable,
  kpiRows,
  landingMovers,
  measurementSnap,
  paidTrafficTable,
  roundedChangePct,
  siteSearchTable,
  topPagesTable,
} from "./sections";
import type { GoalProgressView, MonthForecastView } from "./types";

// describe.ts metinleri findingSnap testinde sabitlenir: bu dosya yalnız
// eşlemeyi doğrular, metinlerin kendisi GA-F4 testlerindedir.
vi.mock("@/lib/website-analytics/analysis/describe", () => ({
  findingTitle: () => "Title",
  findingDetail: (_view: unknown, options: { currency?: string | null }) =>
    `Detail ${options.currency ?? "none"}`,
  findingImpactText: () => "Impact",
  findingPeriodText: () => "Sep 28 – Oct 4, 2026",
  findingConfidenceText: () => "Significant",
  outcomeText: () => "It worked",
}));

// Bu dosyanın kanıtladığı: yüzde birimleri, değişim yuvarlaması, eşikler,
// kampanya maskelemesi ve bulgu/hedef/tahmin özetleri.

function totals(partial: Partial<GaPeriodTotals> = {}): GaPeriodTotals {
  return {
    dailyActiveUsersSum: 0,
    newUsers: 0,
    sessions: 0,
    engagedSessions: 0,
    engagementSec: 0,
    sessionDurationSec: 0,
    screenPageViews: 0,
    keyEvents: 0,
    revenueMicros: BigInt(0),
    transactions: 0,
    ...partial,
  };
}

function slice(
  dimensionHeaders: string[],
  metricHeaders: string[],
  rows: (string | number)[][],
  partial: Partial<GaStoredSlice> = {},
): GaStoredSlice {
  return {
    day: "2026-10-01",
    dimensionHeaders,
    metricHeaders,
    rows,
    truncated: false,
    otherRow: null,
    quality: {},
    ...partial,
  };
}

const CHANNEL_METRICS = [
  "sessions",
  "engagedSessions",
  "keyEvents",
  "totalRevenue",
];

function channels(rows: [string, number, number, number, number][]) {
  return slice(["sessionDefaultChannelGroup"], CHANNEL_METRICS, rows);
}

function landing(rows: [string, number, number][]) {
  return slice(
    ["landingPage"],
    ["sessions", "keyEvents"],
    rows.map(([page, sessions, keyEvents]) => [page, sessions, keyEvents]),
  );
}

describe("roundedChangePct", () => {
  it("rounds to one decimal and keeps null for a missing base", () => {
    expect(roundedChangePct(4, 3)).toBe(33.3);
    expect(roundedChangePct(5, 0)).toBeNull();
    expect(roundedChangePct(null, 5)).toBeNull();
    expect(roundedChangePct(100, 100)).toBe(0);
    expect(Object.is(roundedChangePct(99.99, 100), -0)).toBe(false);
  });
});

describe("kpiRows", () => {
  const current = totals({
    newUsers: 300,
    sessions: 1000,
    engagedSessions: 600,
    engagementSec: 50_000,
    keyEvents: 50,
  });
  const previous = totals({
    newUsers: 250,
    sessions: 900,
    engagedSessions: 450,
    engagementSec: 36_000,
    keyEvents: 45,
  });

  it("uses percent units and the documented order", () => {
    const rows = kpiRows({
      current,
      previous,
      lastYear: null,
      users: { current: null, previous: null },
    });
    expect(rows.map((row) => row.key)).toEqual([
      "sessions",
      "newUsers",
      "engagementRate",
      "engagementTime",
      "keyEvents",
      "keyEventRate",
    ]);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey.engagementRate?.value).toBe(60);
    expect(byKey.engagementRate?.previous).toBe(50);
    expect(byKey.engagementRate?.format).toBe("percent");
    expect(byKey.engagementTime?.value).toBe(50);
    expect(byKey.engagementTime?.format).toBe("duration");
    expect(byKey.keyEventRate?.value).toBe(5);
    expect(byKey.sessions?.changePct).toBe(11.1);
  });

  it("gives a null key event rate for zero sessions", () => {
    const rows = kpiRows({
      current: totals(),
      previous,
      lastYear: null,
      users: { current: null, previous: null },
    });
    const rate = rows.find((row) => row.key === "keyEventRate");
    expect(rate?.value).toBeNull();
    expect(rate?.changePct).toBeNull();
    expect(rows.find((row) => row.key === "engagementRate")?.value).toBeNull();
  });

  it("adds the revenue row only when revenue is above zero", () => {
    const withRevenue = kpiRows({
      current: totals({ sessions: 10, revenueMicros: BigInt(2_500_000) }),
      previous: totals({ sessions: 10 }),
      lastYear: null,
      users: { current: null, previous: null },
    });
    const revenueRow = withRevenue.find((row) => row.key === "revenue");
    expect(revenueRow?.value).toBe(2.5);
    expect(revenueRow?.format).toBe("money");
    const none = kpiRows({
      current,
      previous,
      lastYear: null,
      users: { current: null, previous: null },
    });
    expect(none.some((row) => row.key === "revenue")).toBe(false);
    // Yalnız önceki dönemde gelir varsa da satır görünür.
    const onlyPrevious = kpiRows({
      current: totals({ sessions: 5 }),
      previous: totals({ sessions: 5, revenueMicros: BigInt(1_000_000) }),
      lastYear: null,
      users: { current: null, previous: null },
    });
    expect(onlyPrevious.some((row) => row.key === "revenue")).toBe(true);
  });

  it("adds users first, only with users, and never a last year value", () => {
    const rows = kpiRows({
      current,
      previous,
      lastYear: totals({ sessions: 800, newUsers: 100 }),
      users: { current: 700, previous: 640 },
    });
    expect(rows[0]).toMatchObject({
      key: "users",
      value: 700,
      previous: 640,
      changePct: 9.4,
      lastYear: null,
      lastYearChangePct: null,
    });
    const sessions = rows.find((row) => row.key === "sessions");
    expect(sessions?.lastYear).toBe(800);
    expect(sessions?.lastYearChangePct).toBe(25);
  });

  it("ignores last year totals without sessions", () => {
    const rows = kpiRows({
      current,
      previous,
      lastYear: totals({ sessions: 0, keyEvents: 4 }),
      users: { current: null, previous: null },
    });
    expect(rows.every((row) => row.lastYear === null)).toBe(true);
  });
});

describe("channelTable", () => {
  it("computes change, share and the other row", () => {
    const current = [
      channels([
        ["Direct", 600, 300, 30, 0],
        ["Organic Search", 300, 240, 20, 0],
      ]),
    ];
    const previous = [channels([["Direct", 500, 250, 25, 0]])];
    const table = channelTable(current, previous, totals({ sessions: 1000 }));
    expect(table.columns.map((column) => column.label)).toEqual([
      "Sessions",
      "Change",
      "Share",
      "Engagement rate",
      "Key events",
    ]);
    expect(table.rows[0]).toEqual({
      label: "Direct",
      values: [600, 20, 60, 50, 30],
    });
    // Önceki dönemde olmayan kanalın değişimi null.
    expect(table.rows[1]?.values[1]).toBeNull();
    // Toplam 1000, gösterilen 900: kalan 100 "other".
    expect(table.other?.[0]).toBe(100);
    expect(table.other?.[2]).toBe(10);
  });

  it("adds a revenue column only when a channel earned revenue", () => {
    const table = channelTable(
      [channels([["Direct", 10, 5, 1, 12.5]])],
      [],
      totals({ sessions: 10 }),
    );
    expect(table.columns.at(-1)).toEqual({ label: "Revenue", format: "money" });
    expect(table.rows[0]?.values.at(-1)).toBe(12.5);
    expect(table.other).toBeNull();
  });

  it("caps the rows at eight", () => {
    const rows: [string, number, number, number, number][] = Array.from(
      { length: 10 },
      (_, index) => [`Channel ${index}`, 100 - index, 10, 1, 0],
    );
    const table = channelTable(
      [channels(rows)],
      [],
      totals({ sessions: 1000 }),
    );
    expect(table.rows).toHaveLength(8);
    expect(table.other).not.toBeNull();
  });

  it("carries quality notes", () => {
    const table = channelTable(
      [
        slice(["sessionDefaultChannelGroup"], CHANNEL_METRICS, [], {
          quality: { thresholded: true },
        }),
      ],
      [],
      totals(),
    );
    expect(table.notes).toEqual([
      "Google hid some small values to protect privacy.",
    ]);
  });
});

describe("landingMovers", () => {
  it("keeps pages from 20 sessions up and drops 19", () => {
    const { winners, losers } = landingMovers(
      [
        landing([
          ["/a", 20, 1],
          ["/b", 19, 1],
          ["/c", 5, 0],
        ]),
      ],
      [
        landing([
          ["/a", 10, 0],
          ["/b", 10, 0],
          ["/c", 19, 0],
        ]),
      ],
    );
    expect(winners.map((mover) => mover.page)).toEqual(["/a"]);
    // /c: önceki 19, güncel 5 → ikisi de 20'nin altında.
    expect(losers).toEqual([]);
  });

  it("counts a page that only existed before", () => {
    const { losers } = landingMovers(
      [landing([])],
      [landing([["/old", 40, 2]])],
    );
    expect(losers).toEqual([
      {
        page: "/old",
        sessions: 0,
        previousSessions: 40,
        change: -40,
        changePct: -100,
        keyEvents: 0,
        previousKeyEvents: 2,
      },
    ]);
  });

  it("breaks ties on the page name and honors the limit", () => {
    const { winners } = landingMovers(
      [
        landing([
          ["/b", 50, 0],
          ["/a", 50, 0],
          ["/c", 50, 0],
        ]),
      ],
      [
        landing([
          ["/a", 30, 0],
          ["/b", 30, 0],
          ["/c", 30, 0],
        ]),
      ],
      { limit: 2 },
    );
    expect(winners.map((mover) => mover.page)).toEqual(["/a", "/b"]);
  });

  it("orders losers by the largest drop and labels empty pages", () => {
    const { losers } = landingMovers(
      [
        landing([
          ["", 30, 0],
          ["/x", 60, 0],
        ]),
      ],
      [
        landing([
          ["", 100, 0],
          ["/x", 90, 0],
        ]),
      ],
    );
    expect(losers.map((mover) => mover.page)).toEqual(["(not set)", "/x"]);
  });
});

describe("keyEventTable", () => {
  it("keeps only key events and compares with the previous period", () => {
    const headers = ["eventName", "isKeyEvent"];
    const metrics = ["keyEvents", "eventCount"];
    const current = [
      slice(headers, metrics, [
        ["generate_lead", "true", 30, 40],
        ["page_view", "false", 0, 900],
        ["purchase", "true", 10, 10],
      ]),
    ];
    const previous = [
      slice(headers, metrics, [["generate_lead", "true", 20, 25]]),
    ];
    const table = keyEventTable(current, previous);
    expect(table.rows).toEqual([
      { label: "generate_lead", values: [30, 50] },
      { label: "purchase", values: [10, null] },
    ]);
    expect(table.columns.map((column) => column.label)).toEqual([
      "Key events",
      "Change",
    ]);
  });
});

describe("aiAssistantTable", () => {
  const headers = ["sessionSource", "sessionMedium"];
  const metrics = ["sessions", "keyEvents"];

  it("maps assistant domains to names", () => {
    const current = [
      slice(headers, metrics, [
        ["chatgpt.com", "referral", 30, 3],
        ["perplexity.ai", "referral", 10, 1],
        ["google", "organic", 500, 20],
      ]),
    ];
    const previous = [
      slice(headers, metrics, [["chatgpt.com", "referral", 20, 1]]),
    ];
    const table = aiAssistantTable(current, previous);
    expect(table?.rows).toEqual([
      { label: "ChatGPT", values: [30, 50, 3] },
      { label: "Perplexity", values: [10, null, 1] },
    ]);
  });

  it("returns null when no assistant sent visits in either period", () => {
    const current = [slice(headers, metrics, [["google", "organic", 100, 5]])];
    expect(aiAssistantTable(current, current)).toBeNull();
  });

  it("still shows the table when only the previous period had visits", () => {
    const previous = [
      slice(headers, metrics, [["chatgpt.com", "referral", 5, 0]]),
    ];
    const table = aiAssistantTable([slice(headers, metrics, [])], previous);
    expect(table).not.toBeNull();
    expect(table?.rows).toEqual([]);
  });
});

describe("siteSearchTable", () => {
  it("returns null without data", () => {
    expect(siteSearchTable(null)).toBeNull();
    expect(siteSearchTable([])).toBeNull();
  });

  it("shows the top five terms and folds the rest with dropped rows", () => {
    const rows = Array.from({ length: 7 }, (_, index) => [
      `term ${index}`,
      70 - index,
    ]);
    const table = siteSearchTable([
      slice(["searchTerm"], ["eventCount"], rows, { otherRow: [9] }),
    ]);
    expect(table?.rows).toHaveLength(5);
    // 6. ve 7. satır (65 + 64) ile kırpılan 9.
    expect(table?.other).toEqual([138]);
    expect(table?.notes).toContain("Weekly data.");
  });
});

describe("topPagesTable", () => {
  it("lists up to ten pages and the remainder", () => {
    const rows: [string, number, number][] = Array.from(
      { length: 12 },
      (_, index) => [`/p${index}`, 100 - index, 1],
    );
    const table = topPagesTable(
      [
        slice(
          ["landingPage"],
          ["sessions", "engagedSessions", "keyEvents"],
          rows.map(([page, sessions, key]) => [
            page,
            sessions,
            sessions / 2,
            key,
          ]),
        ),
      ],
      totals({ sessions: 1500 }),
    );
    expect(table.rows).toHaveLength(10);
    expect(table.rows[0]?.values[1]).toBe(50);
    const shown = rows.slice(0, 10).reduce((sum, row) => sum + row[1], 0);
    expect(table.other?.[0]).toBe(1500 - shown);
  });
});

describe("paidTrafficTable", () => {
  const channelMetrics = ["sessions", "engagedSessions", "keyEvents"];

  it("returns null without paid channels and campaigns", () => {
    expect(
      paidTrafficTable(
        [
          slice(["sessionDefaultChannelGroup"], channelMetrics, [
            ["Direct", 10, 5, 1],
          ]),
        ],
        [],
      ),
    ).toBeNull();
  });

  it("lists paid channels then campaigns and masks personal data", () => {
    const channel = [
      slice(["sessionDefaultChannelGroup"], channelMetrics, [
        ["Paid Search", 200, 100, 10],
        ["Display", 50, 10, 1],
        ["Organic Search", 900, 500, 40],
      ]),
    ];
    const campaign = [
      slice(
        ["sessionCampaignName", "sessionSource", "sessionMedium"],
        channelMetrics,
        [["offer for jane.doe@example.com", "google", "cpc", 80, 40, 8]],
      ),
    ];
    const table = paidTrafficTable(channel, campaign);
    expect(table?.columns.map((column) => column.label)).toEqual([
      "Sessions",
      "Engagement rate",
      "Key event rate",
      "Key events",
    ]);
    expect(table?.rows.map((row) => row.label)).toEqual([
      "Paid Search",
      "Display",
      "offer for [email] (google / cpc)",
    ]);
    expect(JSON.stringify(table)).not.toContain("jane.doe");
    expect(table?.rows[0]?.values).toEqual([200, 50, 5, 10]);
  });

  it("cuts long campaign labels to 80 characters", () => {
    const campaign = [
      slice(
        ["sessionCampaignName", "sessionSource", "sessionMedium"],
        channelMetrics,
        [["x".repeat(200), "google", "cpc", 10, 5, 1]],
      ),
    ];
    const table = paidTrafficTable([], campaign);
    expect(table?.rows[0]?.label.length).toBeLessThanOrEqual(80);
  });
});

describe("channelQualityTable and bestConvertingPages", () => {
  it("keeps channels from 50 sessions and returns null when none", () => {
    const metrics = ["sessions", "engagedSessions", "keyEvents"];
    const table = channelQualityTable(
      [
        slice(["sessionDefaultChannelGroup"], metrics, [
          ["Direct", 200, 100, 20],
          ["Email", 49, 40, 5],
        ]),
      ],
      totals({ sessions: 300 }),
    );
    expect(table?.rows).toEqual([{ label: "Direct", values: [200, 50, 10] }]);
    expect(table?.other).toEqual([100, null, null]);
    expect(
      channelQualityTable(
        [slice(["sessionDefaultChannelGroup"], metrics, [["Email", 10, 5, 1]])],
        totals({ sessions: 10 }),
      ),
    ).toBeNull();
  });

  it("ranks pages by key event rate with a 50 session floor", () => {
    const pages = bestConvertingPages([
      landing([
        ["/a", 100, 10],
        ["/b", 200, 40],
        ["/c", 49, 49],
        ["/d", 80, 0],
        ["/e", 60, 12],
        ["/f", 500, 30],
      ]),
    ]);
    expect(pages.map((page) => page.page)).toEqual(["/b", "/e", "/a"]);
    expect(pages[0]?.keyEventRate).toBe(20);
  });
});

describe("findingSnap", () => {
  const view: GaFindingView = {
    id: "f1",
    ruleKey: "AN15",
    kind: "RISK",
    subject: "goal",
    subjectLabel: "Goal",
    period: {
      grain: "MONTH",
      from: "2026-10-01",
      to: "2026-10-31",
      key: "2026-10",
    },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    status: "OPEN",
    mode: "live",
    priority: 0.5,
    evidence: {
      v: 1,
      rule: "AN15",
      goalId: "g1",
      goalTitle: "Website sessions per month",
      metricKey: "web.sessions",
      month: "2026-10",
      target: 1000,
      monthToDate: 300,
      forecast: 800,
      paceRatio: 0.8,
      dayOfMonth: 10,
      daysInMonth: 31,
      through: "2026-10-10",
    },
    impact: null,
    explanation: "Because.",
    occurrences: 1,
    evaluable: false,
    preliminary: true,
    createdAt: "2026-10-06T08:00:00.000Z",
    acceptedAt: null,
    doneAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: "WORKED",
    reviewVerdict: null,
  };

  it("copies the describe.ts texts and the view state", () => {
    expect(
      findingSnap(view, {
        currency: "EUR",
        timeZone: "Europe/Skopje",
        href: "/projects/p1/site#finding-f1",
      }),
    ).toEqual({
      id: "f1",
      ruleKey: "AN15",
      list: "opportunities",
      kind: "RISK",
      title: "Title",
      detail: "Detail EUR",
      impact: "Impact",
      confidence: "Significant",
      period: "Sep 28 – Oct 4, 2026",
      explanation: "Because.",
      status: "OPEN",
      outcome: "It worked",
      preliminary: true,
      href: "/projects/p1/site#finding-f1",
    });
  });

  it("leaves the outcome null while there is none", () => {
    const snap = findingSnap(
      { ...view, outcome: null, explanation: null },
      { currency: null, timeZone: "UTC", href: "/x" },
    );
    expect(snap.outcome).toBeNull();
    expect(snap.explanation).toBeNull();
  });
});

describe("measurementSnap", () => {
  it("copies the summary fields with the link", () => {
    expect(
      measurementSnap(
        {
          score: 82,
          tone: "warning",
          label: "Needs attention",
          issues: 3,
          critical: 1,
          evaluatedAt: "2026-10-05T08:00:00.000Z",
        },
        "/m",
      ),
    ).toEqual({
      score: 82,
      label: "Needs attention",
      tone: "warning",
      issues: 3,
      critical: 1,
      href: "/m",
    });
    expect(measurementSnap(null, "/m")).toBeNull();
  });
});

function goalView(partial: Partial<GoalProgressView>): GoalProgressView {
  return {
    goalId: "g1",
    title: "Website sessions per month",
    status: "ACTIVE",
    metricKey: "web.sessions",
    target: 10_000,
    month: "2026-10",
    through: "2026-10-10",
    dayOfMonth: 10,
    daysInMonth: 31,
    monthToDate: 3000,
    expectedToDate: 3200,
    forecast: 9000,
    forecastLow: 8000,
    forecastHigh: 10_000,
    forecastBasis: "ok",
    pace: "on_track",
    paceRatio: 0.9,
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...partial,
  };
}

describe("goalSnaps", () => {
  it("keeps only the report month and labels the pace", () => {
    const snaps = goalSnaps(
      [
        goalView({ goalId: "a" }),
        goalView({ goalId: "b", month: "2026-09" }),
        goalView({
          goalId: "c",
          metricKey: "web.revenue",
          pace: "at_risk",
        }),
      ],
      { final: true, month: "2026-10" },
    );
    expect(snaps.map((snap) => snap.goalId)).toEqual(["a", "c"]);
    expect(snaps[0]).toMatchObject({
      format: "count",
      paceLabel: "On track",
      final: true,
      low: 8000,
      high: 10_000,
    });
    expect(snaps[1]).toMatchObject({ format: "money", paceLabel: "At risk" });
  });

  it("caps the list at six", () => {
    const goals = Array.from({ length: 9 }, (_, index) =>
      goalView({ goalId: `g${index}` }),
    );
    expect(goalSnaps(goals, { final: false, month: "2026-10" })).toHaveLength(
      6,
    );
  });
});

describe("forecastSnaps", () => {
  function forecast(partial: Partial<MonthForecastView>): MonthForecastView {
    return {
      metric: "sessions",
      month: "2026-10",
      through: "2026-10-10",
      dayOfMonth: 10,
      daysInMonth: 31,
      monthToDate: 3000,
      forecast: 9000,
      low: 8000,
      high: 10_000,
      basis: "ok",
      ...partial,
    };
  }

  it("labels metrics and notes short history and early days", () => {
    const snaps = forecastSnaps([
      forecast({}),
      forecast({ metric: "keyEvents", basis: "short_history", forecast: null }),
      forecast({ metric: "revenue", dayOfMonth: 3 }),
    ]);
    expect(snaps.map((snap) => snap.label)).toEqual([
      "Sessions",
      "Key events",
      "Revenue",
    ]);
    expect(snaps.map((snap) => snap.format)).toEqual([
      "count",
      "count",
      "money",
    ]);
    expect(snaps[0]?.note).toBeNull();
    expect(snaps[1]?.note).toBe("Forecasts start after 8 weeks of data.");
    expect(snaps[2]?.note).toBe("Too early in the month for a forecast.");
  });
});
