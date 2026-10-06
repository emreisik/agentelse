import { describe, expect, it } from "vitest";

import { evaluateDeviceGap } from "./devices";
import { makeWeeklyInput, makeWindowTables } from "./test-fixtures";
import type { An5Evidence, GaWeeklyAnalysisInput } from "./types";

const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };
const W28 = { from: "2026-09-07", to: "2026-10-04" };

function input(
  mobile: [number, number],
  desktop: [number, number],
): GaWeeklyAnalysisInput {
  return makeWeeklyInput({
    week: WEEK,
    window28: makeWindowTables(W28, {
      device: [
        { key: ["mobile"], values: [mobile[0], mobile[0] / 2, mobile[1]] },
        { key: ["desktop"], values: [desktop[0], desktop[0] / 2, desktop[1]] },
        { key: ["tablet"], values: [50, 25, 1] },
      ],
      totals: {
        sessions: mobile[0] + desktop[0] + 50,
        engagedSessions: 0,
        keyEvents: mobile[1] + desktop[1] + 1,
        revenue: 0,
        transactions: 0,
        engagementSec: 0,
        screenPageViews: 0,
      },
    }),
  });
}

describe("evaluateDeviceGap (AN5)", () => {
  it("needs ratio < 0.6", () => {
    const candidate = evaluateDeviceGap(input([1_000, 59], [1_000, 100]));
    expect(candidate).not.toBeNull();
    expect((candidate!.evidence as An5Evidence).ratio).toBeCloseTo(0.59, 10);
    expect(evaluateDeviceGap(input([1_000, 60], [1_000, 100]))).toBeNull();
  });

  it("needs ≥10 desktop key events and ≥200 sessions each", () => {
    expect(evaluateDeviceGap(input([1_000, 0], [1_000, 10]))).not.toBeNull();
    expect(evaluateDeviceGap(input([1_000, 0], [1_000, 9]))).toBeNull();
    expect(evaluateDeviceGap(input([199, 0], [1_000, 100]))).toBeNull();
    expect(evaluateDeviceGap(input([1_000, 0], [199, 100]))).toBeNull();
  });

  it("SIGNIFICANT gap is a WARN opportunity over W28 with impact", () => {
    const candidate = evaluateDeviceGap(input([1_000, 0], [1_000, 100]))!;
    expect(candidate.kind).toBe("OPPORTUNITY");
    expect(candidate.confidence).toBe("SIGNIFICANT");
    expect(candidate.severity).toBe("WARN");
    expect(candidate.subject).toBe("device:mobile");
    expect(candidate.period).toMatchObject({
      grain: "WINDOW28",
      from: W28.from,
      to: W28.to,
    });
    // (0,8 · 0,1 − 0) · 1000 / 4 = 20; üst (0,1 − 0) · 1000 / 4 = 25
    expect(candidate.impact?.perWeek).toBeCloseTo(20, 10);
    expect(candidate.impact?.low).toBe(0);
    expect(candidate.impact?.high).toBeCloseTo(25, 10);
    expect(candidate.impact?.directional).toBe(false);
    expect(candidate.impactShare).toBeCloseTo(20 / (101 / 4), 10);
  });

  it("a borderline test is DIRECTIONAL and INFO", () => {
    const candidate = evaluateDeviceGap(input([200, 3], [200, 10]))!;
    expect(candidate.confidence).toBe("DIRECTIONAL");
    expect(candidate.severity).toBe("INFO");
    expect(candidate.impact?.directional).toBe(true);
  });
});
