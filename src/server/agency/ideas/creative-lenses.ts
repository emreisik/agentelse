import type { CouncilType, CreativeLens } from "@prisma/client";

// The idea-diversity mechanism (spec sections 19-20): each lens forces a
// genuinely different angle. Pure module.

export type LensDefinition = {
  lens: CreativeLens;
  promptHint: string;
  defaultCouncil: CouncilType;
};

export const LENS_DEFINITIONS: Record<CreativeLens, LensDefinition> = {
  BRAND: { lens: "BRAND", promptHint: "brand-building, positioning-led response", defaultCouncil: "STRATEGY" },
  CULTURE: { lens: "CULTURE", promptHint: "cultural moment / zeitgeist participation", defaultCouncil: "CREATIVE" },
  PR: { lens: "PR", promptHint: "earned-media story angle journalists would cover", defaultCouncil: "MEDIA" },
  SOCIAL: { lens: "SOCIAL", promptHint: "native social content or format play", defaultCouncil: "CREATIVE" },
  PRODUCT: { lens: "PRODUCT", promptHint: "product/feature/merchandising response", defaultCouncil: "STRATEGY" },
  GROWTH: { lens: "GROWTH", promptHint: "measurable growth experiment or funnel play", defaultCouncil: "GROWTH" },
  PARTNERSHIP: { lens: "PARTNERSHIP", promptHint: "co-marketing or partner activation", defaultCouncil: "STRATEGY" },
  CREATOR: { lens: "CREATOR", promptHint: "creator/influencer collaboration", defaultCouncil: "MEDIA" },
  MEDIA: { lens: "MEDIA", promptHint: "paid or owned media concept", defaultCouncil: "MEDIA" },
  COMMUNITY: { lens: "COMMUNITY", promptHint: "community/UGC/participation mechanic", defaultCouncil: "CREATIVE" },
  TECHNOLOGY: { lens: "TECHNOLOGY", promptHint: "tech-enabled experience or tool", defaultCouncil: "GROWTH" },
  EXPERIENCE: { lens: "EXPERIENCE", promptHint: "live or interactive experience", defaultCouncil: "CREATIVE" },
  OFFLINE: { lens: "OFFLINE", promptHint: "out-of-home or physical-world concept", defaultCouncil: "MEDIA" },
  CONTENT: { lens: "CONTENT", promptHint: "editorial/long-form content series", defaultCouncil: "CREATIVE" },
  UTILITY: { lens: "UTILITY", promptHint: "useful tool or service the audience keeps", defaultCouncil: "GROWTH" },
  DATA: { lens: "DATA", promptHint: "data-story or research-led asset", defaultCouncil: "STRATEGY" },
};

export const ALL_LENSES = Object.keys(LENS_DEFINITIONS) as CreativeLens[];

// Default lens spread for a generation pass: a diverse, non-social-only mix.
export const DEFAULT_LENS_MIX: CreativeLens[] = [
  "BRAND",
  "PR",
  "SOCIAL",
  "GROWTH",
  "CREATOR",
  "CONTENT",
];
