import { z } from "zod";

import type { ReasoningDef } from "../types";
import { zScoreFraction } from "../score-schema";

export const OpportunityEvaluationSchema = z.object({
  matters: z.boolean(),
  title: z.string(),
  description: z.string(),
  valueScore: zScoreFraction(),
  urgencyScore: zScoreFraction(),
  confidenceScore: zScoreFraction(),
  riskScore: zScoreFraction(),
  evidenceStrength: zScoreFraction(),
  goalIndexes: z.array(z.number()),
  timeWindowDays: z.number().nullable(),
  rationale: z.string(),
});

export type OpportunityEvaluationOutput = z.infer<
  typeof OpportunityEvaluationSchema
>;

export const opportunityEvaluationDef: ReasoningDef<OpportunityEvaluationOutput> =
  {
    purpose: "opportunity.evaluate",
    schema: OpportunityEvaluationSchema,
    maxTokens: 2048,

    buildPrompt(context) {
      return {
        system:
          "You are the opportunity analyst of an AI agency. Given an insight and " +
          "the brand's goals, decide whether this is a real opportunity worth " +
          "acting on. goalIndexes are 0-based indexes into the provided goals " +
          "array. Set matters=false for insights with no plausible brand action. " +
          "valueScore, urgencyScore, confidenceScore, riskScore and evidenceStrength " +
          "are each a decimal fraction between 0 and 1 (e.g. 0.75) — never a " +
          "percentage like 75, and never above 1.",
        user:
          `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
          `Goals:\n${JSON.stringify(context.goals ?? [], null, 2)}\n\n` +
          `Insight:\n${JSON.stringify(context.insight ?? {}, null, 2)}\n\n` +
          "Evaluate this as a potential opportunity.",
      };
    },

    buildMock(context) {
      const insight = (context.insight ?? {}) as {
        title?: string;
        summary?: string;
        importance?: number;
      };
      const goals = (context.goals ?? []) as Array<{ title?: string }>;
      const importance = (insight.importance ?? 60) / 100;
      return {
        matters: importance >= 0.4,
        title: `Opportunity: ${insight.title ?? "untitled insight"}`.slice(
          0,
          140,
        ),
        description: `Act on: ${insight.summary ?? insight.title ?? "insight"}`,
        valueScore: Math.min(0.95, importance + 0.1),
        urgencyScore: importance >= 0.7 ? 0.8 : 0.5,
        confidenceScore: 0.6,
        riskScore: 0.2,
        evidenceStrength: importance,
        goalIndexes: goals.length > 0 ? [0] : [],
        timeWindowDays: importance >= 0.7 ? 14 : null,
        rationale: `Mock evaluation derived from insight importance ${insight.importance ?? 60}`,
      };
    },
  };
