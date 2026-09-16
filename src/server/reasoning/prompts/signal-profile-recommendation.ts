import { z } from "zod";

import type { ReasoningDef } from "../types";
import { zLenientArray } from "../lenient-array";

export const SignalProfileRecommendationSchema = z.object({
  profiles: zLenientArray(
    z.object({
      category: z.string(),
      intensity: z.enum(["VERY_HIGH", "HIGH", "MEDIUM", "LOW", "OFF"]),
      rationale: z.string(),
      // Concrete, checkable sources for THIS category (a competitor domain,
      // an RSS/feed URL, a subreddit, a hashtag, a review site) — without
      // this, signal-universe.ts's scan request has nothing to point the
      // scanning agent at beyond the bare category name. Optional: OFF
      // categories and ones the model can't ground in anything real should
      // omit it rather than invent a plausible-looking URL.
      sources: z.array(z.string()).optional(),
    }),
  ),
});

export type SignalProfileRecommendationOutput = z.infer<
  typeof SignalProfileRecommendationSchema
>;

export const signalProfileRecommendationDef: ReasoningDef<SignalProfileRecommendationOutput> =
  {
    purpose: "signal-profile.recommend",
    schema: SignalProfileRecommendationSchema,
    // Same shape of risk as the MAX_TOKENS truncation in
    // department-recommendation.ts (16 categories x rationale text,
    // "thinking" tokens also deduct from the same budget) — raised
    // preemptively in the same way.
    maxTokens: 8192,

    buildPrompt(context) {
      return {
        system:
          "You configure which external signal categories an AI agency should " +
          "monitor for a brand, and how intensely. Categories: " +
          `${JSON.stringify(context.categories ?? [])}. ` +
          "A marketplace tracks competitors/product launches VERY_HIGH; a local " +
          "service business may keep events LOW and offline MEDIUM. Never set " +
          "everything to VERY_HIGH — intensity must reflect the business. " +
          "For every category above OFF, also name 2-5 concrete, real sources " +
          "the scanning agent should actually check — a named competitor's " +
          "domain, a specific RSS/blog feed, a subreddit, a hashtag, a review " +
          "site, a marketplace category page. Ground every source in the brand " +
          "context below (named competitors, products, industry) — never " +
          "invent a URL or handle you cannot justify from it. Omit `sources` " +
          "entirely for a category where nothing in the brand context grounds " +
          "a real one; a shorter, honest list beats a plausible-looking guess.",
        user:
          `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
          "Recommend an intensity, and where possible real sources, for every category.",
      };
    },

    buildMock(context) {
      const categories = (context.categories ?? []) as string[];
      const brandText = JSON.stringify(context.brand ?? {}).toLowerCase();
      // Simple deterministic heuristic: competitor & market always HIGH+,
      // categories mentioned in brand context get bumped, tail categories LOW.
      const bump = (cat: string): "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" => {
        if (cat === "COMPETITOR" || cat === "PRODUCT_LAUNCH")
          return "VERY_HIGH";
        if (cat === "MARKET" || cat === "SEO" || cat === "SOCIAL_TREND")
          return "HIGH";
        if (brandText.includes(cat.toLowerCase().replace("_", " ")))
          return "HIGH";
        if (cat === "EVENT" || cat === "OFFLINE") return "LOW";
        return "MEDIUM";
      };
      return {
        profiles: categories.map((category) => ({
          category,
          intensity: bump(category),
          rationale: `Mock intensity for ${category} from brand context heuristics`,
          // No real brand context to ground a source in during mock mode —
          // matches the real prompt's instruction to omit rather than
          // fabricate one.
          sources: [],
        })),
      };
    },
  };
