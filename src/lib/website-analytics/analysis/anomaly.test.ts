import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";

import {
  dailyVolumeGate,
  evaluateDailyAnomalies,
  evaluateWeeklyAnomaly,
} from "./anomaly";
import { holidaysBetween } from "./holidays";
import type {
  An1Evidence,
  GaAnalysisDay,
  GaDailyAnalysisInput,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

const TARGET = "2026-10-05";

function makeDays(
  from: string,
  to: string,
  pick: (day: string) => Partial<GaAnalysisDay>,
): GaAnalysisDay[] {
  const days: GaAnalysisDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push({
      day,
      sessions: 10_000,
      engagedSessions: 5_000,
      keyEvents: 0,
      revenue: 0,
      transactions: 0,
      isFinal: true,
      ...pick(day),
    });
  }
  return days;
}

function dailyInput(
  partial: Partial<GaDailyAnalysisInput> & { days: GaAnalysisDay[] },
): GaDailyAnalysisInput {
  return {
    linkId: "link-1",
    today: addDays(TARGET, 1),
    targets: [TARGET],
    country: null,
    suspect: new Set(),
    holidays: new Set(),
    channelDays: [],
    goals: [],
    measurementDegraded: false,
    ...partial,
  };
}

// Hedef gün dışında sabit 10 000 oturum: MAD 0, Poisson tabanı √10000 = 100.
function withTarget(
  target: string,
  values: Partial<GaAnalysisDay>,
  extra: (day: string) => Partial<GaAnalysisDay> = () => ({}),
): GaAnalysisDay[] {
  return makeDays(addDays(target, -400), target, (day) =>
    day === target ? { ...extra(day), ...values } : extra(day),
  );
}

function evidenceOf(input: GaDailyAnalysisInput): An1Evidence | null {
  const result = evaluateDailyAnomalies(input);
  const candidate = result.candidates[0];
  return candidate ? (candidate.evidence as An1Evidence) : null;
}

describe("evaluateDailyAnomalies z boundaries", () => {
  it.each([
    [9_801, null],
    [9_800, "DIRECTIONAL"],
    [9_701, "DIRECTIONAL"],
    [9_700, "SIGNIFICANT"],
  ] as const)("sessions %d → %s", (sessions, confidence) => {
    const result = evaluateDailyAnomalies(
      dailyInput({ days: withTarget(TARGET, { sessions }) }),
    );
    if (confidence === null) {
      expect(result.candidates).toEqual([]);
      expect(result.days).toEqual([{ day: TARGET, outcome: "not_anomalous" }]);
    } else {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.confidence).toBe(confidence);
      expect(result.days).toEqual([{ day: TARGET, outcome: "anomalous" }]);
    }
  });

  it("uses the Poisson floor when MAD is 0 and builds the candidate", () => {
    const result = evaluateDailyAnomalies(
      dailyInput({ days: withTarget(TARGET, { sessions: 9_700 }) }),
    );
    const candidate = result.candidates[0]!;
    const evidence = candidate.evidence as An1Evidence;
    expect(evidence.readings[0]).toMatchObject({
      metric: "sessions",
      value: 9_700,
      median: 10_000,
      scale: 100,
      z: -3,
      direction: "down",
    });
    expect(candidate).toMatchObject({
      ruleKey: "AN1",
      kind: "ANOMALY",
      subject: "site",
      severity: "WARN",
      period: { grain: "DAY", from: TARGET, to: TARGET, key: TARGET },
      impact: null,
    });
    expect(candidate.impactShare).toBeCloseTo(300 / 70_000, 9);
    expect(evidence.mode).toBe("day");
    expect(evidence.primary).toBe("sessions");
    expect(evidence.preliminary).toBe(false);
  });

  it("is INFO for an upward significant move", () => {
    const result = evaluateDailyAnomalies(
      dailyInput({ days: withTarget(TARGET, { sessions: 10_400 }) }),
    );
    expect(result.candidates[0]).toMatchObject({
      severity: "INFO",
      confidence: "SIGNIFICANT",
    });
  });
});

describe("dailyVolumeGate", () => {
  const exclude = new Set<string>();
  it.each([
    [19, false],
    [20, true],
  ])("median sessions %d → %s", (sessions, open) => {
    const days = makeDays(addDays(TARGET, -70), TARGET, () => ({ sessions }));
    const gate = dailyVolumeGate(days, TARGET, exclude);
    expect(gate.sessions).toBe(open);
    expect(gate.engagedSessions).toBe(open);
  });

  it.each([
    [2, false],
    [3, true],
  ])("median key events %d → %s", (keyEvents, open) => {
    const days = makeDays(addDays(TARGET, -70), TARGET, () => ({ keyEvents }));
    const gate = dailyVolumeGate(days, TARGET, exclude);
    expect(gate.keyEvents).toBe(open);
    expect(gate.keyEventRate).toBe(open);
  });

  it("needs three median transactions for revenue", () => {
    const low = makeDays(addDays(TARGET, -70), TARGET, () => ({
      transactions: 2,
      revenue: 100,
    }));
    const high = makeDays(addDays(TARGET, -70), TARGET, () => ({
      transactions: 3,
      revenue: 100,
    }));
    expect(dailyVolumeGate(low, TARGET, exclude).revenue).toBe(false);
    expect(dailyVolumeGate(high, TARGET, exclude).revenue).toBe(true);
  });
});

describe("evaluateDailyAnomalies exclusions", () => {
  it("skips a target on a TR holiday even with a 90% drop", () => {
    const target = "2026-03-20";
    const holidays = holidaysBetween("TR", addDays(target, -400), target);
    expect(holidays.has(target)).toBe(true);
    const result = evaluateDailyAnomalies(
      dailyInput({
        targets: [target],
        days: withTarget(target, { sessions: 1_000 }),
        holidays,
        country: "TR",
      }),
    );
    expect(result.candidates).toEqual([]);
    expect(result.days).toEqual([{ day: target, outcome: "skipped" }]);
  });

  it("drops holiday days from the baseline", () => {
    const holiday = addDays(TARGET, -7);
    const days = withTarget(TARGET, { sessions: 9_700 }, (day) =>
      day === holiday ? { sessions: 100 } : {},
    );
    const evidence = evidenceOf(
      dailyInput({ days, holidays: new Set([holiday]) }),
    )!;
    expect(evidence.excludedDays).toEqual([holiday]);
    expect(evidence.readings[0]!.baselineDays).not.toContain(holiday);
    expect(evidence.readings[0]!.median).toBe(10_000);
  });

  it("skips a suspect target", () => {
    const result = evaluateDailyAnomalies(
      dailyInput({
        days: withTarget(TARGET, { sessions: 1_000 }),
        suspect: new Set([TARGET]),
      }),
    );
    expect(result.candidates).toEqual([]);
    expect(result.days[0]!.outcome).toBe("skipped");
  });

  it("skips a target missing from days and a low-volume target", () => {
    const missing = evaluateDailyAnomalies(
      dailyInput({
        days: withTarget(addDays(TARGET, -1), {}),
      }),
    );
    expect(missing.days[0]!.outcome).toBe("skipped");
    const tiny = evaluateDailyAnomalies(
      dailyInput({
        days: makeDays(addDays(TARGET, -400), TARGET, (day) => ({
          sessions: day === TARGET ? 1 : 10,
          engagedSessions: 5,
        })),
      }),
    );
    expect(tiny.days[0]!.outcome).toBe("skipped");
    expect(tiny.candidates).toEqual([]);
  });
});

describe("evaluateDailyAnomalies seasonality", () => {
  it("suppresses a drop that also happened on the aligned day last year", () => {
    const lastYear = addDays(TARGET, -364);
    const days = withTarget(TARGET, { sessions: 9_000 }, (day) =>
      day === lastYear ? { sessions: 9_000 } : {},
    );
    const result = evaluateDailyAnomalies(dailyInput({ days }));
    expect(result.candidates).toEqual([]);
    expect(result.days[0]!.outcome).toBe("not_anomalous");
  });

  it("keeps the drop when last year was normal or moved the other way", () => {
    const lastYear = addDays(TARGET, -364);
    const normal = evidenceOf(
      dailyInput({ days: withTarget(TARGET, { sessions: 9_000 }) }),
    )!;
    expect(normal.seasonalChecked).toBe(true);
    const opposite = evidenceOf(
      dailyInput({
        days: withTarget(TARGET, { sessions: 9_000 }, (day) =>
          day === lastYear ? { sessions: 11_000 } : {},
        ),
      }),
    )!;
    expect(opposite.seasonalChecked).toBe(true);
  });

  it("marks seasonality unchecked without a 13-month series", () => {
    const days = makeDays(addDays(TARGET, -70), TARGET, (day) =>
      day === TARGET ? { sessions: 9_000 } : {},
    );
    const evidence = evidenceOf(dailyInput({ days }))!;
    expect(evidence.seasonalChecked).toBe(false);
  });
});

describe("evaluateDailyAnomalies readings and outcomes", () => {
  it("makes one candidate per day with several readings, primary = max |z|", () => {
    // Oturum z = −5, ilgili oturum (5000, taban √5000 ≈ 70.7) z ≈ −2.83.
    const evidence = evidenceOf(
      dailyInput({
        days: withTarget(TARGET, { sessions: 9_500, engagedSessions: 4_800 }),
      }),
    )!;
    expect(evidence.readings.map((r) => r.metric).sort()).toEqual([
      "engagedSessions",
      "sessions",
    ]);
    expect(evidence.primary).toBe("sessions");
  });

  it("reports an outcome for every target", () => {
    const t0 = addDays(TARGET, -2);
    const t1 = addDays(TARGET, -1);
    const result = evaluateDailyAnomalies(
      dailyInput({
        targets: [t0, t1, TARGET],
        days: withTarget(TARGET, { sessions: 9_000 }),
        suspect: new Set([t1]),
      }),
    );
    expect(result.days).toEqual([
      { day: t0, outcome: "not_anomalous" },
      { day: t1, outcome: "skipped" },
      { day: TARGET, outcome: "anomalous" },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.period.key).toBe(TARGET);
  });

  it("decomposes by channel with the sum invariant and reads isFinal", () => {
    const days = withTarget(TARGET, { sessions: 9_000, isFinal: false });
    const channelDays: GaDailyAnalysisInput["channelDays"] = [];
    for (let day = addDays(TARGET, -58); day <= TARGET; day = addDays(day, 1)) {
      channelDays.push({
        day,
        rows:
          day === TARGET
            ? [
                { key: ["Organic Search"], values: [5_000, 0, 0] },
                { key: ["Direct"], values: [3_900, 0, 0] },
              ]
            : [
                { key: ["Organic Search"], values: [6_000, 0, 0] },
                { key: ["Direct"], values: [3_950, 0, 0] },
              ],
      });
    }
    const evidence = evidenceOf(dailyInput({ days, channelDays }))!;
    expect(evidence.preliminary).toBe(true);
    const breakdown = evidence.breakdown!;
    expect(breakdown.metric).toBe("sessions");
    expect(breakdown.before).toBe(10_000);
    expect(breakdown.after).toBe(9_000);
    const sum =
      breakdown.components.reduce((s, c) => s + c.total, 0) +
      (breakdown.other?.total ?? 0) +
      breakdown.residual;
    expect(Math.abs(sum - breakdown.delta)).toBeLessThanOrEqual(1e-6);
    expect(breakdown.components[0]!.key).toBe("Organic Search");
    expect(breakdown.components[0]!.total).toBeCloseTo(-1_000, 9);
    expect(breakdown.residual).toBeCloseTo(50, 9);

    const withoutTarget = evidenceOf(
      dailyInput({
        days,
        channelDays: channelDays.filter((d) => d.day !== TARGET),
      }),
    )!;
    expect(withoutTarget.breakdown).toBeNull();
  });
});

function emptyTables(from: string, to: string): GaWindowTables {
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
  };
}

function weeklyInput(
  partial: Partial<GaWeeklyAnalysisInput> & { days: GaAnalysisDay[] },
): GaWeeklyAnalysisInput {
  const week = { monday: "2026-09-28", sunday: "2026-10-04" };
  return {
    linkId: "link-1",
    today: "2026-10-05",
    week,
    country: null,
    suspect: new Set(),
    holidays: new Set(),
    current: emptyTables(week.monday, week.sunday),
    previous: emptyTables("2026-09-21", "2026-09-27"),
    lastYear: null,
    window28: emptyTables("2026-09-07", week.sunday),
    window28Previous: emptyTables("2026-08-10", "2026-09-06"),
    weeks: [],
    month: null,
    siteSearch: null,
    currency: null,
    measurementDegraded: false,
    ...partial,
  };
}

describe("evaluateWeeklyAnomaly", () => {
  const monday = "2026-09-28";
  const sunday = "2026-10-04";
  const lowVolume = (
    weekSessions: number,
    extra: (day: string) => Partial<GaAnalysisDay> = () => ({}),
  ) =>
    makeDays(addDays(sunday, -400), sunday, (day) => ({
      sessions: day >= monday ? weekSessions : 10,
      engagedSessions: 5,
      ...extra(day),
    }));

  it("finds a weekly drop on a low-volume site with subject site:week", () => {
    const candidate = evaluateWeeklyAnomaly(
      weeklyInput({ days: lowVolume(2) }),
    )!;
    expect(candidate).toMatchObject({
      ruleKey: "AN1",
      subject: "site:week",
      confidence: "SIGNIFICANT",
      severity: "WARN",
      period: { grain: "WEEK", from: monday, to: sunday, key: "2026-W40" },
    });
    const evidence = candidate.evidence as An1Evidence;
    expect(evidence.mode).toBe("week");
    expect(evidence.target).toBe(monday);
    expect(evidence.primary).toBe("sessions");
    expect(evidence.readings[0]).toMatchObject({ value: 14, median: 70 });
    expect(candidate.impactShare).toBeCloseTo(56 / 70, 9);
  });

  it("ignores metrics that pass the daily gate and normal weeks", () => {
    const big = makeDays(addDays(sunday, -400), sunday, (day) => ({
      sessions: day >= monday ? 100 : 1_000,
    }));
    expect(evaluateWeeklyAnomaly(weeklyInput({ days: big }))).toBeNull();
    expect(
      evaluateWeeklyAnomaly(weeklyInput({ days: lowVolume(10) })),
    ).toBeNull();
  });

  it("skips weeks with a holiday or suspect day and reads preliminary", () => {
    expect(
      evaluateWeeklyAnomaly(
        weeklyInput({ days: lowVolume(2), holidays: new Set(["2026-09-30"]) }),
      ),
    ).toBeNull();
    expect(
      evaluateWeeklyAnomaly(
        weeklyInput({ days: lowVolume(2), suspect: new Set(["2026-10-01"]) }),
      ),
    ).toBeNull();
    const preliminary = evaluateWeeklyAnomaly(
      weeklyInput({
        days: lowVolume(2, (day) => (day === sunday ? { isFinal: false } : {})),
      }),
    )!;
    expect((preliminary.evidence as An1Evidence).preliminary).toBe(true);
  });

  it("needs a weekly baseline median of 20 sessions", () => {
    const tiny = makeDays(addDays(sunday, -400), sunday, (day) => ({
      sessions: day >= monday ? 0 : 2,
      engagedSessions: 1,
    }));
    expect(evaluateWeeklyAnomaly(weeklyInput({ days: tiny }))).toBeNull();
  });
});
