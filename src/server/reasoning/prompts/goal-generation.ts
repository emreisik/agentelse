import { z } from "zod";

import type { ReasoningDef } from "../types";

// priority is an ordinal rank (1 = highest), not a score — a model that
// answers on a 0-10/0-100 "priority score" convention instead (e.g. 90 for
// "very high priority") would crash the plain .min(1).max(5) bound; this
// clamps and rounds to the valid rank instead.
const zPriorityRank = () =>
  z
    .number()
    .transform((value) => Math.round(Math.min(5, Math.max(1, value))))
    .pipe(z.number().int().min(1).max(5));

export const GoalGenerationSchema = z.object({
  goals: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      metricKey: z.string(),
      priority: zPriorityRank(),
    }),
  ),
});

export type GoalGenerationOutput = z.infer<typeof GoalGenerationSchema>;

export const goalGenerationDef: ReasoningDef<GoalGenerationOutput> = {
  purpose: "goal.generate",
  schema: GoalGenerationSchema,
  maxTokens: 2048,

  buildPrompt(context) {
    return {
      system:
        "You propose measurable marketing goals for a brand from its research " +
        "findings and stated intent. 3-6 goals, each with a metricKey " +
        "(e.g. brand_awareness, registrations, organic_traffic, conversion_rate, " +
        "cpa, social_engagement, media_visibility). Priority 1 is highest.",
      user:
        `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
        `Client description: ${String(context.description ?? "-")}\n\n` +
        `Audit summaries:\n${JSON.stringify(context.audits ?? [], null, 2)}\n\n` +
        "Propose project goals.",
    };
  },

  buildMock(context) {
    const description = String(context.description ?? "").toLowerCase();
    const name = String(context.brandName ?? "brand");
    // Goals derive from what the client actually asked for in the intake
    // description; defaults fill up to four.
    const catalogue: Array<{ key: string; title: string; keywords: string[] }> =
      [
        {
          key: "brand_awareness",
          title: "Increase brand awareness",
          keywords: ["awareness", "brand"],
        },
        {
          key: "registrations",
          title: "Increase registrations",
          keywords: ["registration", "signup", "sign-up", "growth"],
        },
        {
          key: "organic_traffic",
          title: "Increase organic traffic",
          keywords: ["seo", "organic", "traffic"],
        },
        {
          key: "social_engagement",
          title: "Improve social engagement",
          keywords: ["social"],
        },
        {
          key: "conversion_rate",
          title: "Improve conversion rate",
          keywords: ["conversion"],
        },
        {
          key: "media_visibility",
          title: "Build media visibility",
          keywords: ["media", "pr", "press"],
        },
      ];
    const matched = catalogue.filter((g) =>
      g.keywords.some((k) => description.includes(k)),
    );
    const chosen = (
      matched.length >= 3 ? matched : catalogue.slice(0, 4)
    ).slice(0, 6);
    return {
      goals: chosen.map((g, i) => ({
        title: g.title,
        description: `${g.title} for ${name}, derived from intake and research`,
        metricKey: g.key,
        priority: Math.min(5, i + 1),
      })),
    };
  },
};
