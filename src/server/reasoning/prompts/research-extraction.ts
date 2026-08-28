import { z } from "zod";

import type { ReasoningDef } from "../types";

// OpenClaw agents actually do the research, but return the result as free
// text (a markdown report); ResultMaterializer, however, expects a
// structured `findings[]`. This prompt is the bridge between the two: it
// turns the report into readable findings. Without it, research results
// were silently lost and the constitution was generated saying "Unclear".
export const ResearchExtractionOutputSchema = z.object({
  findings: z.array(
    z.object({
      statement: z.string(),
      classification: z.enum([
        "VERIFIED_FACT",
        "LIKELY_FACT",
        "ASSUMPTION",
        "CONTRADICTION",
        "UNKNOWN",
        "RECOMMENDATION",
      ]),
      category: z.string(),
      confidence: z.number().min(0).max(1),
      sourceUrl: z.string().optional(),
      // Only meaningful for COMPETITOR_RESEARCH/MONITORING/CHANGE_DETECTION
      // reports — which named company this finding is about. Lets
      // research-result-materializer.ts group findings per-competitor
      // instead of dropping the identity entirely (see competitor-
      // materializer.ts). Omitted for every other capability.
      competitorName: z.string().optional(),
    }),
  ),
});

export type ResearchExtractionOutput = z.infer<
  typeof ResearchExtractionOutputSchema
>;

export const researchExtractionDef: ReasoningDef<ResearchExtractionOutput> = {
  purpose: "research.extract-findings",
  schema: ResearchExtractionOutputSchema,
  // Runs for every research report; the job is format conversion, not
  // reasoning — the cheap tier suffices.
  tier: "lite" as const,
  maxTokens: 8192,

  buildPrompt(context) {
    return {
      system: [
        "You convert a free-form research report into discrete, atomic findings.",
        "One finding = one checkable claim. Never merge two claims into one statement.",
        "Classify honestly: VERIFIED_FACT only when the report cites or shows direct evidence; " +
          "LIKELY_FACT when strongly implied; ASSUMPTION when the researcher inferred it; " +
          "RECOMMENDATION for suggested actions; CONTRADICTION when the report contradicts itself.",
        "confidence is 0-1. Include sourceUrl only when the report gives an explicit URL.",
        "If the research capability is about competitors (COMPETITOR_RESEARCH, " +
          "COMPETITOR_MONITORING, COMPETITOR_CHANGE_DETECTION), set competitorName " +
          "to the specific company/brand each finding is about, whenever the report " +
          "names one — omit it for findings not tied to a single named competitor.",
        "Skip filler, headings and meta commentary about the research process itself.",
        "Return at most 25 findings, ordered by importance.",
      ].join(" "),
      user:
        `Research capability: ${String(context.capability ?? "?")}\n\n` +
        `Brand: ${JSON.stringify(context.brand ?? {})}\n\n` +
        `Report:\n${String(context.report ?? "")}`,
    };
  },

  buildMock(context) {
    const report = String(context.report ?? "");
    const lines = report
      .split("\n")
      .map((line) => line.replace(/^[#*\-\s]+/, "").trim())
      .filter((line) => line.length > 40)
      .slice(0, 5);
    return {
      findings: lines.map((statement) => ({
        statement: `Mock finding: ${statement.slice(0, 160)}`,
        classification: "LIKELY_FACT" as const,
        category: String(context.capability ?? "OTHER"),
        confidence: 0.6,
      })),
    };
  },
};
