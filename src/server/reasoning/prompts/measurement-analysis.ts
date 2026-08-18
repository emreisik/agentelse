import { z } from "zod";

import type { ReasoningDef } from "../types";

export const MeasurementAnalysisSchema = z.object({
  summary: z.string(),
  outcome: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "INCONCLUSIVE"]),
  notable: z.boolean(),
});

export type MeasurementAnalysisOutput = z.infer<typeof MeasurementAnalysisSchema>;

export const measurementAnalysisDef: ReasoningDef<MeasurementAnalysisOutput> = {
  purpose: "measurement.analyze",
  schema: MeasurementAnalysisSchema,
  maxTokens: 1024,

  buildPrompt(context) {
    return {
      system:
        "You analyze one scheduled measurement check result for executed agency " +
        "work. Summarize the observed outcome; mark notable=true only when the " +
        "result should feed back into brand learnings.",
      user:
        `Work:\n${JSON.stringify(context.work ?? {}, null, 2)}\n\n` +
        `Check:\n${JSON.stringify(context.check ?? {}, null, 2)}\n\n` +
        `Observed data:\n${JSON.stringify(context.observed ?? {}, null, 2)}\n\n` +
        "Analyze the measurement.",
    };
  },

  buildMock(context) {
    const check = (context.check ?? {}) as { label?: string };
    return {
      summary: `Mock measurement analysis for check "${check.label ?? "?"}"`,
      outcome: "NEUTRAL",
      notable: true,
    };
  },
};
