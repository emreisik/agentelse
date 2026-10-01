// Contracts of the idea options card (Works slice 2, spec 2.2 and 3.4.7). Pure.

import { z } from "zod";

import type { BrandCheckState } from "./brand-rules";

export const MAX_IDEAS_PER_CARD = 3;

const TOPIC_MAX = 120;
const CAPTION_MAX = 300;

export type IdeaOptionItem = {
  ideaId: string;
  title: string;
  description: string;
};

export type IdeaOptionsCardData = {
  kind: "idea-options";
  title: string;
  reason: string;
  // The quiet "Checked against N brand rules" line; absent on older cards.
  brandCheck?: BrandCheckState;
  // Server ids: the model never handles them.
  items: IdeaOptionItem[];
  // Live read-time overlay, never stored.
  scheduled?: Record<string, { date: string; time: string; channel: string }>;
};

// propose_ideas schema. No transforms: z.toJSONSchema must represent it.
export const IdeaOptionsArgsSchema = z
  .object({
    title: z.string().min(1).max(80),
    reason: z.string().min(1).max(140).optional(),
    ideas: z
      .array(
        z.object({
          title: z.string().min(1).max(120),
          description: z.string().min(1).max(600),
        }),
      )
      .min(0)
      .max(MAX_IDEAS_PER_CARD),
    includeBacklog: z.boolean().optional(),
  })
  .refine((args) => args.ideas.length > 0 || args.includeBacklog === true, {
    message: "Give at least one idea or set includeBacklog.",
  });
export type IdeaOptionsArgs = z.infer<typeof IdeaOptionsArgsSchema>;

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? chars.slice(0, max).join("").trim() : flat;
}

// What an idea becomes as a plan slot. The caller cleans both strings with
// cleanWorksText: this only shapes them.
export function ideaTargetFields(idea: {
  title: string;
  description: string;
  concept?: unknown;
}): { topic: string; captionIdea: string } {
  let sketch: string | null = null;
  const concept = idea.concept;
  if (concept && typeof concept === "object") {
    const value = (concept as Record<string, unknown>).executionSketch;
    if (typeof value === "string" && value.trim()) sketch = value;
  }
  return {
    topic: oneLine(idea.title, TOPIC_MAX),
    captionIdea: oneLine(sketch ?? idea.description, CAPTION_MAX),
  };
}
