import { describe, expect, it } from "vitest";

import {
  okSection,
  readReport,
  reportHasNumbers,
  type ReportData,
} from "./report";
import {
  BUILD_STALE_MS,
  analyticsCardData,
  canBuild,
  isFlowComplete,
  openableSteps,
  readAnalyticsState,
} from "./state";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

const report: ReportData = {
  period: 28,
  builtAt: "2026-10-05T11:00:00.000Z",
  sections: [
    {
      source: "instagram",
      ok: true,
      account: "@biduniq",
      days: 28,
      currency: null,
      metrics: [{ key: "ig.reach", value: 1200 }],
      results: [],
      campaigns: [],
      queries: [],
    },
    { source: "ga4", ok: false, reason: "expired" },
  ],
  summary: null,
  summaryNote: "No summary.",
};

describe("readAnalyticsState", () => {
  it("gives the defaults for an empty card (a new flow)", () => {
    expect(readAnalyticsState({})).toEqual({
      period: 28,
      sources: [],
      sections: [],
      build: null,
      report: null,
      error: null,
      sharedAt: null,
    });
  });

  it("never trusts the stored shape: bad fields fall back one by one", () => {
    const state = readAnalyticsState({
      period: 30,
      sources: ["ga4", "tiktok", "instagram", "ga4", 7],
      sections: ["metaAds", "ga4"],
      build: { id: "", startedAt: "yesterday", from: "plan" },
      report: { period: 28, builtAt: "not a date", sections: [] },
      error: { text: "x" },
      sharedAt: "soon",
    });
    expect(state.period).toBe(28);
    // Known sources, once each, in report order.
    expect(state.sources).toEqual(["instagram", "ga4"]);
    // A section is always one of the brief's sources.
    expect(state.sections).toEqual(["ga4"]);
    expect(state.build).toBeNull();
    expect(state.report).toBeNull();
    expect(state.error).toBeNull();
    expect(state.sharedAt).toBeNull();
  });

  it("round-trips what the card writes", () => {
    const state = readAnalyticsState({
      period: 7,
      sources: ["instagram", "ga4"],
      sections: ["instagram"],
      build: null,
      report,
      error: null,
      sharedAt: "2026-10-05T11:30:00.000Z",
    });
    expect(readAnalyticsState(analyticsCardData(state))).toEqual(state);
    expect(state.report).toEqual(report);
  });
});

describe("readReport", () => {
  it("drops unknown or foreign metrics and malformed rows, keeps the rest", () => {
    const read = readReport({
      ...report,
      sections: [
        {
          source: "instagram",
          ok: true,
          days: 28,
          account: 42,
          currency: "try",
          metrics: [
            { key: "ig.reach", value: 10 },
            { key: "ads.spend", value: 5 },
            { key: "toString", value: 1 },
            { key: "ig.views", value: "12" },
            { key: "ig.reach", value: 11 },
          ],
          queries: [{ query: "", clicks: 1 }],
        },
        { source: "ga4", ok: false, reason: "on fire" },
        { source: "metaAds", ok: false, reason: "rate_limited" },
      ],
      summary: { headline: "  Up  ", highlights: ["a", 3, "b", "c", "d"] },
    });
    expect(read?.sections).toEqual([
      {
        source: "instagram",
        ok: true,
        account: null,
        days: 28,
        currency: null,
        metrics: [{ key: "ig.reach", value: 10 }],
        results: [],
        campaigns: [],
        queries: [],
      },
      { source: "metaAds", ok: false, reason: "rate_limited" },
    ]);
    expect(read?.summary).toEqual({
      headline: "Up",
      highlights: ["a", "b", "c"],
      watchouts: [],
      nextSteps: [],
    });
  });

  it("round-trips Google Analytics channels, landing pages and key events", () => {
    const withLists: ReportData = {
      ...report,
      sections: [
        report.sections[0]!,
        {
          source: "ga4",
          ok: true,
          account: null,
          days: 28,
          currency: null,
          metrics: [{ key: "ga.sessions", value: 300 }],
          results: [],
          campaigns: [],
          queries: [],
          channels: [
            {
              channel: "Organic Search",
              sessions: 120,
              share: 40,
              engagementRate: 61.5,
              keyEvents: 3,
            },
            {
              channel: "Direct",
              sessions: 0,
              share: null,
              engagementRate: null,
              keyEvents: 0,
            },
          ],
          landingPages: [
            {
              page: "/pricing",
              sessions: 80,
              engagementRate: null,
              keyEvents: 2,
            },
          ],
          keyEvents: [{ name: "generate_lead", count: 5 }],
        },
      ],
    };
    expect(readReport(withLists)).toEqual(withLists);
    expect(readReport(JSON.parse(JSON.stringify(withLists)))).toEqual(
      withLists,
    );
  });

  it("reads an older report without the lists back as it was, with no new keys", () => {
    const stored = JSON.parse(JSON.stringify(report)) as unknown;
    const read = readReport(stored);
    expect(read).toEqual(report);
    for (const section of read?.sections ?? []) {
      expect("channels" in section).toBe(false);
      expect("landingPages" in section).toBe(false);
      expect("keyEvents" in section).toBe(false);
    }
    expect(JSON.stringify(read)).toBe(JSON.stringify(report));
  });

  it("drops malformed list rows and leaves out a list with none left", () => {
    const read = readReport({
      ...report,
      sections: [
        {
          source: "ga4",
          ok: true,
          days: 28,
          metrics: [{ key: "ga.sessions", value: 10 }],
          channels: [
            {
              channel: "  Organic Search ",
              sessions: 5,
              share: 50,
              engagementRate: null,
              keyEvents: 1,
            },
            {
              channel: "",
              sessions: 5,
              share: 50,
              engagementRate: null,
              keyEvents: 1,
            },
            {
              channel: "Direct",
              sessions: -1,
              share: 50,
              engagementRate: null,
              keyEvents: 1,
            },
            { channel: "Email", sessions: 1, keyEvents: 0 },
          ],
          landingPages: [
            { page: 42, sessions: 1, engagementRate: null, keyEvents: 0 },
          ],
          keyEvents: "generate_lead",
        },
      ],
    });
    expect(read?.sections).toEqual([
      {
        source: "ga4",
        ok: true,
        account: null,
        days: 28,
        currency: null,
        metrics: [{ key: "ga.sessions", value: 10 }],
        results: [],
        campaigns: [],
        queries: [],
        channels: [
          {
            channel: "Organic Search",
            sessions: 5,
            share: 50,
            engagementRate: null,
            keyEvents: 1,
          },
        ],
      },
    ]);
    const section = read?.sections[0];
    expect(section && "landingPages" in section).toBe(false);
    expect(section && "keyEvents" in section).toBe(false);
  });

  it("caps the stored lists", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => i);
    const read = readReport({
      ...report,
      sections: [
        {
          source: "ga4",
          ok: true,
          days: 28,
          metrics: [],
          channels: rows(9).map((i) => ({
            channel: `c${i}`,
            sessions: 1,
            share: null,
            engagementRate: null,
            keyEvents: 0,
          })),
          landingPages: rows(9).map((i) => ({
            page: `/p${i}`,
            sessions: 1,
            engagementRate: null,
            keyEvents: 0,
          })),
          keyEvents: rows(9).map((i) => ({ name: `e${i}`, count: 1 })),
        },
      ],
    });
    const section = read?.sections[0];
    expect(section?.ok).toBe(true);
    if (!section?.ok) return;
    expect(section.channels).toHaveLength(6);
    expect(section.landingPages).toHaveLength(5);
    expect(section.keyEvents).toHaveLength(5);
  });

  it("okSection adds a list only when it has rows", () => {
    expect(okSection("ga4", { days: 7, channels: [], keyEvents: [] })).toEqual(
      {
        source: "ga4",
        ok: true,
        account: null,
        days: 7,
        currency: null,
        metrics: [],
        results: [],
        campaigns: [],
        queries: [],
      },
    );
    const section = okSection("ga4", {
      days: 7,
      keyEvents: [{ name: "generate_lead", count: 2 }],
    });
    expect(section.keyEvents).toEqual([{ name: "generate_lead", count: 2 }]);
    expect("channels" in section).toBe(false);
  });

  it("knows a report with no numbers", () => {
    expect(reportHasNumbers(report)).toBe(true);
    expect(
      reportHasNumbers({ ...report, sections: [report.sections[1]!] }),
    ).toBe(false);
    expect(reportHasNumbers(null)).toBe(false);
  });
});

describe("the moves", () => {
  const base = readAnalyticsState({
    period: 28,
    sources: ["instagram", "ga4"],
    report,
  });
  const running = {
    ...base,
    build: {
      id: "b1",
      startedAt: new Date(NOW - 60_000).toISOString(),
      from: "plan" as const,
    },
  };
  const stopped = {
    ...running,
    build: {
      ...running.build,
      startedAt: new Date(NOW - BUILD_STALE_MS - 1).toISOString(),
    },
  };

  it("builds from the plan or a report, never twice at once", () => {
    expect(canBuild("plan", base, NOW)).toBe(true);
    expect(canBuild("review", base, NOW)).toBe(true);
    expect(canBuild("deliver", base, NOW)).toBe(true);
    expect(canBuild("brief", base, NOW)).toBe(false);
    expect(canBuild("create", running, NOW)).toBe(false);
    // A build that stopped can be tried again.
    expect(canBuild("create", stopped, NOW)).toBe(true);
    expect(canBuild("plan", { ...base, sources: [] }, NOW)).toBe(false);
  });

  it("opens back to the brief and plan, forward to a report that exists", () => {
    expect(openableSteps("review", base, NOW)).toEqual({
      brief: true,
      plan: true,
      create: false,
      review: false,
      deliver: true,
    });
    expect(openableSteps("plan", { ...base, report: null }, NOW)).toEqual({
      brief: true,
      plan: false,
      create: false,
      review: false,
      deliver: false,
    });
    // Nothing moves while a build runs; a stopped one can be left.
    expect(Object.values(openableSteps("create", running, NOW))).not.toContain(
      true,
    );
    expect(openableSteps("create", stopped, NOW).plan).toBe(true);
  });

  it("is complete once the report was shared from the Share step", () => {
    expect(isFlowComplete("deliver", base)).toBe(false);
    expect(
      isFlowComplete("deliver", {
        ...base,
        sharedAt: new Date(NOW).toISOString(),
      }),
    ).toBe(true);
    expect(
      isFlowComplete("review", {
        ...base,
        sharedAt: new Date(NOW).toISOString(),
      }),
    ).toBe(false);
  });
});
