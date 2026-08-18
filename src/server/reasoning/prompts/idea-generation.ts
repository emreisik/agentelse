import { z } from "zod";

import type { ReasoningDef } from "../types";

export const IdeaGenerationSchema = z.object({
  ideas: z.array(
    z.object({
      lens: z.string(),
      title: z.string(),
      description: z.string(),
      concept: z.object({
        bigIdea: z.string(),
        executionSketch: z.string(),
        departmentsInvolved: z.array(z.string()),
      }),
    }),
  ),
});

export type IdeaGenerationOutput = z.infer<typeof IdeaGenerationSchema>;

export const ideaGenerationDef: ReasoningDef<IdeaGenerationOutput> = {
  purpose: "idea.generate",
  schema: IdeaGenerationSchema,
  // Fikir üretimi en yüksek hacimli adım (fırsat başına birden çok lens)
  // ve mekanik: en ucuz kademe yeterli.
  tier: "lite" as const,
  maxTokens: 4096,

  buildPrompt(context) {
    return {
      system:
        "You are the Idea Foundry of an AI agency. Given an opportunity, " +
        "generate genuinely diverse campaign/action ideas — one per requested " +
        "creative lens. Never default to 'create a social post'; think across " +
        "PR stories, partnerships, experiences, product drops, creator " +
        "collaborations, landing pages, editorial series, growth experiments. " +
        "Each idea must name the departments needed to execute it.",
      user:
        `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
        `Opportunity:\n${JSON.stringify(context.opportunity ?? {}, null, 2)}\n\n` +
        `Requested lenses: ${JSON.stringify(context.lenses ?? [])}\n\n` +
        "Generate one distinct idea per lens.",
    };
  },

  buildMock(context) {
    const opportunity = (context.opportunity ?? {}) as { title?: string };
    const lenses = (context.lenses ?? ["BRAND"]) as string[];
    const base = opportunity.title ?? "opportunity";
    // Department mix varies by lens so multi-department plans emerge naturally.
    const lensDepartments: Record<string, string[]> = {
      BRAND: ["BRAND_STRATEGY", "CREATIVE"],
      CULTURE: ["CREATIVE", "SOCIAL_MEDIA"],
      PR: ["PR_MEDIA", "COPY_CONTENT"],
      SOCIAL: ["SOCIAL_MEDIA", "CREATIVE", "COPY_CONTENT"],
      PRODUCT: ["WEB_PRODUCT", "COPY_CONTENT"],
      GROWTH: ["GROWTH", "PERFORMANCE_MARKETING", "DATA_ANALYTICS"],
      PARTNERSHIP: ["PARTNERSHIPS", "BRAND_STRATEGY"],
      CREATOR: ["INFLUENCER_CREATOR", "SOCIAL_MEDIA"],
      MEDIA: ["PR_MEDIA", "PERFORMANCE_MARKETING"],
      COMMUNITY: ["SOCIAL_MEDIA", "CRM_LIFECYCLE"],
      TECHNOLOGY: ["WEB_PRODUCT", "DATA_ANALYTICS"],
      EXPERIENCE: ["EVENTS", "CREATIVE"],
      OFFLINE: ["OFFLINE_MEDIA", "CREATIVE"],
      CONTENT: ["COPY_CONTENT", "SEO"],
      UTILITY: ["WEB_PRODUCT", "GROWTH"],
      DATA: ["DATA_ANALYTICS", "GROWTH"],
    };
    return {
      ideas: lenses.map((lens) => ({
        lens,
        title: `${lens} idea for: ${base}`.slice(0, 140),
        description: `A ${lens.toLowerCase()}-lens response to "${base}" derived from the opportunity context.`,
        concept: {
          bigIdea: `${lens} angle on ${base}`,
          executionSketch: `Execute via ${lens.toLowerCase()} channels responding to ${base}`,
          departmentsInvolved: lensDepartments[lens] ?? ["CREATIVE"],
        },
      })),
    };
  },
};
