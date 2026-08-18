import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCORING_WEIGHTS,
  resolveWeights,
  scoreItem,
} from "@/server/agency/director/next-best-action";

const BASE = {
  impact: 0.8,
  goalAlignment: 1,
  urgency: 0.6,
  evidence: 0.7,
  confidence: 0.6,
  timing: 1,
  originality: 0.5,
  cost: 0.2,
  effort: 0.3,
  risk: 0.2,
};

describe("NextBestAction scoring", () => {
  it("is deterministic and bounded 0..1", () => {
    const a = scoreItem(BASE);
    const b = scoreItem(BASE);
    expect(a.score).toBe(b.score);
    expect(a.score).toBeGreaterThan(0);
    expect(a.score).toBeLessThanOrEqual(1);
  });

  it("higher impact scores higher", () => {
    const low = scoreItem({ ...BASE, impact: 0.2 });
    const high = scoreItem({ ...BASE, impact: 0.9 });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("zero goal alignment drags the score down materially", () => {
    const aligned = scoreItem(BASE);
    const unaligned = scoreItem({ ...BASE, goalAlignment: 0 });
    expect(aligned.score - unaligned.score).toBeCloseTo(
      DEFAULT_SCORING_WEIGHTS.goalAlignment,
      3,
    );
  });

  it("risk/cost/effort penalize but never zero out a strong idea", () => {
    const clean = scoreItem({ ...BASE, cost: 0, effort: 0, risk: 0 });
    const dirty = scoreItem({ ...BASE, cost: 1, effort: 1, risk: 1 });
    expect(dirty.score).toBeLessThan(clean.score);
    expect(dirty.score).toBeGreaterThan(0);
  });

  it("clamps out-of-range dimensions", () => {
    const wild = scoreItem({ ...BASE, impact: 5, risk: -2 });
    expect(wild.score).toBeLessThanOrEqual(1);
  });

  it("resolveWeights falls back to defaults on invalid overrides", () => {
    expect(resolveWeights(null)).toEqual(DEFAULT_SCORING_WEIGHTS);
    expect(resolveWeights({ impact: "high" })).toEqual(DEFAULT_SCORING_WEIGHTS);
    const custom = resolveWeights({ ...DEFAULT_SCORING_WEIGHTS, impact: 0.5 });
    expect(custom.impact).toBe(0.5);
  });
});
