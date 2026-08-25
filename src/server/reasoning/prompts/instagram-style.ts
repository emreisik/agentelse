import { z } from "zod";

import type { ReasoningDef } from "../types";

const HEX = /^#[0-9a-fA-F]{3,8}$/;

const ColorSwatchSchema = z.object({
  hex: z.string().regex(HEX, "Invalid hex color"),
  name: z.string().optional(),
});

// Deliberately a SUBSET of BrandVisualIdentity's fields — only the ones a
// design director could actually infer by looking at a handful of post
// images. Template/logo geometry and alwaysInclude/alwaysAvoid are
// instructional knobs, not visual observations, so they're left for the
// user to set by hand in the edit Sheet this suggestion pre-fills.
export const InstagramStyleSuggestionSchema = z.object({
  primaryColors: z.array(ColorSwatchSchema).max(4),
  secondaryColors: z.array(ColorSwatchSchema).max(4),
  accentColors: z.array(ColorSwatchSchema).max(3),
  photographyStyle: z.enum([
    "PHOTOGRAPHIC",
    "ILLUSTRATED",
    "THREE_D_RENDER",
    "FLAT_DESIGN",
    "MIXED",
  ]),
  styleRefinement: z.string(),
  moodTags: z.array(z.string()).max(6),
  compositionNotes: z.string(),
  backgroundTone: z.enum(["LIGHT", "DARK", "BRAND_COLORED", "NO_PREFERENCE"]),
});

export type InstagramStyleSuggestion = z.infer<
  typeof InstagramStyleSuggestionSchema
>;

// Enum phrasing mirrors creative-prompt-builder.ts's PHOTOGRAPHY_STYLE_PHRASE
// / BACKGROUND_TONE_PHRASE dictionaries — same vocabulary the generation
// pipeline itself uses, so a value this def picks reads identically
// wherever it later shows up.
export const instagramStyleDef: ReasoningDef<InstagramStyleSuggestion> = {
  purpose: "brand.visualIdentity.fromInstagram",
  schema: InstagramStyleSuggestionSchema,
  // Rare, high-stakes call (user-initiated, feeds every future creative
  // generation for the brand) rather than a high-volume mechanical step —
  // same tier class as the other "critical synthesis" prompts.
  tier: "pro" as const,
  maxTokens: 2048,

  buildPrompt(context) {
    const captions = Array.isArray(context.captions)
      ? (context.captions as unknown[]).filter(
          (c): c is string => typeof c === "string" && c.length > 0,
        )
      : [];
    return {
      system: [
        "You are a senior creative director. You are given a set of Instagram post images from one account and must reverse-engineer the RECURRING visual design language across them, so it can be reused as a brand style guide for generating new, on-brand creatives.",
        "Describe what is CONSISTENT across the attached images, not what is unique to any single one. If the images genuinely don't share a consistent style, still make your best single-direction call rather than describing every image separately.",
        "",
        "primaryColors: the 1-3 dominant colors repeated across the set, as hex codes with a short descriptive name.",
        "secondaryColors: supporting colors that show up regularly alongside the primary ones. Empty array if none stand out.",
        "accentColors: small, deliberate pops of color used sparingly (e.g. a call-to-action color). Empty array if none.",
        "photographyStyle: pick exactly one — PHOTOGRAPHIC (camera-realistic photography), ILLUSTRATED (hand-drawn/artwork), THREE_D_RENDER (CGI/3D render look), FLAT_DESIGN (flat graphic shapes, no photographic realism), or MIXED.",
        'styleRefinement: 1-2 concrete sentences on lighting, texture, and editing style — specific, not generic adjectives like "nice" or "modern".',
        'moodTags: 2-6 short mood/aesthetic words (e.g. "premium", "playful", "editorial", "minimal").',
        "compositionNotes: 1 sentence on recurring framing/composition patterns you actually observe (e.g. rule-of-thirds, centered subject, generous negative space, tight crops).",
        "backgroundTone: LIGHT, DARK, BRAND_COLORED (backgrounds tinted toward the brand's own palette), or NO_PREFERENCE if backgrounds vary with no visible pattern.",
        "",
        "Base every field strictly on what you actually see in the attached images. Captions, if provided, are light supporting context only — never the primary signal, and never invent details not visible in the images.",
      ].join("\n"),
      user: [
        `${captions.length ? "Post captions" : "No captions were available"} (context only, may be truncated by Instagram itself):`,
        captions.length
          ? captions.map((c, i) => `${i + 1}. ${c}`).join("\n")
          : "(none)",
      ].join("\n"),
    };
  },

  buildMock(context) {
    const captions = Array.isArray(context.captions)
      ? (context.captions as unknown[]).length
      : 0;
    return {
      primaryColors: [{ hex: "#1F2937", name: "Mock charcoal" }],
      secondaryColors: [],
      accentColors: [],
      photographyStyle: "PHOTOGRAPHIC" as const,
      styleRefinement: `Mock style refinement derived from ${captions} caption(s).`,
      moodTags: ["mock"],
      compositionNotes: "Mock composition notes.",
      backgroundTone: "NO_PREFERENCE" as const,
    };
  },
};
