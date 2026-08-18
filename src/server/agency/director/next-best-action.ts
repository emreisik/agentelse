import { z } from "zod";

// Configurable NBA scoring (spec sections 35-36). Pure module; per-project
// overrides come from AutonomyPolicy.scoringWeights (zod-validated, invalid
// Json falls back to defaults).

export const ScoringWeightsSchema = z.object({
  impact: z.number().min(0).max(1),
  goalAlignment: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  evidence: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  timing: z.number().min(0).max(1),
  originality: z.number().min(0).max(1),
  costPenalty: z.number().min(0).max(1),
  effortPenalty: z.number().min(0).max(1),
  riskPenalty: z.number().min(0).max(1),
});

export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  impact: 0.25,
  goalAlignment: 0.2,
  urgency: 0.15,
  evidence: 0.15,
  confidence: 0.1,
  timing: 0.1,
  originality: 0.05,
  costPenalty: 0.34,
  effortPenalty: 0.33,
  riskPenalty: 0.33,
};

export type ScoreDimensions = {
  impact: number;        // 0-1
  goalAlignment: number; // 0-1 (0 = serves no goal)
  urgency: number;
  evidence: number;
  confidence: number;
  timing: number;        // 1 = inside its time window, decays after
  originality: number;
  cost: number;          // 0-1 penalties
  effort: number;
  risk: number;
};

export type ScoreResult = {
  score: number;
  breakdown: Record<string, number>;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function scoreItem(
  dims: ScoreDimensions,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): ScoreResult {
  const positive =
    weights.impact * clamp01(dims.impact) +
    weights.goalAlignment * clamp01(dims.goalAlignment) +
    weights.urgency * clamp01(dims.urgency) +
    weights.evidence * clamp01(dims.evidence) +
    weights.confidence * clamp01(dims.confidence) +
    weights.timing * clamp01(dims.timing) +
    weights.originality * clamp01(dims.originality);

  // Penalties scale to at most 30% of the score so a risky-but-brilliant
  // idea is dampened, not annihilated.
  const penalty =
    0.3 *
    (weights.costPenalty * clamp01(dims.cost) +
      weights.effortPenalty * clamp01(dims.effort) +
      weights.riskPenalty * clamp01(dims.risk));

  const score = Math.max(0, positive - penalty);
  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: { positive, penalty, ...dims },
  };
}

export function resolveWeights(raw: unknown): ScoringWeights {
  if (!raw) return DEFAULT_SCORING_WEIGHTS;
  const parsed = ScoringWeightsSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : DEFAULT_SCORING_WEIGHTS;
}
