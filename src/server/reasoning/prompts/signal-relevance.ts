import { z } from "zod";

import type { ReasoningDef } from "../types";
import { zBoundedScore } from "../score-schema";

export const SignalRelevanceSchema = z.object({
  relevanceScore: zBoundedScore(0, 100),
  rationale: z.string(),
  shouldPromote: z.boolean(),
});

export type SignalRelevanceOutput = z.infer<typeof SignalRelevanceSchema>;

// Deterministic mock: relevance derives from keyword overlap between the
// signal text and the brand constitution/category profile, so different
// signals genuinely score differently in tests.
function mockScore(signalText: string, brandText: string): number {
  const signalWords = new Set(
    signalText
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
  const brandWords = new Set(
    brandText
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
  let overlap = 0;
  for (const w of signalWords) if (brandWords.has(w)) overlap += 1;
  // Base 55 keeps generic category-matched signals above the promote line;
  // overlap pushes clearly relevant ones higher.
  return Math.min(95, 55 + overlap * 8);
}

export const signalRelevanceDef: ReasoningDef<SignalRelevanceOutput> = {
  purpose: "signal.relevance",
  schema: SignalRelevanceSchema,
  // Runs individually for every signal — high volume, simple scoring work.
  tier: "lite" as const,
  maxTokens: 1024,

  buildPrompt(context) {
    return {
      system:
        "You score how relevant an external market signal is to a specific brand. " +
        "Score 0-100. Above 60 means the brand team should hear about it. " +
        "Consider the brand's category, competitors, audience and goals.",
      user:
        `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
        `Signal:\n${JSON.stringify(context.signal ?? {}, null, 2)}\n\n` +
        "Score the relevance and decide whether to promote it.",
    };
  },

  buildMock(context) {
    const signal = (context.signal ?? {}) as {
      title?: string;
      summary?: string;
      category?: string;
    };
    const brand = JSON.stringify(context.brand ?? {});
    const text = `${signal.title ?? ""} ${signal.summary ?? ""} ${signal.category ?? ""}`;
    const score = mockScore(text, brand);
    return {
      relevanceScore: score,
      rationale: `Mock relevance from keyword overlap between signal "${signal.title ?? "?"}" and brand context`,
      shouldPromote: score >= 60,
    };
  },
};
