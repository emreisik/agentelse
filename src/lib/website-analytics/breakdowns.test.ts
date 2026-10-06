import { describe, expect, it } from "vitest";

import { buildGaModuleLists } from "./breakdowns";
import type { GaStoredSlice } from "./slices";

// Analytics modülünün GA listeleri: birden çok gün dilimi toplanır, pay ve
// etkileşim oranı doğru hesaplanır, "(not set)" sayfası atlanır, yalnız key
// event'ler kalır, listeler sınırda kesilir, verilmeyen dilim listeyi atlar.

function slice(
  day: string,
  dimensionHeaders: string[],
  metricHeaders: string[],
  rows: (string | number)[][],
): GaStoredSlice {
  return {
    day,
    dimensionHeaders,
    metricHeaders,
    rows,
    truncated: false,
    otherRow: null,
    quality: {},
  };
}

const CHANNEL_DIMS = ["sessionDefaultChannelGroup"];
const CHANNEL_METRICS = [
  "sessions",
  "engagedSessions",
  "activeUsers",
  "newUsers",
  "keyEvents",
  "totalRevenue",
];

const channels = [
  slice("2026-10-01", CHANNEL_DIMS, CHANNEL_METRICS, [
    ["Organic Search", 60, 30, 50, 20, 2, 0],
    ["Direct", 20, 10, 18, 5, 0, 0],
  ]),
  slice("2026-10-02", CHANNEL_DIMS, CHANNEL_METRICS, [
    ["Organic Search", 40, 30, 35, 10, 1, 0],
    ["Direct", 30, 0, 25, 8, 0, 0],
    ["Email", 0, 0, 0, 0, 0, 0],
  ]),
];

const LANDING_DIMS = ["landingPage"];
const LANDING_METRICS = [
  "sessions",
  "engagedSessions",
  "keyEvents",
  "totalRevenue",
  "userEngagementDuration",
];

const EVENT_DIMS = ["eventName", "isKeyEvent"];
const EVENT_METRICS = ["eventCount", "keyEvents", "totalUsers"];

describe("buildGaModuleLists", () => {
  it("sums the day slices per channel, with share of the window and engagement", () => {
    const lists = buildGaModuleLists({
      channel: channels,
      landing: null,
      events: null,
      totalSessions: 300,
    });
    expect(lists).toEqual({
      channels: [
        {
          channel: "Organic Search",
          sessions: 100,
          share: 33.3,
          engagementRate: 60,
          keyEvents: 3,
        },
        {
          channel: "Direct",
          sessions: 50,
          share: 16.7,
          engagementRate: 20,
          keyEvents: 0,
        },
        // Oturumsuz kanal: oran yok, pay sıfır.
        {
          channel: "Email",
          sessions: 0,
          share: 0,
          engagementRate: null,
          keyEvents: 0,
        },
      ],
    });
  });

  it("has no share when the window has no sessions", () => {
    const lists = buildGaModuleLists({
      channel: channels,
      landing: null,
      events: null,
      totalSessions: 0,
    });
    expect(lists.channels?.map((row) => row.share)).toEqual([null, null, null]);
  });

  it("skips (not set) and empty landing pages, collapses whitespace and caps the text", () => {
    const long = `/${"a".repeat(260)}`;
    const lists = buildGaModuleLists({
      channel: null,
      landing: [
        slice("2026-10-01", LANDING_DIMS, LANDING_METRICS, [
          ["(not set)", 500, 100, 0, 0, 0],
          ["  /pricing \n page ", 80, 40, 4, 0, 0],
          ["", 70, 10, 0, 0, 0],
          [long, 10, 5, 1, 0, 0],
        ]),
      ],
      events: null,
      totalSessions: 1000,
    });
    expect(lists.landingPages).toEqual([
      { page: "/pricing page", sessions: 80, engagementRate: 50, keyEvents: 4 },
      {
        page: long.slice(0, 200),
        sessions: 10,
        engagementRate: 50,
        keyEvents: 1,
      },
    ]);
  });

  it("keeps only key events with a count, most first, rounded", () => {
    const lists = buildGaModuleLists({
      channel: null,
      landing: null,
      events: [
        slice("2026-10-01", EVENT_DIMS, EVENT_METRICS, [
          ["page_view", "false", 900, 0, 100],
          ["generate_lead", "true", 12, 12, 10],
          ["purchase", "true", 3, 2.6, 3],
          ["sign_up", "true", 0, 0, 0],
        ]),
        slice("2026-10-02", EVENT_DIMS, EVENT_METRICS, [
          ["generate_lead", "true", 8, 8, 7],
          ["page_view", "false", 800, 0, 90],
        ]),
      ],
      totalSessions: 1000,
    });
    expect(lists).toEqual({
      keyEvents: [
        { name: "generate_lead", count: 20 },
        { name: "purchase", count: 3 },
      ],
    });
  });

  it("caps each list", () => {
    const many = (prefix: string) =>
      Array.from({ length: 10 }, (_, index) => `${prefix}${index}`);
    const lists = buildGaModuleLists({
      channel: [
        slice(
          "2026-10-01",
          CHANNEL_DIMS,
          ["sessions", "engagedSessions", "keyEvents"],
          many("c").map((name, index) => [name, 100 - index, 1, 0]),
        ),
      ],
      landing: [
        slice(
          "2026-10-01",
          LANDING_DIMS,
          ["sessions", "engagedSessions", "keyEvents"],
          many("/p").map((name, index) => [name, 100 - index, 1, 0]),
        ),
      ],
      events: [
        slice(
          "2026-10-01",
          EVENT_DIMS,
          ["keyEvents"],
          many("e").map((name, index) => [name, "true", 100 - index]),
        ),
      ],
      totalSessions: 1000,
    });
    expect(lists.channels).toHaveLength(6);
    expect(lists.landingPages).toHaveLength(5);
    expect(lists.keyEvents).toHaveLength(5);
    expect(lists.keyEvents?.[0]).toEqual({ name: "e0", count: 100 });
  });

  it("omits a list whose slices are not given or that comes out empty", () => {
    expect(
      buildGaModuleLists({
        channel: null,
        landing: null,
        events: null,
        totalSessions: 10,
      }),
    ).toEqual({});
    const lists = buildGaModuleLists({
      channel: [],
      landing: [
        slice("2026-10-01", LANDING_DIMS, LANDING_METRICS, [
          ["(not set)", 5, 1, 0, 0, 0],
        ]),
      ],
      events: [
        slice("2026-10-01", EVENT_DIMS, EVENT_METRICS, [
          ["page_view", "false", 10, 0, 3],
        ]),
      ],
      totalSessions: 10,
    });
    expect(lists).toEqual({});
    expect(Object.keys(lists)).toEqual([]);
  });
});
