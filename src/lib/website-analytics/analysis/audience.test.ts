import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";

import { evaluateReturningShare } from "./audience";
import type {
  An6Evidence,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

const MONDAY = "2026-09-28";
const SUNDAY = "2026-10-04";

function tables(
  from: string,
  to: string,
  partial: Partial<GaWindowTables> = {},
): GaWindowTables {
  return {
    from,
    to,
    days: 7,
    usedDays: 7,
    excludedDays: [],
    missingDays: 0,
    totals: {
      sessions: 0,
      engagedSessions: 0,
      keyEvents: 0,
      revenue: 0,
      transactions: 0,
      engagementSec: 0,
      screenPageViews: 0,
    },
    channel: [],
    landing: [],
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
    ...partial,
  };
}

// Hafta başına [toplam oturum, geri gelen oturum]; eskiden yeniye 8 hafta.
function weeks(values: [number, number][]): GaWindowTables[] {
  return values.map(([total, returning], index) => {
    const monday = addDays(MONDAY, -7 * (values.length - 1 - index));
    return tables(monday, addDays(monday, 6), {
      newReturning: [
        { key: ["new"], values: [0, total - returning, 0] },
        { key: ["returning"], values: [0, returning, 0] },
        { key: ["(not set)"], values: [0, 999, 0] },
      ],
    });
  });
}

function input(weekTables: GaWindowTables[]): GaWeeklyAnalysisInput {
  return {
    linkId: "link-1",
    today: "2026-10-05",
    week: { monday: MONDAY, sunday: SUNDAY },
    country: null,
    days: [],
    suspect: new Set(),
    holidays: new Set(),
    current: tables(MONDAY, SUNDAY),
    previous: tables(addDays(MONDAY, -7), addDays(SUNDAY, -7)),
    lastYear: null,
    window28: tables(addDays(SUNDAY, -27), SUNDAY),
    window28Previous: tables(addDays(SUNDAY, -55), addDays(SUNDAY, -28)),
    weeks: weekTables,
    month: null,
    siteSearch: null,
    currency: null,
    measurementDegraded: false,
  };
}

function series(
  lateReturning: number,
  total = 500,
  lastTotal = total,
): [number, number][] {
  return [
    [total, total * 0.4],
    [total, total * 0.4],
    [total, total * 0.38],
    [total, total * 0.37],
    [total, total * 0.37],
    [total, total * 0.36],
    [total, lateReturning],
    [lastTotal, (lateReturning / total) * lastTotal],
  ];
}

describe("evaluateReturningShare", () => {
  it("needs 500 sessions in every week", () => {
    expect(
      evaluateReturningShare(input(weeks(series(175, 500, 499)))),
    ).toBeNull();
    expect(
      evaluateReturningShare(input(weeks(series(175, 500, 500)))),
    ).not.toBeNull();
  });

  it.each([
    [351, null],
    [350, 5],
  ])("late returning %d of 1000 → drop %s points", (lateReturning, points) => {
    const candidate = evaluateReturningShare(
      input(weeks(series(lateReturning, 1_000))),
    );
    if (points === null) {
      expect(candidate).toBeNull();
      return;
    }
    const evidence = candidate!.evidence as An6Evidence;
    expect(evidence.dropPoints).toBeCloseTo(points, 9);
    expect(evidence.earlyShare).toBeCloseTo(0.4, 9);
    expect(evidence.lateShare).toBeCloseTo(0.35, 9);
    expect(evidence.weeks).toHaveLength(8);
    expect(evidence.weeks[7]).toMatchObject({
      monday: MONDAY,
      returning: 350,
      total: 1_000,
    });
    expect(candidate).toMatchObject({
      ruleKey: "AN6",
      kind: "RISK",
      severity: "INFO",
      confidence: "SIGNIFICANT",
      subject: "audience:returning",
      period: { grain: "WEEK", from: MONDAY, to: SUNDAY },
      impact: null,
    });
    expect(candidate!.impactShare).toBeCloseTo(0.05, 9);
    expect(evidence.p!).toBeLessThan(0.05);
  });

  it("needs eight weeks", () => {
    expect(
      evaluateReturningShare(input(weeks(series(300, 1_000)).slice(1))),
    ).toBeNull();
  });
});
