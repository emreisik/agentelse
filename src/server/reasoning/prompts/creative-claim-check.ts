import { z } from "zod";

import type { ReasoningDef } from "../types";

// Brand-safety/claim gate for autonomously-generated creative (spec:
// CLAIM_VALIDATION / BRAND_SAFETY, docs/brand-workspace-migration.md §7
// Phase 5 already found these capabilities exist but are never dispatched
// against generated creative). Text-only (checks the idea's title/
// description/caption against the brand's own approvedClaims/negativeRules
// — NOT a visual/product-fidelity check, which would need a vision-capable
// reasoning path this codebase doesn't have wired up anywhere yet).
// Deliberately a single bounded check, not a revision loop: a flagged
// creative is routed to human review (see instagram-week-planner.ts),
// never auto-rewritten or auto-rejected.
export const CreativeClaimCheckOutputSchema = z.object({
  safe: z.boolean(),
  // Populated only when safe is false — shown to the human reviewer so
  // they know what to look at, not exposed to the end client.
  reason: z.string().optional(),
});

export type CreativeClaimCheckOutput = z.infer<
  typeof CreativeClaimCheckOutputSchema
>;

export const creativeClaimCheckDef: ReasoningDef<CreativeClaimCheckOutput> = {
  purpose: "creative.claim_check",
  schema: CreativeClaimCheckOutputSchema,
  // Runs once per autonomously-generated creative — cheap tier, same class
  // as chat.turn.
  tier: "lite",
  maxTokens: 512,

  buildPrompt(context) {
    return {
      system: [
        "You are a brand-safety reviewer for an AI marketing agency. You check ONE piece of planned content against the brand's own rules before it goes out unattended.",
        'Flag it (safe: false) ONLY for a concrete, checkable problem: it states something in `Never do this` (negativeRules), or makes a specific factual/product claim that is NOT in `Safe to use publicly` (approvedClaims) and isn\'t a generic, unverifiable marketing statement (e.g. "modern", "premium", "for everyone" are fine unflagged).',
        "Do not flag for subjective creative-direction opinions (tone, style, whether it's a good idea) — only for an actual rule violation or an unapproved specific claim.",
        "When flagging, `reason` is one short sentence a human reviewer can act on immediately.",
      ].join("\n"),
      user: [
        `Never do this (negativeRules): ${JSON.stringify(context.negativeRules ?? [])}`,
        `Safe to use publicly (approvedClaims): ${JSON.stringify(context.approvedClaims ?? [])}`,
        "",
        `Planned content — title: ${String(context.title ?? "")}`,
        `Planned content — description: ${String(context.description ?? "")}`,
      ].join("\n"),
    };
  },

  buildMock(context) {
    const text = `${String(context.title ?? "")} ${String(context.description ?? "")}`;
    const rules = Array.isArray(context.negativeRules)
      ? (context.negativeRules as unknown[])
      : [];
    const hit = rules.find(
      (rule) =>
        typeof rule === "string" &&
        rule.length > 0 &&
        text.toLowerCase().includes(rule.toLowerCase()),
    );
    return hit
      ? { safe: false, reason: `Mentions a "never do this" rule: ${hit}` }
      : { safe: true };
  },
};
