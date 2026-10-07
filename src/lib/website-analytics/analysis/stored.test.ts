import { describe, expect, it } from "vitest";

import {
  evidenceHolidays,
  evidencePreliminary,
  parseGaFindingEvidence,
  parseGaImpact,
  parseGaOutcomeEvidence,
} from "./stored";
import type {
  GaDecomposition,
  GaFindingEvidence,
  GaOutcomeEvidence,
} from "./types";

// Bu dosyanın kanıtladığı: her kanıt türü JSON'dan geri okunur; bozuk kanıt
// null; bu sürümde eklenen alanlar (holidays, preliminary, siteUpliftPct)
// eksik eski satırlarda varsayılan alır; bozuk dizi elemanları atılır.

const window = { from: "2026-09-07", to: "2026-10-04" };

const decomposition: GaDecomposition = {
  metric: "keyEvents",
  dimension: "channel",
  before: 100,
  after: 80,
  delta: -20,
  perDay: false,
  components: [
    {
      key: "Organic Search",
      label: "Organic Search",
      sessionsBefore: 1000,
      sessionsAfter: 900,
      valueBefore: 50,
      valueAfter: 40,
      rateBefore: 0.05,
      rateAfter: 0.0444,
      volume: -5,
      rate: -5,
      total: -10,
      share: 0.5,
    },
  ],
  other: { count: 2, volume: -1, rate: -1, total: -2 },
  residual: -8,
};

const samples: GaFindingEvidence[] = [
  {
    v: 1,
    rule: "AN1",
    mode: "day",
    target: "2026-10-05",
    readings: [
      {
        metric: "keyEvents",
        value: 2,
        median: 20,
        scale: 4.5,
        z: -4,
        direction: "down",
        baselineDays: ["2026-09-28"],
      },
    ],
    primary: "keyEvents",
    excludedDays: [],
    breakdown: decomposition,
    seasonalChecked: true,
    preliminary: true,
  },
  {
    v: 1,
    rule: "AN2",
    comparison: "wow",
    metric: "keyEvents",
    metricReason: "requested",
    current: { from: "2026-09-28", to: "2026-10-04", days: 7, total: 80 },
    previous: { from: "2026-09-21", to: "2026-09-27", days: 7, total: 100 },
    change: -20,
    changePct: -20,
    z: -3,
    p: 0.002,
    channels: decomposition,
    pages: null,
    holidays: ["2026-10-01"],
    suspectDays: [],
    seasonal: { lastYearChangePct: -2 },
    preliminary: false,
  },
  {
    v: 1,
    rule: "AN3",
    variant: "cro",
    window,
    page: "/pricing",
    sessions: 900,
    keyEvents: 2,
    rate: 0.0022,
    restSessions: 9000,
    restKeyEvents: 200,
    restRate: 0.0222,
    ratio: 0.1,
    threshold: 0.5,
    p: 0.0001,
    bhAccepted: true,
    excludedDays: [],
    holidays: [],
  },
  {
    v: 1,
    rule: "AN4",
    window,
    channel: "Paid Search",
    measure: "engagement",
    direction: "below",
    sessions: 1000,
    hits: 300,
    rate: 0.3,
    restSessions: 9000,
    restHits: 5400,
    restRate: 0.6,
    ratio: 0.5,
    p: 0.0001,
    bhAccepted: true,
    excludedDays: ["2026-09-10"],
    holidays: [],
  },
  {
    v: 1,
    rule: "AN5",
    window,
    mobile: { sessions: 5000, keyEvents: 25, rate: 0.005 },
    desktop: { sessions: 4000, keyEvents: 80, rate: 0.02 },
    ratio: 0.25,
    p: 0.0001,
    excludedDays: [],
    holidays: [],
  },
  {
    v: 1,
    rule: "AN6",
    weeks: [{ monday: "2026-09-28", returning: 300, total: 1000, share: 0.3 }],
    earlyShare: 0.4,
    lateShare: 0.3,
    dropPoints: 10,
    p: 0.01,
  },
  {
    v: 1,
    rule: "AN7",
    current: { ...window, sessions: 120, keyEvents: 5 },
    previous: {
      from: "2026-08-10",
      to: "2026-09-06",
      sessions: 40,
      keyEvents: 1,
    },
    assistants: [{ name: "ChatGPT", sessions: 100, previousSessions: 30 }],
    changePct: 200,
    p: 0.001,
    firstSeen: false,
    siteSessions: 20000,
    holidays: [],
  },
  {
    v: 1,
    rule: "AN8",
    weeks: ["2026-09-28"],
    terms: [{ term: "prices", searches: 40 }],
    totalSearches: 100,
    siteSessions: 5000,
  },
  {
    v: 1,
    rule: "AN9",
    week: { from: "2026-09-28", to: "2026-10-04" },
    pages: [{ path: "/old", title: "Page not found", views: 50 }],
    views: 50,
  },
  {
    v: 1,
    rule: "AN10",
    window: { from: "2026-09-01", to: "2026-09-30" },
    month: "2026-09",
    pages: [
      {
        path: "/blog/a",
        sessions: 300,
        engagementRate: 0.8,
        avgEngagementSec: 120,
        keyEvents: 3,
      },
    ],
    siteEngagementRate: 0.5,
    siteAvgEngagementSec: 40,
    holidays: [],
  },
  {
    v: 1,
    rule: "AN11",
    week: { from: "2026-09-28", to: "2026-10-04" },
    baselineWeeks: ["2026-09-21", "2026-09-14"],
    step: {
      from: "add_to_cart",
      to: "begin_checkout",
      current: { entered: 200, completed: 40, rate: 0.2 },
      baseline: { entered: 800, completed: 320, rate: 0.4 },
      p: 0.0001,
      dropPct: -50,
    },
    aov: { current: 42.5, baseline: null },
  },
  {
    v: 1,
    rule: "AN12",
    window,
    campaign: "autumn",
    source: "newsletter",
    medium: "email",
    agentelse: true,
    direction: "below",
    sessions: 500,
    keyEvents: 1,
    rate: 0.002,
    restSessions: 9000,
    restKeyEvents: 180,
    restRate: 0.02,
    ratio: 0.1,
    p: 0.01,
    bhAccepted: false,
    excludedDays: [],
    holidays: [],
  },
  {
    v: 1,
    rule: "AN15",
    goalId: "g1",
    goalTitle: "Leads",
    metricKey: "web.key_events",
    month: "2026-10",
    target: 100,
    monthToDate: 10,
    forecast: 40,
    paceRatio: 0.4,
    dayOfMonth: 7,
    daysInMonth: 31,
    through: "2026-10-07",
  },
  {
    v: 1,
    rule: "AN13",
    window,
    campaignExternalId: "120001",
    label: "Spring sale",
    metaCurrency: "EUR",
    meta: {
      ads: 2,
      spend: 500.5,
      linkClicks: 200,
      landingPageViews: 150,
      results: 20,
      resultActionType: "offsite_conversion.fb_pixel_purchase",
      activeDays: 14,
    },
    ga: { sessions: 60, engagedSessions: 40, keyEvents: 18, revenue: 0 },
    checks: ["clicks", "results"],
    clickLoss: 0.7,
    clickRateHigh: 0.37,
    resultsGap: 0.1,
    resultsP: null,
    costPerResult: 25.025,
    costPerKeyEvent: null,
    excludedDays: ["2026-09-20"],
    holidays: [],
  },
  {
    v: 1,
    rule: "AN14",
    window,
    previousWindow: { from: "2026-08-10", to: "2026-09-06" },
    campaign: "Brand search",
    direction: "worse",
    current: {
      cost: 1000,
      clicks: 500,
      sessions: 450,
      keyEvents: 20,
      revenue: 0,
      costPerKeyEvent: 50,
      roas: null,
    },
    previous: {
      cost: 1000,
      clicks: 500,
      sessions: 450,
      keyEvents: 40,
      revenue: 4000,
      costPerKeyEvent: 25,
      roas: 4,
    },
    changePct: 100,
    p: 0.01,
    bhAccepted: true,
    excludedDays: [],
    holidays: ["2026-09-10"],
  },
];

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

// Eski sürümün yazdığı satır: verilen alanlar hiç yok.
function without(value: unknown, ...keys: string[]): Record<string, unknown> {
  const copy = roundTrip(value) as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy;
}

describe("parseGaFindingEvidence", () => {
  it.each(samples.map((sample) => [sample.rule, sample] as const))(
    "%s round-trips",
    (_rule, sample) => {
      expect(parseGaFindingEvidence(roundTrip(sample))).toEqual(sample);
    },
  );

  it("returns null on malformed input", () => {
    expect(parseGaFindingEvidence(null)).toBeNull();
    expect(parseGaFindingEvidence("AN1")).toBeNull();
    expect(parseGaFindingEvidence([])).toBeNull();
    expect(parseGaFindingEvidence({ ...samples[0], v: 2 })).toBeNull();
    expect(parseGaFindingEvidence({ ...samples[0], v: undefined })).toBeNull();
    expect(parseGaFindingEvidence({ ...samples[0], rule: "AN16" })).toBeNull();
    expect(parseGaFindingEvidence({ ...samples[0], rule: "AN13" })).toBeNull();
    expect(
      parseGaFindingEvidence({ ...samples[0], rule: undefined }),
    ).toBeNull();
    expect(parseGaFindingEvidence({ ...samples[0], target: 5 })).toBeNull();
    expect(
      parseGaFindingEvidence({ ...samples[2], sessions: "900" }),
    ).toBeNull();
    expect(
      parseGaFindingEvidence({ ...samples[1], channels: null }),
    ).toBeNull();
    expect(
      parseGaFindingEvidence({ ...samples[3], direction: "sideways" }),
    ).toBeNull();
  });

  it("rejects malformed AN13 and AN14 evidence", () => {
    const an13 = samples[samples.length - 2]!;
    const an14 = samples[samples.length - 1]!;
    expect(
      parseGaFindingEvidence({ ...an13, meta: { ...(an13 as { meta: object }).meta, linkClicks: "200" } }),
    ).toBeNull();
    expect(parseGaFindingEvidence({ ...an13, ga: null })).toBeNull();
    expect(parseGaFindingEvidence({ ...an13, label: 5 })).toBeNull();
    expect(
      parseGaFindingEvidence({ ...an13, costPerKeyEvent: "12" }),
    ).toBeNull();
    expect(parseGaFindingEvidence({ ...an14, direction: "flat" })).toBeNull();
    expect(parseGaFindingEvidence({ ...an14, current: undefined })).toBeNull();
    expect(
      parseGaFindingEvidence({
        ...an14,
        previous: { ...(an14 as { previous: object }).previous, roas: "4" },
      }),
    ).toBeNull();
    expect(parseGaFindingEvidence({ ...an14, changePct: null })).toBeNull();
  });

  it("defaults missing excludedDays and holidays on AN13 and AN14", () => {
    const an13 = samples[samples.length - 2]!;
    const an14 = samples[samples.length - 1]!;
    const parsed13 = parseGaFindingEvidence(
      without(an13, "excludedDays", "holidays"),
    )!;
    expect(parsed13).toMatchObject({ excludedDays: [], holidays: [] });
    const parsed14 = parseGaFindingEvidence(
      without(an14, "excludedDays", "holidays"),
    )!;
    expect(parsed14).toMatchObject({ excludedDays: [], holidays: [] });
    expect(evidenceHolidays(parsed14)).toEqual([]);
  });

  it("defaults fields added in this revision", () => {
    const parsedAn1 = parseGaFindingEvidence(without(samples[0], "preliminary"))!;
    expect(evidencePreliminary(parsedAn1)).toBe(false);

    const parsedAn2 = parseGaFindingEvidence(
      without(samples[1], "holidays", "preliminary"),
    )!;
    expect(evidenceHolidays(parsedAn2)).toEqual([]);
    expect(evidencePreliminary(parsedAn2)).toBe(false);

    expect(
      evidenceHolidays(parseGaFindingEvidence(without(samples[2], "holidays"))!),
    ).toEqual([]);
  });

  it("filters malformed array entries and keeps unknown fields", () => {
    const an8 = {
      ...samples[7],
      terms: [{ term: "prices", searches: 40 }, { term: 3 }, null],
      extra: "kept",
    };
    const parsed = parseGaFindingEvidence(an8) as Record<string, unknown>;
    expect(parsed.terms).toEqual([{ term: "prices", searches: 40 }]);
    expect(parsed.extra).toBe("kept");
  });
});

describe("evidenceHolidays and evidencePreliminary", () => {
  it("reads holidays where present and preliminary for AN1/AN2", () => {
    expect(evidenceHolidays(samples[1]!)).toEqual(["2026-10-01"]);
    expect(evidenceHolidays(samples[0]!)).toEqual([]);
    expect(evidenceHolidays(samples[7]!)).toEqual([]);
    expect(evidencePreliminary(samples[0]!)).toBe(true);
    expect(evidencePreliminary(samples[1]!)).toBe(false);
    expect(evidencePreliminary(samples[2]!)).toBe(false);
  });
});

describe("parseGaImpact", () => {
  it("round-trips and rejects malformed values", () => {
    const impact = {
      metric: "keyEvents",
      perWeek: 4.2,
      low: 1.1,
      high: 8,
      directional: false,
    };
    expect(parseGaImpact(roundTrip(impact))).toEqual(impact);
    expect(parseGaImpact({ ...impact, metric: "clicks" })).toBeNull();
    expect(parseGaImpact({ ...impact, perWeek: null })).toBeNull();
    expect(parseGaImpact(null)).toBeNull();
  });
});

describe("parseGaOutcomeEvidence", () => {
  const outcome: GaOutcomeEvidence = {
    v: 1,
    before: {
      from: "2026-09-12",
      to: "2026-10-09",
      sessions: 900,
      hits: 9,
      rate: 0.01,
    },
    after: {
      from: "2026-10-17",
      to: "2026-11-13",
      sessions: 950,
      hits: 19,
      rate: 0.02,
    },
    siteBefore: { rate: 0.02 },
    siteAfter: { rate: 0.021 },
    p: 0.04,
    upliftPct: 100,
    siteUpliftPct: 5,
    reason: "worked",
  };

  it("round-trips and defaults siteUpliftPct", () => {
    expect(parseGaOutcomeEvidence(roundTrip(outcome))).toEqual(outcome);
    expect(
      parseGaOutcomeEvidence(without(outcome, "siteUpliftPct"))?.siteUpliftPct,
    ).toBeNull();
    expect(parseGaOutcomeEvidence({ ...outcome, reason: "maybe" })).toBeNull();
    expect(parseGaOutcomeEvidence({ ...outcome, v: 2 })).toBeNull();
  });
});
