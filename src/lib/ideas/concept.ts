// Typed ideas (docs/ideas.md). An idea knows which module it is for and
// carries a draft of that module's finished output, so the Ideas board can
// show it as the thing it becomes (a post, a search result, a sponsored post)
// and "Make this post" needs no further writing. Stored in Idea.concept as
// { v: 2, module, ... }: anything else there (the old agency pipeline's
// { bigIdea, executionSketch, departmentsInvolved }) is an older, untyped
// idea. Pure and isomorphic: the board, the engine and the planner all read
// ideas through here.

import { z } from "zod";

import {
  CHANNEL_KEYS,
  CHANNELS,
  type ChannelKey,
} from "@/lib/content-channels";
import { foldForMatch } from "@/lib/text-fold";

export const IDEA_CONCEPT_VERSION = 2;

// Analytics makes no ideas of its own: it is a source the others read.
export const IDEA_MODULES = ["social", "seo", "ads"] as const;
export type IdeaModule = (typeof IDEA_MODULES)[number];

// Where an idea came from, for the board's "why" chip and its filters.
export const IDEA_SOURCES = [
  "trend",
  "season",
  "results",
  "brand",
  "chat",
  "opportunity",
  "search",
  "manual",
] as const;
export type IdeaSource = (typeof IDEA_SOURCES)[number];

export const DISMISS_REASONS = [
  "off-brand",
  "not-now",
  "done-before",
  "too-salesy",
  "other",
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

// The words written on the picture (creative-text.ts typesets at most ~6).
export const HEADLINE_MAX_WORDS = 6;

const text = (max: number) => z.string().trim().min(1).max(max);

export const SocialDraftSchema = z.object({
  // The post's hook: its topic on the plan, its first line.
  hook: text(160),
  // On the picture, in the layout's headline zone.
  headline: text(80),
  // The words of the headline set in the brand's accent colour.
  highlight: z.string().trim().max(60).optional(),
  // One concrete scene: subject, setting, framing, mood.
  visual: text(400),
  // 1-3 sentences in the brand's voice ending with one call to action.
  caption: text(900),
  channels: z.array(z.enum(CHANNEL_KEYS)).min(1).max(5),
  // "instagram.post" | "instagram.carousel" | "instagram.story" | ...
  formatKey: z.string().max(40).optional(),
  // One of the brand's post layouts (src/lib/layout-templates.ts).
  layoutId: z.string().max(40).optional(),
  // The content pillar, a word or two ("Behind the scenes").
  pillar: z.string().trim().max(40).optional(),
  // When it fits best, in words ("Thursday morning", "before Oct 31").
  timing: z.string().trim().max(80).optional(),
});
export type SocialDraft = z.infer<typeof SocialDraftSchema>;

export const SEO_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
] as const;

export const SeoDraftSchema = z.object({
  keyword: text(100),
  intent: z.enum(SEO_INTENTS),
  // The search result: its title and meta description.
  title: text(90),
  description: text(200),
  angle: text(300),
});
export type SeoDraft = z.infer<typeof SeoDraftSchema>;

export const AD_OBJECTIVES = ["traffic", "awareness", "engagement"] as const;

export const AdDraftSchema = z.object({
  // The approved or published post to put money behind.
  creativeId: z.string().min(1).max(64),
  // That post's picture, for the card.
  assetId: z.string().max(64).optional(),
  // What the ad says, from the post's own hook.
  angle: text(200),
  objective: z.enum(AD_OBJECTIVES),
  audience: z.string().trim().max(200).optional(),
});
export type AdDraft = z.infer<typeof AdDraftSchema>;

const EvidenceSchema = z.object({
  title: text(140),
  url: z.string().url().max(500),
});

const FeedbackSchema = z.object({
  reason: z.enum(DISMISS_REASONS),
  at: z.string().max(40),
});

const base = {
  v: z.literal(IDEA_CONCEPT_VERSION),
  source: z.enum(IDEA_SOURCES),
  // One line: why this idea, why now.
  why: z.string().trim().max(240).optional(),
  // 3 = strong, 2 = good, 1 = worth a try.
  strength: z.number().int().min(1).max(3).optional(),
  // A time-bound idea (a holiday, a launch) leaves the pool after this.
  expiresAt: z.string().max(40).optional(),
  evidence: z.array(EvidenceSchema).max(3).optional(),
  feedback: FeedbackSchema.optional(),
  // "Another angle" on this idea.
  relatedIdeaId: z.string().max(64).optional(),
};

export const IdeaConceptSchema = z.discriminatedUnion("module", [
  z.object({ ...base, module: z.literal("social"), draft: SocialDraftSchema }),
  z.object({ ...base, module: z.literal("seo"), draft: SeoDraftSchema }),
  z.object({ ...base, module: z.literal("ads"), draft: AdDraftSchema }),
]);
export type IdeaConcept = z.infer<typeof IdeaConceptSchema>;
export type SocialIdeaConcept = Extract<IdeaConcept, { module: "social" }>;
export type SeoIdeaConcept = Extract<IdeaConcept, { module: "seo" }>;
export type AdIdeaConcept = Extract<IdeaConcept, { module: "ads" }>;

// null for an untyped (older) idea or a concept that no longer validates.
export function parseIdeaConcept(value: unknown): IdeaConcept | null {
  const parsed = IdeaConceptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isSocialConcept(
  concept: IdeaConcept | null,
): concept is SocialIdeaConcept {
  return concept?.module === "social";
}

export function strengthOf(concept: IdeaConcept | null): 1 | 2 | 3 {
  const value = concept?.strength;
  return value === 1 || value === 3 ? value : 2;
}

// Expired: its date has passed. An unreadable date never expires an idea.
export function isExpired(concept: IdeaConcept | null, now: Date): boolean {
  if (!concept?.expiresAt) return false;
  const at = Date.parse(concept.expiresAt);
  return Number.isFinite(at) && at < now.getTime();
}

// At most `max` words, without closing punctuation (the layout's headline is
// typeset as written, and creative-text.ts never wants the full stop; a cut
// mid-sentence must not leave a dangling comma either).
export function clampHeadline(
  value: string,
  max: number = HEADLINE_MAX_WORDS,
): string {
  const words = value.trim().split(/\s+/u).filter(Boolean).slice(0, max);
  return words
    .join(" ")
    .replace(/[\s.,;:。、–—-]+$/u, "")
    .trim();
}

// The planner's `captionIdea` shape (works-notes.ts WORKS_SOCIAL_PLAN_NOTE):
// the on-image headline in quotes, the scene, then the caption. Production
// reads it as the piece's brief, and its text step keeps the quoted headline
// as written.
export function captionIdeaOf(draft: SocialDraft): string {
  const headline = draft.headline.replace(/"/g, "'");
  return `"${headline}" | ${draft.visual} | ${draft.caption}`;
}

// The social channels a draft may name, in catalogue order.
export function socialChannelsOf(
  channels: readonly string[],
  allowed?: readonly ChannelKey[],
): ChannelKey[] {
  const allow = allowed ? new Set<string>(allowed) : null;
  const out: ChannelKey[] = [];
  for (const key of CHANNEL_KEYS) {
    if (CHANNELS[key].group !== "social") continue;
    if (!channels.includes(key)) continue;
    if (allow && !allow.has(key)) continue;
    out.push(key);
  }
  return out;
}

// --- duplicates -----------------------------------------------------------------

function keyText(concept: IdeaConcept): string {
  switch (concept.module) {
    case "social":
      return concept.draft.hook;
    case "seo":
      return concept.draft.keyword;
    case "ads":
      return concept.draft.creativeId;
  }
}

function words(value: string): string[] {
  return foldForMatch(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
}

// The exact-match key stored in Idea.fingerprint: the module and its key
// text (the hook, the keyword, the boosted post), folded.
export function ideaFingerprint(concept: IdeaConcept): string {
  return `${concept.module}:${words(keyText(concept)).join(" ")}`.slice(0, 180);
}

// How much two texts share, 0..1 (Jaccard over their words of 3+ letters).
export function wordOverlap(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// Close enough to count as the same idea.
export const DUPLICATE_OVERLAP = 0.6;

export function isNearDuplicate(
  text: string,
  others: readonly string[],
): boolean {
  const own = words(text).join(" ");
  if (!own) return false;
  return others.some(
    (other) =>
      words(other).join(" ") === own ||
      wordOverlap(text, other) >= DUPLICATE_OVERLAP,
  );
}

// The text an idea is compared by: what a person would call "the same idea".
export function ideaKeyText(concept: IdeaConcept): string {
  return keyText(concept);
}
