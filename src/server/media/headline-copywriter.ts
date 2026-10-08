import "server-only";

import { z } from "zod";

import {
  openaiModelForTier,
  runOpenAIStructured,
} from "@/server/reasoning/openai-client";
import { strings, text } from "@/lib/brand-context-read";
import type { OnImageText } from "@/server/media/creative-text";
import type { HeadlineBudget } from "@/server/media/headline-budget";

// The words printed ON a post. They used to be one more field of the caption
// call (and, for ideas, one of fourteen written by the small model), under a
// blanket "at most six words". This is its own step with its own brief: the
// brand's voice and audience, what it has already said, and a budget that
// comes from the room the layout has. Best effort: any failure returns null and
// the draft the caller already has stands.

const OutputSchema = z.object({
  headline: z.string(),
  highlight: z.string().optional(),
  subline: z.string().optional(),
  cta: z.string().optional(),
});

const MAX_SUBLINE_CHARS = 64;
const MAX_CTA_CHARS = 24;
// A little over the budget is typeset (the typesetter shrinks to fit); a lot
// over is not a headline any more.
const OVER_BUDGET_TOLERANCE = 1.25;

// What the brand has put on pictures lately, so the next one does not repeat.
function recentHeadlines(context: Record<string, unknown>): string[] {
  const recent = Array.isArray(context.recentApprovedCreatives)
    ? (context.recentApprovedCreatives as unknown[])
    : [];
  const found: string[] = [];
  for (const creative of recent) {
    const versions = (creative as { versions?: unknown })?.versions;
    const metadata = Array.isArray(versions)
      ? (versions[0] as { generationMetadata?: unknown } | undefined)
          ?.generationMetadata
      : undefined;
    const words = (metadata as { onImageText?: { headline?: unknown } } | null)
      ?.onImageText;
    const headline = text(words?.headline, 120);
    if (headline) found.push(headline);
  }
  return found.slice(0, 6);
}

// The brand, as the writer needs it: short, labelled, nothing else.
export function copyContextOf(brandContext: unknown): Record<string, unknown> {
  const context =
    brandContext && typeof brandContext === "object"
      ? (brandContext as Record<string, unknown>)
      : {};
  const constitution = context.brandConstitution as
    | { summary?: unknown }
    | null
    | undefined;
  return {
    language: text(context.language, 40),
    country: text(context.country, 40),
    positioning: text(context.positioning, 400),
    toneOfVoice: text(context.toneOfVoice, 300),
    about: text(constitution?.summary, 500),
    audiences: strings(context.targetAudiences, 4),
    products: strings(context.products, 6),
    approvedClaims: strings(context.approvedClaims, 6),
    neverSay: strings(context.negativeBrief, 8),
    learnings: strings(context.brandLearnings, 5),
    recentHeadlines: recentHeadlines(context),
  };
}

export function buildCopywriterPrompt(input: {
  budget: HeadlineBudget;
  context: Record<string, unknown>;
  brief: string;
  caption?: string;
  draft?: OnImageText;
}): { system: string; user: string } {
  const { budget } = input;
  const system = [
    "You are the senior copywriter of a social-media agency. You write the words printed ON a post's picture. They are typeset large, so every word has to earn its place.",
    "",
    "HEADLINE",
    `- ${budget.minWords}-${budget.maxWords} words and at most ${budget.maxChars} characters. A complete thought, never a bare label or a trailing fragment.`,
    "- Make it hit: lead with a concrete benefit, a number, a sharp question, a contrast or a promise the post really keeps. Say something only this brand could say.",
    "- Generic is a failure: \"Discover our products\", \"Quality you can trust\", \"Keşfedin\", \"Kaliteli hizmet\", \"En iyisi bizde\". If it could sit on a competitor's post, rewrite it.",
    "- Write it the way a native speaker of the brand's language says it out loud, with that language's own idiom and every diacritic correct. No translation-ese.",
    "- No hashtags, emoji, quotation marks or full stop at the end.",
    "",
    "OTHER FIELDS",
    "- `highlight`: the one to three words of the headline that carry the hook, copied EXACTLY from it. Omit if none stands out.",
    `- \`subline\` (optional, at most ${MAX_SUBLINE_CHARS} characters): only what the headline does not already say: proof, an offer detail, a time. Omit when it would repeat.`,
    `- \`cta\` (optional, at most ${MAX_CTA_CHARS} characters, 1-3 words): an imperative that names the next step. Omit when the post has no action.`,
    "",
    "RULES",
    "- Voice and positioning in the brand context are the style guide. Speak to its audience.",
    "- Take every fact, number, price and claim from the brief or the approved claims. Never invent prices, discounts, dates or promises; never use anything under neverSay.",
    "- Do not repeat or lightly reword anything under recentHeadlines.",
    "- A draft may be given: keep what is strong and every fact in it, and make it sharper. If it is already excellent, return it with only the small fixes it needs.",
    "",
    "GOOD vs GENERIC (language of the brand, shown in English and Turkish)",
    "- generic: \"Fresh coffee every morning\" -> sharper: \"The first cup that makes Monday easier\"",
    "- generic: \"Yüksek kaliteli hizmet\" -> sharper: \"Randevunuz 3 dakikada, sonucunuz ömür boyu\"",
    "- generic: \"Yaz kampanyası başladı\" -> sharper: \"Yazın en sıcak fırsatı: her şeyde %30\" (only if the brief says 30%)",
    "",
    "Return JSON only.",
  ].join("\n");

  const user = [
    "BRAND CONTEXT (JSON):",
    JSON.stringify(input.context),
    "",
    `BRIEF: ${input.brief.slice(0, 1500)}`,
    ...(input.caption ? [`CAPTION OF THE POST: ${input.caption.slice(0, 400)}`] : []),
    ...(input.draft
      ? [
          `DRAFT TO IMPROVE: ${JSON.stringify({
            headline: input.draft.headline,
            highlight: input.draft.highlight,
            lines: input.draft.lines,
          })}`,
        ]
      : []),
  ].join("\n");

  return { system, user };
}

// Strips what must never be on a picture and keeps the rest; null when nothing
// usable is left or the headline is far past what the layout can carry.
export function finishOnImageText(
  raw: unknown,
  budget: HeadlineBudget,
): OnImageText | null {
  const parsed = OutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const clean = (value: string | undefined) =>
    (value ?? "")
      .replace(/["“”„«»]/g, "")
      .replace(/#\S+/g, "")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/\s+/g, " ")
      .trim();

  const headline = clean(parsed.data.headline).replace(/[.。]+$/u, "").trim();
  if (!headline) return null;
  if (headline.length > budget.maxChars * OVER_BUDGET_TOLERANCE) return null;

  const highlight = clean(parsed.data.highlight);
  const subline = clean(parsed.data.subline).slice(0, MAX_SUBLINE_CHARS).trim();
  const cta = clean(parsed.data.cta).replace(/[.。]+$/u, "").slice(0, MAX_CTA_CHARS).trim();
  const lines = subline ? [subline] : [];

  return {
    headline,
    // Only words that really are in the headline can be set in the accent.
    ...(highlight && headline.toLocaleLowerCase("tr").includes(highlight.toLocaleLowerCase("tr"))
      ? { highlight }
      : {}),
    ...(lines.length > 0 ? { lines } : {}),
    ...(cta ? { cta } : {}),
  };
}

export async function writeOnImageText(input: {
  brandContext: unknown;
  brief: string;
  caption?: string;
  draft?: OnImageText;
  budget: HeadlineBudget;
}): Promise<OnImageText | null> {
  try {
    const { system, user } = buildCopywriterPrompt({
      budget: input.budget,
      context: copyContextOf(input.brandContext),
      brief: input.brief,
      caption: input.caption,
      draft: input.draft,
    });
    const { raw } = await runOpenAIStructured({
      model: openaiModelForTier(),
      system,
      user,
      jsonSchema: z.toJSONSchema(OutputSchema),
      maxOutputTokens: 1200,
    });
    return finishOnImageText(raw, input.budget);
  } catch (error) {
    console.error("[headline-copywriter] failed, keeping the draft:", error);
    return null;
  }
}
