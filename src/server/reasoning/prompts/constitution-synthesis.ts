import { z } from "zod";

import type { ReasoningContext, ReasoningDef } from "../types";

// The Brand Constitution payload contract — mirrors constitution-schema.ts's
// section list. Kept flat string arrays where possible so mock derivation and
// real extraction share one shape.
export const ConstitutionOutputSchema = z.object({
  language: z.string(),
  country: z.string(),
  identity: z.string(),
  businessModel: z.string(),
  products: z.array(z.string()),
  markets: z.array(z.string()),
  audiences: z.array(z.string()),
  positioning: z.string(),
  valueProposition: z.string(),
  personality: z.string(),
  toneOfVoice: z.string(),
  visualIdentity: z.string(),
  approvedClaims: z.array(z.string()),
  forbiddenClaims: z.array(z.string()),
  negativeBrief: z.array(z.string()),
  customerProblems: z.array(z.string()),
  customerObjections: z.array(z.string()),
  competitors: z.array(z.string()),
  differentiators: z.array(z.string()),
  legalRestrictions: z.array(z.string()),
  knownFacts: z.array(z.string()),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type ConstitutionOutput = z.infer<typeof ConstitutionOutputSchema>;

type FindingLike = {
  statement: string;
  classification: string;
  category?: string | null;
};

function findings(context: ReasoningContext): FindingLike[] {
  return (context.findings as FindingLike[] | undefined) ?? [];
}

function brandName(context: ReasoningContext): string {
  return (context.brandName as string | undefined) ?? "the brand";
}

function languageName(context: ReasoningContext): string {
  return (context.languageName as string | undefined) ?? "Turkish";
}

function countryName(context: ReasoningContext): string {
  return (context.countryName as string | undefined) ?? "Turkey";
}

export const constitutionSynthesisDef: ReasoningDef<ConstitutionOutput> = {
  purpose: "constitution.synthesize",
  schema: ConstitutionOutputSchema,
  // 22 bölümlük anayasa, üstelik Gemini'de düşünme tokenları da bu limite
  // sayılıyor: gerçek bulgularla beslendiğinde 8192'de yanıt JSON'un
  // ortasında kesiliyordu (finishReason: MAX_TOKENS).
  maxTokens: 32768,

  buildPrompt(context) {
    const lines = findings(context)
      .map((f) => `- [${f.classification}] ${f.statement}`)
      .join("\n");
    return {
      system:
        "You are the brand-strategy synthesizer of an AI agency operating system. " +
        "You turn verified research findings into a Brand Constitution — the single " +
        "source of truth every downstream department consults. Only place claims in " +
        "knownFacts when the finding was VERIFIED_FACT or LIKELY_FACT; everything " +
        "inferred goes to assumptions; unresolved conflicts go to openQuestions. " +
        "Never invent facts that are not supported by the findings. " +
        `Write the entire constitution in ${languageName(context)}, focused on the ${countryName(context)} market — set the "language" field to "${languageName(context)}" and "country" to "${countryName(context)}" verbatim.`,
      user:
        `Brand: ${brandName(context)}\nDomain: ${String(context.domain ?? "unknown")}\n` +
        `Client description: ${String(context.description ?? "-")}\n\n` +
        `Research findings:\n${lines}\n\nSynthesize the Brand Constitution.`,
    };
  },

  // Deterministic derivation: every section is built from the actual findings
  // and intake fields, so tests assert real data flow, not canned strings.
  buildMock(context) {
    const all = findings(context);
    const name = brandName(context);
    const domain = String(context.domain ?? "unknown.example");
    const byClass = (cls: string) =>
      all.filter((f) => f.classification === cls).map((f) => f.statement);
    const byCategory = (cat: string) =>
      all
        .filter((f) => (f.category ?? "").toLowerCase().includes(cat))
        .map((f) => f.statement);

    return {
      language: (context.language as string | undefined) ?? "tr",
      country: (context.country as string | undefined) ?? "TR",
      identity: `${name} (${domain}) — identity synthesized from ${all.length} findings`,
      businessModel:
        byCategory("business")[0] ??
        `Business model of ${name} inferred from research`,
      products: byCategory("product").slice(0, 5),
      markets: byCategory("market").slice(0, 5),
      audiences: byCategory("customer").slice(0, 5),
      positioning:
        byCategory("brand")[0] ?? `${name} positioning derived from findings`,
      valueProposition: `Primary value proposition of ${name} based on research`,
      personality: `Brand personality profile for ${name}`,
      toneOfVoice: `Tone of voice guide for ${name}`,
      visualIdentity: `Visual identity notes for ${name}`,
      approvedClaims: byClass("VERIFIED_FACT").slice(0, 5),
      forbiddenClaims: [],
      negativeBrief: [`Do not misrepresent ${name} pricing or guarantees`],
      customerProblems: byCategory("customer").slice(0, 3),
      customerObjections: [],
      competitors: byCategory("competitor").slice(0, 6),
      differentiators: byClass("LIKELY_FACT").slice(0, 3),
      legalRestrictions: [],
      knownFacts: [...byClass("VERIFIED_FACT"), ...byClass("LIKELY_FACT")],
      assumptions: byClass("ASSUMPTION"),
      openQuestions: [
        ...byClass("CONTRADICTION").map((s) => `Conflict to resolve: ${s}`),
        ...byClass("UNKNOWN"),
      ],
    };
  },
};
