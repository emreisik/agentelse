import { z } from "zod";

import type { ReasoningContext, ReasoningDef } from "../types";

// The BrandStrategyVersion.payload contract. Distinct from the Constitution
// (identity: who the brand IS) — this is the forward-looking layer: what the
// agency should focus on NEXT, given the identity plus everything learned
// from completed work since the last version.
export const StrategyOutputSchema = z.object({
  summary: z.string(),
  focusAreas: z.array(z.string()),
  prioritizedGoals: z.array(z.string()),
  recommendedNextActions: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type StrategyOutput = z.infer<typeof StrategyOutputSchema>;

type GoalLike = {
  title: string;
  description?: string | null;
  priority: number;
};
type LearningLike = { insight: string; confidence?: number | null };

function brandName(context: ReasoningContext): string {
  return (context.brandName as string | undefined) ?? "the brand";
}

function constitutionSummary(context: ReasoningContext): string {
  return (
    (context.constitutionSummary as string | undefined) ??
    "No constitution summary available."
  );
}

function goals(context: ReasoningContext): GoalLike[] {
  return (context.goals as GoalLike[] | undefined) ?? [];
}

function learnings(context: ReasoningContext): LearningLike[] {
  return (context.learnings as LearningLike[] | undefined) ?? [];
}

export const strategySynthesisDef: ReasoningDef<StrategyOutput> = {
  purpose: "strategy.synthesize",
  schema: StrategyOutputSchema,
  tier: "pro",
  // constitution-synthesis.ts (the closest sibling prompt — same "brand
  // strategy synthesizer" persona, same multi-array shape) needed to go all
  // the way to 32768 after repeatedly hitting MAX_TOKENS truncation on
  // thinking models (Gemini's thinking tokens count against this budget).
  // Set proactively here instead of waiting for the same incident to repeat.
  maxTokens: 16384,

  buildPrompt(context) {
    const goalLines = goals(context)
      .map(
        (g) =>
          `- [priority ${g.priority}] ${g.title}${g.description ? `: ${g.description}` : ""}`,
      )
      .join("\n");
    const learningLines = learnings(context)
      .map(
        (l) =>
          `- ${l.insight}${l.confidence != null ? ` (confidence ${l.confidence})` : ""}`,
      )
      .join("\n");

    return {
      system:
        "You are the brand-strategy synthesizer of an AI agency operating system. " +
        "You turn the brand's constitution, its active goals, and what has been " +
        "learned from completed work into the next Brand Strategy version — a " +
        "forward-looking plan the agency's departments consult when deciding what " +
        "to do next. Never contradict the constitution; build on it. Only surface " +
        "learnings-backed recommendations as recommendedNextActions; speculative " +
        "ideas without support belong in openQuestions instead.",
      user:
        `Brand: ${brandName(context)}\n\nConstitution summary:\n${constitutionSummary(context)}\n\n` +
        `Active goals:\n${goalLines || "(none)"}\n\n` +
        `Learnings since the last strategy version:\n${learningLines || "(none)"}\n\n` +
        "Synthesize the next Brand Strategy version.",
    };
  },

  // Deterministic derivation from the same inputs, mirroring
  // constitution-synthesis.ts's buildMock — tests exercise real data flow.
  buildMock(context) {
    const name = brandName(context);
    const g = goals(context);
    const l = learnings(context);

    return {
      summary: `Strategy for ${name} derived from ${g.length} active goal(s) and ${l.length} learning(s)`,
      focusAreas: g.slice(0, 5).map((goal) => goal.title),
      prioritizedGoals: [...g]
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 5)
        .map((goal) => goal.title),
      recommendedNextActions: l.slice(0, 5).map((learning) => learning.insight),
      risks: [],
      openQuestions:
        g.length === 0
          ? [
              `No active goals set for ${name} yet — define goals before the next strategy revision.`,
            ]
          : [],
    };
  },
};
