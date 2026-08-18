import { z } from "zod";

import type { ReasoningDef } from "../types";

export const SignalProfileRecommendationSchema = z.object({
  profiles: z.array(
    z.object({
      category: z.string(),
      intensity: z.enum(["VERY_HIGH", "HIGH", "MEDIUM", "LOW", "OFF"]),
      rationale: z.string(),
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
    // department-recommendation.ts'teki MAX_TOKENS kesilmesiyle aynı risk
    // şekli (16 kategori × rationale metni, "thinking" token'ları da aynı
    // bütçeden düşüyor) — önleyici olarak aynı şekilde yükseltildi.
    maxTokens: 8192,

    buildPrompt(context) {
      return {
        system:
          "You configure which external signal categories an AI agency should " +
          "monitor for a brand, and how intensely. Categories: " +
          `${JSON.stringify(context.categories ?? [])}. ` +
          "A marketplace tracks competitors/product launches VERY_HIGH; a local " +
          "service business may keep events LOW and offline MEDIUM. Never set " +
          "everything to VERY_HIGH — intensity must reflect the business.",
        user:
          `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
          "Recommend an intensity for every category.",
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
        })),
      };
    },
  };
