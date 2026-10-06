import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";

import { evaluateGoalPace } from "./goals";
import type {
  An15Evidence,
  GaAnalysisDay,
  GaDailyAnalysisInput,
  GaGoalInput,
  GaWebsiteGoalKey,
} from "./types";

// Her gün 100 oturum, 4 KE: Ekim (31 gün) tahmini her zaman 3 100 oturum.
function days(through: string): GaAnalysisDay[] {
  const list: GaAnalysisDay[] = [];
  for (let day = addDays(through, -90); day <= through; day = addDays(day, 1)) {
    list.push({
      day,
      sessions: 100,
      engagedSessions: 50,
      keyEvents: 4,
      revenue: 0,
      transactions: 0,
      isFinal: true,
    });
  }
  return list;
}

function goal(
  target: number,
  metricKey: GaWebsiteGoalKey = "web.sessions",
  id = "goal-1",
): GaGoalInput {
  return { id, title: "October visits", metricKey, target };
}

function input(
  through: string,
  goals: GaGoalInput[],
  partial: Partial<GaDailyAnalysisInput> = {},
): GaDailyAnalysisInput {
  return {
    linkId: "link-1",
    today: addDays(through, 1),
    targets: [addDays(through, -2), addDays(through, -1), through],
    country: null,
    days: days(through),
    suspect: new Set(),
    holidays: new Set(),
    channelDays: [],
    goals,
    measurementDegraded: false,
    ...partial,
  };
}

describe("evaluateGoalPace", () => {
  it("does not evaluate before the 5th of the month", () => {
    expect(evaluateGoalPace(input("2026-10-04", [goal(10_000)]))).toEqual({
      candidates: [],
      evaluated: [],
    });
    const fifth = evaluateGoalPace(input("2026-10-05", [goal(10_000)]));
    expect(fifth.evaluated).toEqual([{ goalId: "goal-1", month: "2026-10" }]);
    expect(fifth.candidates).toHaveLength(1);
  });

  it.each([
    [3_444, null],
    [3_445, "DIRECTIONAL"],
  ])("target %d → %s at the 0.9 pace boundary", (target, confidence) => {
    const result = evaluateGoalPace(input("2026-10-05", [goal(target)]));
    expect(result.evaluated).toHaveLength(1);
    if (confidence === null) {
      expect(result.candidates).toEqual([]);
      return;
    }
    const candidate = result.candidates[0]!;
    const evidence = candidate.evidence as An15Evidence;
    expect(evidence.forecast).toBe(3_100);
    expect(evidence.monthToDate).toBe(500);
    expect(evidence.paceRatio).toBeCloseTo(3_100 / target, 9);
    expect(candidate).toMatchObject({
      ruleKey: "AN15",
      kind: "RISK",
      subject: "goal:goal-1",
      severity: "INFO",
      confidence,
      period: {
        grain: "MONTH",
        from: "2026-10-01",
        to: "2026-10-31",
        key: "2026-10",
      },
    });
  });

  it("is SIGNIFICANT below 0.8 and WARN below 0.75 with the weekly impact", () => {
    const significant = evaluateGoalPace(input("2026-10-05", [goal(3_900)]))
      .candidates[0]!;
    expect(significant.confidence).toBe("SIGNIFICANT");
    expect(significant.severity).toBe("INFO");
    const warn = evaluateGoalPace(input("2026-10-05", [goal(5_000)]))
      .candidates[0]!;
    expect(warn.severity).toBe("WARN");
    const perWeek = ((5_000 - 3_100) * 7) / 31;
    expect(warn.impact).toEqual({
      metric: "sessions",
      perWeek,
      low: perWeek,
      high: perWeek,
      directional: true,
    });
    expect(warn.impactShare).toBeCloseTo(1_900 / 5_000, 9);
    expect(warn.evidence).toMatchObject({
      dayOfMonth: 5,
      daysInMonth: 31,
      through: "2026-10-05",
      month: "2026-10",
    });
  });

  it("maps the key events goal and ignores an unknown metric key", () => {
    const result = evaluateGoalPace(
      input("2026-10-05", [
        goal(200, "web.key_events", "ke"),
        goal(10_000, "web.unknown" as GaWebsiteGoalKey, "bad"),
      ]),
    );
    expect(result.evaluated).toEqual([{ goalId: "ke", month: "2026-10" }]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.impact!.metric).toBe("keyEvents");
    expect((result.candidates[0]!.evidence as An15Evidence).forecast).toBe(124);
  });

  it("does not evaluate a month with a suspect day", () => {
    const result = evaluateGoalPace(
      input("2026-10-12", [goal(10_000)], { suspect: new Set(["2026-10-03"]) }),
    );
    expect(result).toEqual({ candidates: [], evaluated: [] });
    // Ay dışındaki şüpheli gün değerlendirmeyi engellemez.
    const outside = evaluateGoalPace(
      input("2026-10-12", [goal(10_000)], { suspect: new Set(["2026-09-28"]) }),
    );
    expect(outside.evaluated).toHaveLength(1);
  });

  it("lists goals evaluated without a candidate", () => {
    const result = evaluateGoalPace(
      input("2026-10-05", [
        goal(3_000, "web.sessions", "a"),
        goal(10_000, "web.sessions", "b"),
      ]),
    );
    expect(result.evaluated.map((e) => e.goalId)).toEqual(["a", "b"]);
    expect(result.candidates.map((c) => c.subject)).toEqual(["goal:b"]);
  });
});
