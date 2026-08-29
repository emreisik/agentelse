import { z } from "zod";

import type { ReasoningDef } from "../types";
import { zScoreFraction } from "../score-schema";

export const LearningExtractionSchema = z.object({
  learnings: z.array(
    z.object({
      insight: z.string(),
      confidence: zScoreFraction(),
    }),
  ),
});

export type LearningExtractionOutput = z.infer<typeof LearningExtractionSchema>;

export const learningExtractionDef: ReasoningDef<LearningExtractionOutput> = {
  purpose: "learning.extract",
  schema: LearningExtractionSchema,
  maxTokens: 1536,

  buildPrompt(context) {
    return {
      system:
        "You extract durable brand learnings from measurement results — what " +
        "actually worked or failed, phrased so future creative/growth/strategy " +
        "work can apply it. Only extract learnings the data supports. " +
        "confidence is a decimal fraction between 0 and 1 (e.g. 0.7), never a percentage.",
      user:
        `Executed work:\n${JSON.stringify(context.work ?? {}, null, 2)}\n\n` +
        `Measurement results:\n${JSON.stringify(context.results ?? [], null, 2)}\n\n` +
        "Extract learnings.",
    };
  },

  buildMock(context) {
    const work = (context.work ?? {}) as {
      title?: string;
      capability?: string;
    };
    const results = (context.results ?? []) as Array<{ label?: string }>;
    return {
      learnings: [
        {
          insight: `Mock learning: "${work.title ?? work.capability ?? "work"}" measurement over ${results.length} checks completed`,
          confidence: 0.5,
        },
      ],
    };
  },
};
