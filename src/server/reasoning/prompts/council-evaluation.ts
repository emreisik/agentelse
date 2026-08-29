import { z } from "zod";

import type { ReasoningDef } from "../types";
import { zBoundedScore } from "../score-schema";

export const CouncilEvaluationOutputSchema = z.object({
  scores: z.record(z.string(), zBoundedScore(0, 10)),
  overallScore: zBoundedScore(0, 10),
  recommendation: z.enum(["STRONG_APPROVE", "APPROVE", "REVISE", "REJECT"]),
  rationale: z.string(),
});

export type CouncilEvaluationOutput = z.infer<
  typeof CouncilEvaluationOutputSchema
>;

export const councilEvaluationDef: ReasoningDef<CouncilEvaluationOutput> = {
  purpose: "council.evaluate",
  schema: CouncilEvaluationOutputSchema,
  // 2048 wasn't enough on thinking models (gemini-pro-latest spends part of
  // the output budget on reasoning tokens): 147 of the first ~400 prod calls
  // died with finishReason MAX_TOKENS mid-JSON. The output itself is small;
  // the headroom is for thinking.
  maxTokens: 8192,

  buildPrompt(context) {
    return {
      system:
        "You are a multi-perspective agency council evaluating a campaign idea. " +
        "Score every requested dimension 0-10 from that perspective (e.g. 7.5 — " +
        "never a percentage like 75), compute an overall score on the same 0-10 " +
        "scale, and recommend STRONG_APPROVE/APPROVE/REVISE/REJECT. " +
        "Low evidence or brand-fit problems must pull the recommendation down. " +
        "When real competitor insights are provided, ground the 'evidence' " +
        "dimension in them specifically (does this idea differentiate from or " +
        "learn from what named competitors are actually doing) instead of " +
        "general assumptions about the market.",
      user:
        `Council: ${String(context.councilType ?? "CREATIVE")}\n` +
        `Dimensions: ${JSON.stringify(context.dimensions ?? [])}\n\n` +
        `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
        `Competitor insights (most recent first, may be empty):\n${JSON.stringify(context.competitorInsights ?? [], null, 2)}\n\n` +
        `Idea:\n${JSON.stringify(context.idea ?? {}, null, 2)}\n\n` +
        "Evaluate the idea.",
    };
  },

  buildMock(context) {
    const dimensions = (context.dimensions ?? ["originality"]) as string[];
    const idea = (context.idea ?? {}) as { title?: string; lens?: string };
    // Deterministic per-dimension scores from a simple text hash so different
    // ideas rank differently but the same idea always scores the same.
    const seed = [...(idea.title ?? "idea")].reduce(
      (acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 1000,
      7,
    );
    const scores: Record<string, number> = {};
    dimensions.forEach((dim, i) => {
      scores[dim] = Math.round(((seed + i * 137) % 41) / 10 + 5.5); // 5.5..9.5-ish
      if (scores[dim] > 10) scores[dim] = 10;
    });
    const overall =
      Math.round(
        (Object.values(scores).reduce((a, b) => a + b, 0) /
          Math.max(1, dimensions.length)) *
          10,
      ) / 10;
    return {
      scores,
      overallScore: overall,
      recommendation:
        overall >= 8
          ? "STRONG_APPROVE"
          : overall >= 6.5
            ? "APPROVE"
            : overall >= 5
              ? "REVISE"
              : "REJECT",
      rationale: `Mock council evaluation of "${idea.title ?? "idea"}" (${idea.lens ?? "?"} lens), overall ${overall}`,
    };
  },
};
