import { describe, expect, it } from "vitest";

import type { GaTableRow } from "@/lib/website-analytics/slices";

import { evaluateFunnel, FUNNEL_STEPS } from "./ecommerce";
import { makeWeeklyInput } from "./test-fixtures";
import type {
  An11Evidence,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };

type Counts = [number, number, number, number];

function events(counts: Counts): GaTableRow[] {
  // Aynı olayın anahtar olay olan ve olmayan satırları toplanır.
  return FUNNEL_STEPS.flatMap((name, index) => [
    { key: [name, "true"], values: [counts[index]! - 1, counts[index]! - 1] },
    { key: [name, "false"], values: [1, 0] },
  ]);
}

const BASE: Counts = [10_000, 3_000, 1_000, 500];

function input(
  current: Counts,
  options: {
    baseline?: Counts;
    excluded?: number[];
    totals?: Partial<GaWindowTables["totals"]>;
  } = {},
): GaWeeklyAnalysisInput {
  const base = makeWeeklyInput({ week: WEEK });
  const weeks = base.weeks.map((week, index) => {
    const last = index === base.weeks.length - 1;
    return {
      ...week,
      excludedDays: options.excluded?.includes(index) ? [week.from] : [],
      events: events(last ? current : (options.baseline ?? BASE)),
      totals: last ? { ...week.totals, ...options.totals } : week.totals,
    };
  });
  return { ...base, weeks };
}

describe("evaluateFunnel (AN11)", () => {
  it("needs ≥50 entering the step", () => {
    const at = evaluateFunnel(input([50, 5, 2, 1]))!;
    expect(at).not.toBeNull();
    expect(at.subject).toBe("funnel:view_item>add_to_cart");
    expect(at.severity).toBe("INFO");
    expect(evaluateFunnel(input([49, 5, 2, 1]))).toBeNull();
  });

  it("needs a drop of at least 20%", () => {
    const at = evaluateFunnel(input([10_000, 3_000, 1_000, 400]))!;
    expect(at).not.toBeNull();
    const evidence = at.evidence as An11Evidence;
    expect(evidence.step.from).toBe("begin_checkout");
    expect(evidence.step.to).toBe("purchase");
    expect(evidence.step.dropPct).toBeCloseTo(20, 8);
    expect(at.severity).toBe("WARN");
    expect(at.kind).toBe("RISK");
    expect(at.confidence).toBe("SIGNIFICANT");
    expect(evaluateFunnel(input([10_000, 3_000, 1_000, 405]))).toBeNull();
  });

  it("records impact, share, AOV and the WEEK period", () => {
    const candidate = evaluateFunnel(
      input([10_000, 3_000, 1_000, 400], {
        totals: { revenue: 1_000, transactions: 10 },
      }),
    )!;
    const evidence = candidate.evidence as An11Evidence;
    // (0,5 − 0,4) · 1000
    expect(candidate.impact?.metric).toBe("purchases");
    expect(candidate.impact?.perWeek).toBeCloseTo(100, 8);
    expect(candidate.impact?.directional).toBe(false);
    expect(candidate.impactShare).toBeCloseTo(0.2, 8);
    expect(evidence.aov).toEqual({ current: 100, baseline: null });
    expect(evidence.baselineWeeks).toHaveLength(4);
    expect(candidate.period).toMatchObject({
      grain: "WEEK",
      from: WEEK.monday,
      to: WEEK.sunday,
    });
  });

  it("picks the worst step", () => {
    const candidate = evaluateFunnel(input([10_000, 2_000, 1_000, 250]))!;
    expect((candidate.evidence as An11Evidence).step.to).toBe("purchase");
  });

  it("skips baseline weeks with excluded days", () => {
    // Taban haftaları 3..6; ikisi şüpheli → kalan iki hafta yeter.
    const withExcluded = input([10_000, 3_000, 1_000, 400], {
      excluded: [3, 4],
    });
    const two = evaluateFunnel(withExcluded)!;
    expect((two.evidence as An11Evidence).baselineWeeks).toEqual([
      withExcluded.weeks[5]!.from,
      withExcluded.weeks[6]!.from,
    ]);
    // Üçü şüpheli → tek hafta kalır, yetmez.
    expect(
      evaluateFunnel(
        input([10_000, 3_000, 1_000, 400], { excluded: [3, 4, 5] }),
      ),
    ).toBeNull();
  });
});
