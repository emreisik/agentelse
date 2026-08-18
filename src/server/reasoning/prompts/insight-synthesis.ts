import { z } from "zod";

import type { ReasoningDef } from "../types";

export const InsightSynthesisSchema = z.object({
  insights: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      importance: z.number().min(0).max(100),
      relatedIndexes: z.array(z.number()),
    }),
  ),
});

export type InsightSynthesisOutput = z.infer<typeof InsightSynthesisSchema>;

export const insightSynthesisDef: ReasoningDef<InsightSynthesisOutput> = {
  purpose: "insight.synthesize",
  schema: InsightSynthesisSchema,
  maxTokens: 4096,

  buildPrompt(context) {
    return {
      system:
        "You are the intelligence analyst of an AI agency. Combine promoted " +
        "signals and research findings into a small number of decision-relevant " +
        "insights. An insight explains what is happening and why the brand " +
        "should care. relatedIndexes refers to the 0-based index of the inputs " +
        "each insight draws on. Do not manufacture insights from thin evidence.",
      user:
        `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
        `Inputs (signals/findings):\n${JSON.stringify(context.items ?? [], null, 2)}\n\n` +
        "Synthesize at most 5 insights.",
    };
  },

  buildMock(context) {
    const items = (context.items ?? []) as Array<{ title?: string; statement?: string; category?: string }>;
    // Group inputs by category; one mock insight per non-empty category group.
    const groups = new Map<string, number[]>();
    items.forEach((item, idx) => {
      const key = item.category ?? "general";
      const list = groups.get(key) ?? [];
      list.push(idx);
      groups.set(key, list);
    });
    const insights = [...groups.entries()].slice(0, 5).map(([category, indexes]) => {
      const first = items[indexes[0] ?? 0];
      const label = first?.title ?? first?.statement ?? category;
      return {
        title: `Insight: ${label}`.slice(0, 120),
        summary: `Derived from ${indexes.length} input(s) in category "${category}": ${label}`,
        importance: Math.min(90, 50 + indexes.length * 10),
        relatedIndexes: indexes,
      };
    });
    return { insights };
  },
};
