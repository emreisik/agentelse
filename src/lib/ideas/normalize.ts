// What the idea engine keeps of a model's post ideas (docs/ideas.md). Every
// field is cleaned, bounded and checked against the brand's real channels and
// layouts; an idea missing what a post needs is dropped, never repaired by
// guessing. Pure, so the rules are testable without a model.

import { CHANNELS, type ChannelKey } from "@/lib/content-channels";
import { addDaysToKey } from "@/lib/content-plan-view";
import {
  IDEA_CONCEPT_VERSION,
  IDEA_SOURCES,
  IdeaConceptSchema,
  clampHeadline,
  isNearDuplicate,
  socialChannelsOf,
  type IdeaSource,
  type SeoIdeaConcept,
  type SocialIdeaConcept,
} from "@/lib/ideas/concept";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";

// The model's shape (idea-social.ts IdeaSocialSchema), loose.
export type RawSocialIdea = {
  hook: string;
  headline: string;
  highlight?: string;
  visual: string;
  caption: string;
  channels?: string[];
  format?: string;
  layoutId?: string;
  pillar?: string;
  timing?: string;
  source?: string;
  why?: string;
  strength?: number;
  expiresOn?: string;
  signal?: number;
};

export type NormalizeContext = {
  // The brand's social channels, best first; never empty.
  channels: readonly ChannelKey[];
  // The brand's saved layouts.
  layoutIds: readonly string[];
  // The signals the prompt listed, numbered from 1.
  signals: readonly { title: string; url?: string | null }[];
  today: string;
  timezone: string;
  // Overrides the model's source (an opportunity's ideas, a chat's).
  source?: IdeaSource;
  relatedIdeaId?: string;
  // Texts the new ideas must not repeat (pool hooks, recent post topics).
  avoid?: readonly string[];
};

// A time-bound idea may run this far ahead, no further.
const MAX_EXPIRY_DAYS = 120;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function clean(value: unknown, max: number): string | null {
  return cleanWorksTextOrNull(value, max);
}

// The format a draft names: Story and carousel are Instagram's; anything else
// is the first channel's plain post.
export function formatKeyFor(
  format: string | undefined,
  channels: readonly ChannelKey[],
): string | undefined {
  const wanted = (format ?? "").trim().toLowerCase();
  if (
    channels.includes("instagram") &&
    (wanted === "story" || wanted === "carousel")
  ) {
    return `instagram.${wanted}`;
  }
  const first = channels[0];
  if (!first) return undefined;
  const formats = CHANNELS[first].formats;
  return (formats.find((entry) => entry.key === `${first}.post`) ?? formats[0])
    ?.key;
}

function expiryOf(
  raw: string | undefined,
  today: string,
  timezone: string,
): string | undefined {
  const day = raw?.trim();
  if (!day || !DATE_KEY.test(day)) return undefined;
  if (day < today || day > addDaysToKey(today, MAX_EXPIRY_DAYS))
    return undefined;
  try {
    return zonedDateTimeToUtc(`${day}T23:59`, timezone).toISOString();
  } catch {
    return undefined;
  }
}

function sourceOf(raw: string | undefined, fallback: IdeaSource): IdeaSource {
  const value = raw?.trim().toLowerCase();
  return (IDEA_SOURCES as readonly string[]).includes(value ?? "")
    ? (value as IdeaSource)
    : fallback;
}

export function normalizeSocialIdea(
  raw: RawSocialIdea,
  ctx: NormalizeContext,
): SocialIdeaConcept | null {
  const hook = clean(raw.hook, 160);
  const visual = clean(raw.visual, 400);
  const caption = clean(raw.caption, 900);
  if (!hook || !visual || !caption) return null;

  const headline = clampHeadline(clean(raw.headline, 80) ?? hook);
  if (!headline) return null;
  const highlight = clean(raw.highlight, 60);

  const allowed =
    ctx.channels.length > 0 ? ctx.channels : (["instagram"] as const);
  const named = socialChannelsOf(raw.channels ?? [], allowed);
  const channels = named.length > 0 ? named : [allowed[0]!];

  const layoutId =
    raw.layoutId && ctx.layoutIds.includes(raw.layoutId.trim())
      ? raw.layoutId.trim()
      : undefined;
  const pillar = clean(raw.pillar, 40);
  const timing = clean(raw.timing, 80);
  const why = clean(raw.why, 240);
  const strength = Math.min(3, Math.max(1, Math.round(raw.strength ?? 2)));
  const expiresAt = expiryOf(raw.expiresOn, ctx.today, ctx.timezone);

  const signal =
    typeof raw.signal === "number" && Number.isInteger(raw.signal)
      ? ctx.signals[raw.signal - 1]
      : undefined;
  const evidence =
    signal?.url && /^https?:\/\//i.test(signal.url)
      ? [{ title: signal.title.slice(0, 140), url: signal.url.slice(0, 500) }]
      : undefined;

  const concept = {
    v: IDEA_CONCEPT_VERSION,
    module: "social" as const,
    source: ctx.source ?? sourceOf(raw.source, "brand"),
    ...(why ? { why } : {}),
    strength,
    ...(expiresAt ? { expiresAt } : {}),
    ...(evidence ? { evidence } : {}),
    ...(ctx.relatedIdeaId ? { relatedIdeaId: ctx.relatedIdeaId } : {}),
    draft: {
      hook,
      headline,
      ...(highlight && headline.toLowerCase().includes(highlight.toLowerCase())
        ? { highlight }
        : {}),
      visual,
      caption,
      channels,
      ...(formatKeyFor(raw.format, channels)
        ? { formatKey: formatKeyFor(raw.format, channels) }
        : {}),
      ...(layoutId ? { layoutId } : {}),
      ...(pillar ? { pillar } : {}),
      ...(timing ? { timing } : {}),
    },
  };
  const parsed = IdeaConceptSchema.safeParse(concept);
  return parsed.success && parsed.data.module === "social" ? parsed.data : null;
}

// The batch the engine keeps: cleaned, and with no idea that repeats another
// in the batch, the pool or a recent post.
export function normalizeSocialIdeas(
  raws: readonly RawSocialIdea[],
  ctx: NormalizeContext,
): SocialIdeaConcept[] {
  const seen: string[] = [...(ctx.avoid ?? [])];
  const out: SocialIdeaConcept[] = [];
  for (const raw of raws) {
    const concept = normalizeSocialIdea(raw, ctx);
    if (!concept) continue;
    if (isNearDuplicate(concept.draft.hook, seen)) continue;
    seen.push(concept.draft.hook);
    out.push(concept);
  }
  return out;
}

// --- article ideas ------------------------------------------------------------

export type RawSeoIdea = {
  keyword: string;
  intent?: string;
  title: string;
  description: string;
  angle: string;
  source?: string;
  why?: string;
  strength?: number;
};

const INTENTS = ["informational", "commercial", "transactional", "navigational"] as const;

export function normalizeSeoIdea(raw: RawSeoIdea): SeoIdeaConcept | null {
  const keyword = clean(raw.keyword, 100);
  const title = clean(raw.title, 90);
  const description = clean(raw.description, 200);
  const angle = clean(raw.angle, 300);
  if (!keyword || !title || !description || !angle) return null;
  const intent = (INTENTS as readonly string[]).includes(raw.intent?.trim().toLowerCase() ?? "")
    ? (raw.intent!.trim().toLowerCase() as (typeof INTENTS)[number])
    : "informational";
  const why = clean(raw.why, 240);
  const concept = {
    v: IDEA_CONCEPT_VERSION,
    module: "seo" as const,
    source: sourceOf(raw.source, "brand"),
    ...(why ? { why } : {}),
    strength: Math.min(3, Math.max(1, Math.round(raw.strength ?? 2))),
    draft: { keyword, intent, title, description, angle },
  };
  const parsed = IdeaConceptSchema.safeParse(concept);
  return parsed.success && parsed.data.module === "seo" ? parsed.data : null;
}

export function normalizeSeoIdeas(
  raws: readonly RawSeoIdea[],
  avoid: readonly string[] = [],
): SeoIdeaConcept[] {
  const seen: string[] = [...avoid];
  const out: SeoIdeaConcept[] = [];
  for (const raw of raws) {
    const concept = normalizeSeoIdea(raw);
    if (!concept) continue;
    if (isNearDuplicate(concept.draft.keyword, seen)) continue;
    seen.push(concept.draft.keyword);
    out.push(concept);
  }
  return out;
}
