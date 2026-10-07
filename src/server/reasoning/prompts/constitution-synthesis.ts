import { z } from "zod";

import type { ReasoningContext, ReasoningDef } from "../types";

// Several sections are legitimately empty for a given brand (buildMock
// itself returns [] below for forbiddenClaims/customerObjections/
// legalRestrictions etc. when there's nothing to say) — a model with
// nothing to say for one is plausible to return null or omit the key
// entirely instead of `[]`, which a plain `z.array(z.string())` rejects
// outright. This is the single most expensive reasoning call in the system
// (32768 tokens, 22 sections) — losing the whole synthesis over one absent
// array is a much worse failure than defaulting that one section to empty.
//
// The trailing .pipe(z.array(z.string())) is required, not decorative: a
// bare .transform() has no declared output type, and reasoning-service.ts
// passes `z.toJSONSchema(def.schema)` to the provider on every REAL call —
// z.toJSONSchema() throws "Transforms cannot be represented in JSON Schema"
// on a bare transform. This made EVERY real constitution.synthesize call
// fail with that exact error (confirmed in prod logs) until this was added.
const zLenientStringArray = () =>
  z
    .array(z.string())
    .nullable()
    .optional()
    .transform((value) => value ?? [])
    .pipe(z.array(z.string()));

// The Brand Constitution payload contract — mirrors constitution-schema.ts's
// section list. Kept flat string arrays where possible so mock derivation and
// real extraction share one shape.
export const ConstitutionOutputSchema = z.object({
  language: z.string(),
  country: z.string(),
  identity: z.string(),
  businessModel: z.string(),
  products: zLenientStringArray(),
  markets: zLenientStringArray(),
  audiences: zLenientStringArray(),
  positioning: z.string(),
  valueProposition: z.string(),
  personality: z.string(),
  toneOfVoice: z.string(),
  visualIdentity: z.string(),
  approvedClaims: zLenientStringArray(),
  forbiddenClaims: zLenientStringArray(),
  negativeBrief: zLenientStringArray(),
  customerProblems: zLenientStringArray(),
  customerObjections: zLenientStringArray(),
  competitors: zLenientStringArray(),
  differentiators: zLenientStringArray(),
  legalRestrictions: zLenientStringArray(),
  knownFacts: zLenientStringArray(),
  assumptions: zLenientStringArray(),
  openQuestions: zLenientStringArray(),
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

// The active constitution, when one exists, as compact JSON for the prompt.
// Capped: it only has to remind the model what is already established.
const PREVIOUS_CONSTITUTION_MAX_CHARS = 8_000;

function previousConstitution(context: ReasoningContext): string | undefined {
  const previous = context.previousConstitution;
  if (!previous || typeof previous !== "object") return undefined;
  const json = JSON.stringify(previous);
  return json.length > PREVIOUS_CONSTITUTION_MAX_CHARS
    ? `${json.slice(0, PREVIOUS_CONSTITUTION_MAX_CHARS)}…`
    : json;
}

function brandName(context: ReasoningContext): string {
  return (context.brandName as string | undefined) ?? "the brand";
}

function languageName(context: ReasoningContext): string {
  return (context.languageName as string | undefined) ?? "English";
}

function countryName(context: ReasoningContext): string {
  return (context.countryName as string | undefined) ?? "United States";
}

export const constitutionSynthesisDef: ReasoningDef<ConstitutionOutput> = {
  purpose: "constitution.synthesize",
  schema: ConstitutionOutputSchema,
  // A 22-section constitution, and on top of that, reasoning
  // tokens also count against this limit: when fed real findings, the
  // response at 8192 was getting cut off mid-JSON (finishReason: MAX_TOKENS).
  maxTokens: 32768,

  buildPrompt(context) {
    const previous = previousConstitution(context);
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
        (previous
          ? `An earlier first-draft constitution exists (written from the brand's public pages before this research). Treat it as your starting point: keep what the findings still support, correct what they contradict, and extend it with what the research adds. Do not drop established facts just because the findings do not repeat them, and do not turn its assumptions into facts without a finding that supports them.\nEarlier draft:\n${previous}\n\n`
          : "") +
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
