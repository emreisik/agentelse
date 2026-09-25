import { z } from "zod";

import type { ReasoningContext, ReasoningDef } from "../types";

// A partial Constitution patch — every field optional/nullable because
// "the model didn't mention this field" must mean "leave it alone," not
// "clear it." brand-brain-chat-service.ts's merge only touches fields that
// are actually present (non-null/undefined) here. Deliberately NOT reusing
// constitution-synthesis.ts's zLenientStringArray() — that helper's whole
// job is "missing/null becomes []", which is exactly backwards for a patch
// (it would silently wipe every field the model didn't address). No
// .transform() here either, for the same z.toJSONSchema() reason documented
// on that helper — plain .nullable().optional() has no such restriction.
export const BrandBrainRevisionSchema = z.object({
  identity: z.string().nullable().optional(),
  positioning: z.string().nullable().optional(),
  valueProposition: z.string().nullable().optional(),
  personality: z.string().nullable().optional(),
  toneOfVoice: z.string().nullable().optional(),
  knownFacts: z.array(z.string()).nullable().optional(),
  assumptions: z.array(z.string()).nullable().optional(),
  approvedClaims: z.array(z.string()).nullable().optional(),
  forbiddenClaims: z.array(z.string()).nullable().optional(),
  negativeBrief: z.array(z.string()).nullable().optional(),
  differentiators: z.array(z.string()).nullable().optional(),
  competitors: z.array(z.string()).nullable().optional(),
});

export type BrandBrainRevision = z.infer<typeof BrandBrainRevisionSchema>;

// Mirrors the shape of the AskUserQuestion tool: a short question plus 2-4
// concrete, pickable options. Lets the model steer the conversation with
// clickable choices instead of a vague open-ended question whenever there's
// a genuine fork (tone, positioning angle, target segment, etc.) — the
// client picks one, the label becomes their next message.
const BrandBrainQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
const BrandBrainQuestionSchema = z.object({
  question: z.string(),
  options: z.array(BrandBrainQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
export type BrandBrainQuestion = z.infer<typeof BrandBrainQuestionSchema>;

export const BrandBrainChatOutputSchema = z.object({
  reply: z.string(),
  // Only present when the model wants to fork the conversation with
  // pickable options instead of (or alongside) free narration — see
  // BrandBrainQuestionSchema above. Usually null.
  questions: z.array(BrandBrainQuestionSchema).max(2).nullable(),
  // Only present once the conversation has reached a concrete, actionable
  // direction — most turns are pure discussion (null here). Mirrors
  // ExitPlanMode's own shape: narrate/discuss freely, only present a
  // concrete proposal once there's something specific to sign off on.
  proposedRevision: BrandBrainRevisionSchema.nullable(),
  // Short "why" shown on the proposal card next to the field diffs —
  // required whenever proposedRevision is non-null (buildPrompt says so;
  // not schema-enforced since zod can't express that cross-field rule
  // without a .refine() that would itself break z.toJSONSchema()).
  revisionSummary: z.string().nullable(),
});

export type BrandBrainChatOutput = z.infer<typeof BrandBrainChatOutputSchema>;

function brand(context: ReasoningContext): Record<string, unknown> {
  return (context.brand as Record<string, unknown> | undefined) ?? {};
}

export const brandBrainChatDef: ReasoningDef<BrandBrainChatOutput> = {
  purpose: "brand_brain.chat",
  schema: BrandBrainChatOutputSchema,
  tier: "pro",
  maxTokens: 4096,

  buildPrompt(context) {
    return {
      system:
        "You are the brand strategist inside this brand's Brand Brain — a " +
        "standing conversation the client can open any time to discuss, " +
        "challenge, or refine the brand's constitution and strategy. Discuss " +
        "openly: ask questions, push back, offer analysis grounded in the " +
        "current constitution/strategy/learnings given below. Do NOT propose " +
        "a revision on every turn — only once the conversation has reached a " +
        "genuinely concrete, actionable direction the client seems ready to " +
        "commit to. When you do propose one, set proposedRevision to ONLY the " +
        "fields that should actually change (omit/null everything else — " +
        "never restate unchanged fields) and revisionSummary to a one or two " +
        "sentence plain-language reason. Otherwise leave both null and just " +
        "reply. " +
        "Whenever there's a genuine fork in the road — more than one " +
        "reasonable tone, positioning angle, target segment, claim, etc. — " +
        "prefer asking via `questions` (1-2 short questions, each with 2-4 " +
        "concrete pickable options) over a vague open-ended question in " +
        "`reply`. Ground every option in the brand context given below " +
        "(its actual sector/industry, positioning, target audience, " +
        "products) instead of generic textbook options — each option should " +
        "read like it was written specifically for this brand, not " +
        "boilerplate. Leave `questions` null on turns where the direction " +
        "is already clear or you're just answering directly. Match the " +
        "client's own language (reply in Turkish if they write in Turkish, " +
        "including the question/option text).",
      user:
        `Current brand context:\n${JSON.stringify(brand(context), null, 2)}\n\n` +
        `Conversation so far:\n${String(context.history ?? "(no prior messages)")}\n\n` +
        `Client's new message:\n${String(context.message ?? "")}`,
    };
  },

  buildMock() {
    // Demo/integration-test mode never auto-proposes a revision — a
    // deterministic reply is enough to prove the turn round-trips; the
    // "propose -> apply" path is exercised via brand-brain-chat-service's
    // own unit tests (ReasoningService itself mocked there), not via this
    // mock-mode branch.
    return {
      reply: "(mock) Got it — tell me more about what you'd like to change.",
      questions: null,
      proposedRevision: null,
      revisionSummary: null,
    };
  },
};
