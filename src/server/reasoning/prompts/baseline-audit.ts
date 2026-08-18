import { z } from "zod";

import type { ReasoningDef } from "../types";

export const BaselineAuditOutputSchema = z.object({
  score: z.number().min(0).max(100),
  summary: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  risks: z.array(z.string()),
  potentialOpportunities: z.array(z.string()),
});

export type BaselineAuditOutput = z.infer<typeof BaselineAuditOutputSchema>;

export const baselineAuditDef: ReasoningDef<BaselineAuditOutput> = {
  purpose: "baseline-audit.generate",
  schema: BaselineAuditOutputSchema,
  // 4 dizi + özet üretiyor ve Gemini'de düşünme tokenları da bu limite
  // sayılıyor: 2048'de yanıt JSON'un ortasında kesiliyordu ("non-JSON
  // output despite responseMimeType") ve çağrıların ~%27'si düşüyordu.
  maxTokens: 4096,

  buildPrompt(context) {
    return {
      system:
        "You audit one agency department's current situation for a brand, " +
        "based on research findings. Score 0-100 (current maturity/health), " +
        "list concrete strengths/weaknesses/risks and potential opportunities. " +
        "Ground everything in the findings — no generic filler.",
      user:
        `Department: ${String(context.department ?? "?")}\n\n` +
        `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
        `Relevant findings:\n${JSON.stringify(context.findings ?? [], null, 2)}\n\n` +
        "Produce the baseline audit.",
    };
  },

  buildMock(context) {
    const department = String(context.department ?? "DEPARTMENT");
    const findings = (context.findings ?? []) as Array<{ statement?: string }>;
    const statements = findings.map((f) => f.statement ?? "").filter(Boolean);
    const seed = [...department].reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      score: 40 + (seed % 35),
      summary: `Mock baseline audit for ${department} built from ${statements.length} findings`,
      strengths: statements.slice(0, 2).map((s) => `Strength signal: ${s}`),
      weaknesses: statements.slice(2, 4).map((s) => `Gap signal: ${s}`),
      risks: statements.slice(4, 5).map((s) => `Risk signal: ${s}`),
      potentialOpportunities: statements
        .slice(0, 2)
        .map((s) => `Opportunity from: ${s}`),
    };
  },
};
