import { z } from "zod";

import type { ReasoningDef } from "../types";
import { zColorSwatches } from "./instagram-style";

// Interprets the FACTS a site scan extracted (candidate colours with weights
// and sources, fonts, page copy) plus the actual logo and a hero image, and
// proposes a brand visual identity. Colours are constrained to the extracted
// candidates — the model chooses and names roles, it does not invent hexes
// (callers additionally snap/validate them, see scan.ts).
export const BrandSiteScanSchema = z.object({
  primaryColors: zColorSwatches(3),
  secondaryColors: zColorSwatches(3),
  accentColors: zColorSwatches(2),
  photographyStyle: z
    .enum(["PHOTOGRAPHIC", "ILLUSTRATED", "THREE_D_RENDER", "FLAT_DESIGN", "MIXED"])
    .catch("MIXED"),
  styleRefinement: z.string(),
  moodTags: z
    .array(z.string())
    .transform((tags) => tags.slice(0, 6))
    .pipe(z.array(z.string())),
  compositionNotes: z.string(),
  backgroundTone: z
    .enum(["LIGHT", "DARK", "BRAND_COLORED", "NO_PREFERENCE"])
    .catch("NO_PREFERENCE"),
  alwaysAvoid: z
    .array(z.string())
    .transform((items) => items.slice(0, 5))
    .pipe(z.array(z.string())),
});

export type BrandSiteScanSuggestion = z.infer<typeof BrandSiteScanSchema>;

export const brandSiteScanDef: ReasoningDef<BrandSiteScanSuggestion> = {
  purpose: "brand.visualIdentity.fromWebsite",
  schema: BrandSiteScanSchema,
  // Rare, user-initiated, and it seeds every future creative for the brand.
  tier: "pro" as const,
  maxTokens: 2048,

  buildPrompt(context) {
    return {
      system: [
        "You are a senior brand designer. You are given facts extracted from a company's own website (colour candidates with weights and where they were found, fonts, page title and description) and, when available, images attached in this order: the brand's LOGO, then a hero / social image from the site.",
        "Your job: reverse-engineer the brand's visual identity so it can drive on-brand social creatives.",
        "",
        "COLOURS — choose ONLY from the candidate hex codes provided; never invent a hex. Prefer colours that appear in the logo, in theme-color, or in brand-named CSS variables. primaryColors: the 1-2 colours that carry the identity (usually the logo colours). secondaryColors: supporting colours used regularly. accentColors: a sparing call-to-action / highlight colour. A colour must not appear in two roles. Leave a role empty rather than forcing a weak candidate.",
        "photographyStyle: exactly one of PHOTOGRAPHIC, ILLUSTRATED, THREE_D_RENDER, FLAT_DESIGN, MIXED — judged from the attached images and the site's character.",
        "styleRefinement: 1-2 concrete sentences on lighting, texture and editing style that would suit this brand's imagery — specific, not generic adjectives.",
        "moodTags: 2-6 short mood words that reflect the brand's actual positioning (from the copy and imagery).",
        "compositionNotes: 1 sentence on framing / negative-space habits that fit the identity.",
        "backgroundTone: LIGHT, DARK, BRAND_COLORED or NO_PREFERENCE, based on the site and logo.",
        "alwaysAvoid: up to 5 short things a designer should keep OUT of this brand's imagery (e.g. clichés that clash with its positioning). Base them on the brand's sector and tone; do not invent facts about the company.",
        "",
        "Ground every field in the provided facts and images. If the data is thin, say less rather than guessing.",
      ].join("\n"),
      user: [
        `Site: ${String(context.siteName ?? context.title ?? "(unknown)")}`,
        `Description: ${String(context.description ?? "(none)")}`,
        `Language: ${String(context.pageLanguage ?? "(unknown)")}`,
        "",
        "Colour candidates (hex, weight, sources):",
        JSON.stringify(context.colorCandidates ?? []),
        "Neutral colours seen (background / text):",
        JSON.stringify(context.neutrals ?? []),
        "Fonts seen:",
        JSON.stringify(context.fonts ?? []),
        `Attached images: ${String(context.attachedImages ?? "none")}`,
      ].join("\n"),
    };
  },

  buildMock(context) {
    const candidates = Array.isArray(context.colorCandidates)
      ? (context.colorCandidates as { hex: string }[])
      : [];
    const pick = (i: number) =>
      candidates[i] ? [{ hex: candidates[i]!.hex, name: `Mock ${i + 1}` }] : [];
    return {
      primaryColors: pick(0),
      secondaryColors: pick(1),
      accentColors: pick(2),
      photographyStyle: "PHOTOGRAPHIC" as const,
      styleRefinement: "Mock style refinement derived from the site facts.",
      moodTags: ["mock"],
      compositionNotes: "Mock composition notes.",
      backgroundTone: "NO_PREFERENCE" as const,
      alwaysAvoid: [],
    };
  },
};
