import { describe, expect, it } from "vitest";

import { addDays, daysInRange } from "@/lib/website-analytics/days";

import { evaluateChanges, explainChange, seasonalWow } from "./changes";
import { poissonRateTest } from "./stats";
import type {
  An2Evidence,
  GaAnalysisDay,
  GaDecomposition,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

const MONDAY = "2026-09-28";
const SUNDAY = "2026-10-04";

type TableTotals = {
  sessions?: number;
  keyEvents?: number;
  revenue?: number;
  transactions?: number;
};

// Kanal satırları [sessions, engagedSessions, keyEvents, totalRevenue].
function tables(
  from: string,
  to: string,
  totals: TableTotals,
  channel?: [string, number, number, number?][],
  landing?: [string, number, number][],
): GaWindowTables {
  const sessions = totals.sessions ?? 0;
  const keyEvents = totals.keyEvents ?? 0;
  const revenue = totals.revenue ?? 0;
  const days = daysInRange(from, to);
  return {
    from,
    to,
    days,
    usedDays: days,
    excludedDays: [],
    missingDays: 0,
    totals: {
      sessions,
      engagedSessions: Math.round(sessions / 2),
      keyEvents,
      revenue,
      transactions: totals.transactions ?? 0,
      engagementSec: 0,
      screenPageViews: 0,
    },
    channel: (channel ?? [["Direct", sessions, keyEvents, revenue]]).map(
      ([name, s, k, r]) => ({
        key: [name],
        values: [s, Math.round(s / 2), k, r ?? 0],
      }),
    ),
    landing: (landing ?? []).map(([path, s, k]) => ({
      key: [path],
      values: [s, 0, k, 0, 0],
    })),
    landingOther: null,
    sourceMedium: [],
    campaign: [],
    device: [],
    country: [],
    pages: [],
    events: [],
    newReturning: [],
    quality: { thresholded: false, otherRow: false, truncated: false },
    coverage: {},
  };
}

const PREVIOUS_FROM = addDays(MONDAY, -7);
const PREVIOUS_TO = addDays(SUNDAY, -7);

function current(
  totals: TableTotals,
  channel?: [string, number, number, number?][],
) {
  return tables(MONDAY, SUNDAY, totals, channel);
}
function previous(
  totals: TableTotals,
  channel?: [string, number, number, number?][],
) {
  return tables(PREVIOUS_FROM, PREVIOUS_TO, totals, channel);
}

function explain(
  cur: GaWindowTables,
  prev: GaWindowTables,
  metric: "auto" | "keyEvents" | "sessions" | "revenue" = "auto",
) {
  return explainChange({
    metric,
    comparison: "wow",
    current: cur,
    previous: prev,
    perDay: false,
    holidays: [],
    suspectDays: [],
    seasonal: null,
  });
}

function sumOf(decomposition: GaDecomposition): number {
  return (
    decomposition.components.reduce((sum, c) => sum + c.total, 0) +
    (decomposition.other?.total ?? 0) +
    decomposition.residual
  );
}

function weeklyInput(
  partial: Partial<GaWeeklyAnalysisInput>,
): GaWeeklyAnalysisInput {
  return {
    linkId: "link-1",
    today: "2026-10-05",
    week: { monday: MONDAY, sunday: SUNDAY },
    country: null,
    days: [],
    suspect: new Set(),
    holidays: new Set(),
    current: current({ sessions: 1_000 }),
    previous: previous({ sessions: 1_000 }),
    lastYear: null,
    window28: tables(addDays(SUNDAY, -27), SUNDAY, {}),
    window28Previous: tables(addDays(SUNDAY, -55), addDays(SUNDAY, -28), {}),
    weeks: [],
    month: null,
    siteSearch: null,
    currency: null,
    measurementDegraded: false,
    ...partial,
  };
}

describe("explainChange metric choice", () => {
  it.each([
    [29, "sessions"],
    [30, "keyEvents"],
  ] as const)("auto with %d key events → %s", (keyEvents, metric) => {
    const { evidence } = explain(
      current({ sessions: 1_000, keyEvents }),
      previous({ sessions: 900, keyEvents: 10 }),
    );
    expect(evidence.metric).toBe(metric);
    expect(evidence.metricReason).toBe("requested");
  });

  it("switches a requested keyEvents to sessions when key events are few", () => {
    const { evidence } = explain(
      current({ sessions: 1_000, keyEvents: 29 }),
      previous({ sessions: 900, keyEvents: 10 }),
      "keyEvents",
    );
    expect(evidence.metric).toBe("sessions");
    expect(evidence.metricReason).toBe("low_key_events");
    const kept = explain(
      current({ sessions: 1_000, keyEvents: 30 }),
      previous({ sessions: 900, keyEvents: 10 }),
      "keyEvents",
    );
    expect(kept.evidence.metric).toBe("keyEvents");
    expect(kept.evidence.metricReason).toBe("requested");
  });
});

describe("explainChange significance", () => {
  it("flips at the Poisson p = 0.05 boundary", () => {
    expect(poissonRateTest(241, 200, 7, 7)!.p).toBeGreaterThan(0.05);
    expect(poissonRateTest(242, 200, 7, 7)!.p).toBeLessThan(0.05);
    expect(
      explain(current({ sessions: 241 }), previous({ sessions: 200 }))
        .significance,
    ).toBe("not_significant");
    expect(
      explain(current({ sessions: 242 }), previous({ sessions: 200 }))
        .significance,
    ).toBe("significant");
  });

  it("needs |changePct| ≥ 10", () => {
    const low = explain(
      current({ sessions: 10_990 }),
      previous({ sessions: 10_000 }),
    );
    expect(low.evidence.changePct).toBeCloseTo(9.9, 9);
    expect(low.evidence.p!).toBeLessThan(0.05);
    expect(low.significance).toBe("not_significant");
    const enough = explain(
      current({ sessions: 11_000 }),
      previous({ sessions: 10_000 }),
    );
    expect(enough.evidence.changePct).toBeCloseTo(10, 9);
    expect(enough.significance).toBe("significant");
  });

  it("is low_volume below 20 counts and for revenue below 10 transactions", () => {
    expect(
      explain(current({ sessions: 15 }), previous({ sessions: 4 }))
        .significance,
    ).toBe("low_volume");
    const revenue = explain(
      current({ sessions: 5_000, revenue: 9_000, transactions: 9 }),
      previous({ sessions: 5_000, revenue: 1_000, transactions: 9 }),
      "revenue",
    );
    expect(revenue.evidence.metric).toBe("revenue");
    expect(revenue.significance).toBe("low_volume");
    const tested = explain(
      current({ sessions: 5_000, revenue: 9_000, transactions: 90 }),
      previous({ sessions: 5_000, revenue: 1_000, transactions: 10 }),
      "revenue",
    );
    expect(tested.significance).toBe("significant");
    expect(tested.evidence.change).toBe(8_000);
  });

  it("has changePct null and is never significant when previous is 0", () => {
    const result = explain(
      current({ sessions: 500 }),
      previous({ sessions: 0 }),
    );
    expect(result.evidence.changePct).toBeNull();
    expect(result.significance).toBe("not_significant");
  });
});

describe("explainChange decomposition", () => {
  it("makes components sum to the total change exactly (acceptance)", () => {
    const cur = tables(
      MONDAY,
      SUNDAY,
      { sessions: 2_400, keyEvents: 130 },
      [
        ["Organic Search", 1_200, 80],
        ["Direct", 700, 30],
        ["Paid Search", 300, 15],
        ["Referral", 150, 5],
      ],
      [
        ["/", 900, 40],
        ["/pricing", 300, 30],
        ["/blog/a", 200, 5],
      ],
    );
    const prev = tables(
      PREVIOUS_FROM,
      PREVIOUS_TO,
      { sessions: 2_000, keyEvents: 90 },
      [
        ["Organic Search", 900, 50],
        ["Direct", 750, 25],
        ["Paid Search", 250, 12],
        ["Email", 50, 3],
      ],
      [
        ["/", 800, 30],
        ["/pricing", 250, 20],
        ["/contact", 100, 10],
      ],
    );
    const { evidence } = explain(cur, prev);
    expect(evidence.metric).toBe("keyEvents");
    expect(evidence.change).toBe(40);
    expect(
      Math.abs(sumOf(evidence.channels) - evidence.change),
    ).toBeLessThanOrEqual(1e-9);
    expect(
      Math.abs(sumOf(evidence.pages!) - evidence.change),
    ).toBeLessThanOrEqual(1e-9);
    // Kanallar toplamın tamamını taşıyor: residual 0; sayfalar kırpılmış: residual taşır.
    expect(evidence.channels.residual).toBeCloseTo(0, 9);
    expect(evidence.pages!.residual).not.toBeCloseTo(0, 3);
    expect(evidence.channels.components[0]!.key).toBe("Organic Search");
  });

  it("has no page decomposition when a landing table is empty", () => {
    const { evidence } = explain(
      current({ sessions: 100 }),
      previous({ sessions: 100 }),
    );
    expect(evidence.pages).toBeNull();
  });

  it("normalises MoM per day for 30 vs 31 day months", () => {
    const september = tables("2026-09-01", "2026-09-30", { sessions: 3_000 });
    const august = tables("2026-08-01", "2026-08-31", { sessions: 3_100 });
    const flat = explainChange({
      metric: "sessions",
      comparison: "mom",
      current: september,
      previous: august,
      perDay: true,
      holidays: [],
      suspectDays: [],
      seasonal: null,
    });
    expect(flat.evidence.channels.before).toBe(100);
    expect(flat.evidence.channels.after).toBe(100);
    expect(flat.evidence.change).toBe(0);
    expect(flat.evidence.changePct).toBe(0);
    expect(flat.evidence.channels.perDay).toBe(true);
    expect(flat.significance).toBe("not_significant");
    // Ham toplamlarda %3.2 düşüş vardı; gün başına değişim yok.
    expect(flat.evidence.current.total).toBe(3_000);
    expect(flat.evidence.previous.total).toBe(3_100);
  });
});

function days(
  from: string,
  to: string,
  pick: (day: string) => Partial<GaAnalysisDay>,
): GaAnalysisDay[] {
  const list: GaAnalysisDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    list.push({
      day,
      sessions: 100,
      engagedSessions: 50,
      keyEvents: 0,
      revenue: 0,
      transactions: 0,
      isFinal: true,
      ...pick(day),
    });
  }
  return list;
}

describe("seasonalWow", () => {
  it("compares last year's aligned week with the week before it", () => {
    const lastYearMonday = addDays(MONDAY, -364);
    const series = days(
      addDays(MONDAY, -371),
      addDays(SUNDAY, -364),
      (day) => ({
        sessions: day >= lastYearMonday ? 130 : 100,
      }),
    );
    expect(
      seasonalWow(series, { monday: MONDAY, sunday: SUNDAY }, "sessions")!
        .lastYearChangePct,
    ).toBeCloseTo(30, 9);
    expect(
      seasonalWow(
        series.slice(1),
        { monday: MONDAY, sunday: SUNDAY },
        "sessions",
      ),
    ).toBeNull();
  });
});

describe("evaluateChanges", () => {
  const up = {
    cur: current({ sessions: 1_300 }),
    prev: previous({ sessions: 1_000 }),
  };

  it("creates a significant WoW change candidate", () => {
    const candidates = evaluateChanges(
      weeklyInput({ current: up.cur, previous: up.prev }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      ruleKey: "AN2",
      kind: "CHANGE",
      subject: "site:sessions:wow",
      severity: "INFO",
      confidence: "SIGNIFICANT",
      period: { grain: "WEEK", from: MONDAY, to: SUNDAY, key: "2026-W40:wow" },
      impact: null,
    });
    expect(candidates[0]!.impactShare).toBeCloseTo(0.3, 9);
  });

  it("is WARN for a drop of 25% or more", () => {
    const candidates = evaluateChanges(
      weeklyInput({
        current: current({ sessions: 750 }),
        previous: previous({ sessions: 1_000 }),
      }),
    );
    expect(candidates[0]!.severity).toBe("WARN");
    const smaller = evaluateChanges(
      weeklyInput({
        current: current({ sessions: 760 }),
        previous: previous({ sessions: 1_000 }),
      }),
    );
    expect(smaller[0]!.severity).toBe("INFO");
  });

  it.each([
    ["current", "2026-09-30"],
    ["previous", "2026-09-23"],
  ])("drops the candidate with a holiday in the %s week", (_week, holiday) => {
    expect(
      evaluateChanges(
        weeklyInput({
          current: up.cur,
          previous: up.prev,
          holidays: new Set([holiday]),
        }),
      ),
    ).toEqual([]);
  });

  it("drops the candidate with a suspect day", () => {
    expect(
      evaluateChanges(
        weeklyInput({
          current: up.cur,
          previous: up.prev,
          suspect: new Set(["2026-09-22"]),
        }),
      ),
    ).toEqual([]);
  });

  it("suppresses WoW when last year moved the same way", () => {
    const lastYearMonday = addDays(MONDAY, -364);
    const seasonal = (lastYear: number) =>
      days(addDays(MONDAY, -371), SUNDAY, (day) => ({
        sessions:
          day >= lastYearMonday && day <= addDays(SUNDAY, -364)
            ? lastYear
            : 100,
      }));
    expect(
      evaluateChanges(
        weeklyInput({
          current: up.cur,
          previous: up.prev,
          days: seasonal(120),
        }),
      ),
    ).toEqual([]);
    // %14 < 0.5 · %30: eşleşme değil.
    const kept = evaluateChanges(
      weeklyInput({ current: up.cur, previous: up.prev, days: seasonal(114) }),
    );
    expect(kept).toHaveLength(1);
    expect(
      (kept[0]!.evidence as An2Evidence).seasonal!.lastYearChangePct,
    ).toBeCloseTo(14, 9);
    expect(
      evaluateChanges(
        weeklyInput({ current: up.cur, previous: up.prev, days: seasonal(80) }),
      ),
    ).toHaveLength(1);
  });

  it("adds YoY only with lastYear and MoM with month", () => {
    const lastYear = tables(addDays(MONDAY, -364), addDays(SUNDAY, -364), {
      sessions: 1_000,
    });
    const withYoy = evaluateChanges(
      weeklyInput({ current: up.cur, previous: up.prev, lastYear }),
    );
    expect(withYoy.map((c) => c.subject)).toEqual([
      "site:sessions:wow",
      "site:sessions:yoy",
    ]);
    expect(withYoy[1]!.period.key).toBe("2026-W40:yoy");

    const month = {
      month: "2026-09",
      current: tables("2026-09-01", "2026-09-30", { sessions: 3_600 }),
      previous: tables("2026-08-01", "2026-08-31", { sessions: 3_100 }),
    };
    const withMom = evaluateChanges(
      weeklyInput({ current: up.cur, previous: up.prev, month }),
    );
    const mom = withMom.find((c) => c.subject === "site:sessions:mom")!;
    expect(mom.period).toEqual({
      grain: "MONTH",
      from: "2026-09-01",
      to: "2026-09-30",
      key: "2026-09:mom",
    });
    expect((mom.evidence as An2Evidence).changePct).toBeCloseTo(20, 9);
  });

  it("marks preliminary when a current day is not final", () => {
    const candidates = evaluateChanges(
      weeklyInput({
        current: up.cur,
        previous: up.prev,
        days: days(PREVIOUS_FROM, SUNDAY, (day) => ({
          isFinal: day !== SUNDAY,
        })),
      }),
    );
    expect((candidates[0]!.evidence as An2Evidence).preliminary).toBe(true);
  });
});
