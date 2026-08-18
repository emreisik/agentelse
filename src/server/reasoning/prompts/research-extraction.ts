import { z } from "zod";

import type { ReasoningDef } from "../types";

// OpenClaw ajanları araştırmayı gerçekten yapıyor ama sonucu serbest metin
// (markdown rapor) olarak döndürüyor; ResultMaterializer ise yapılandırılmış
// `findings[]` bekliyor. Bu prompt aradaki köprü: raporu okunabilir
// bulgulara çevirir. Olmadığında araştırma sonuçları sessizce kayboluyordu
// ve anayasa "Belirsiz" diyerek üretiliyordu.
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
    }),
  ),
});

export type ResearchExtractionOutput = z.infer<
  typeof ResearchExtractionOutputSchema
>;

export const researchExtractionDef: ReasoningDef<ResearchExtractionOutput> = {
  purpose: "research.extract-findings",
  schema: ResearchExtractionOutputSchema,
  // Her araştırma raporu için çalışır; iş biçim dönüştürme, akıl yürütme
  // değil — ucuz kademe yeterli.
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
