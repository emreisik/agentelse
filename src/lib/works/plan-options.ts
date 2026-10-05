// Contracts of the plan directions card (Works slice 2, spec 2.2 and 3.2.3).
// Pure. The tool cleans model text before buildOptionsCard; nothing here
// judges text.

import { z } from "zod";

import { PLAN_GOALS, type ChannelKey } from "@/lib/content-channels";

import type { BrandCheckState } from "./brand-rules";
import { MAX_OPTION_SLOTS, OPTIONS_MAX, OPTIONS_MIN } from "./plan-layout";
import type { PlanSlot } from "./plan-layout";

export type PlanOptionSlot = {
  date: string;
  time: string;
  channel: string;
  formatKey: string;
};

export type PlanOptionId = "a" | "b" | "c";

export type PlanOption = {
  id: PlanOptionId;
  label: string;
  angle: string;
  // The one Brand Brain fact the angle rests on (provenance chip).
  basis?: string;
  // Aligned with the card's slots, same length.
  ideas: { topic: string; captionIdea: string }[];
};

export type PlanOptionsCardData = {
  kind: "content-plan-options";
  title: string;
  reason: string;
  timezone: string;
  state: "open" | "superseded";
  goal?: string;
  brandCheck?: BrandCheckState;
  slots: PlanOptionSlot[];
  options: PlanOption[];
  // The brief's social channels (each post goes to all of them) and its
  // Instagram Story choice, carried to the plan a pick makes (plan-layout.ts
  // briefDeliveries / deliveriesOfCard).
  platforms?: ChannelKey[];
  instagramStory?: boolean;
};

// No .transform anywhere: z.toJSONSchema must represent the tool schema.
export const PlanOptionsArgsSchema = z.object({
  title: z.string().min(1).max(80),
  goal: z.enum(PLAN_GOALS).optional(),
  reason: z.string().min(1).max(160),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        angle: z.string().min(1).max(200),
        basis: z.string().min(1).max(80).optional(),
        ideas: z
          .array(
            z.object({
              topic: z.string().min(1).max(120),
              captionIdea: z.string().min(1).max(200),
            }),
          )
          .min(1)
          .max(MAX_OPTION_SLOTS),
      }),
    )
    .min(OPTIONS_MIN)
    .max(OPTIONS_MAX),
});
export type PlanOptionsArgs = z.infer<typeof PlanOptionsArgsSchema>;

const OPTION_IDS: readonly PlanOptionId[] = ["a", "b", "c"];

// Model-readable: every option needs exactly one idea per fixed slot.
export function optionsShapeError(
  args: Pick<PlanOptionsArgs, "options">,
  slotCount: number,
): string | null {
  for (let i = 0; i < args.options.length; i++) {
    const option = args.options[i]!;
    if (option.ideas.length !== slotCount) {
      const name = option.label
        ? `"${option.label}"`
        : (OPTION_IDS[i] ?? `${i + 1}`);
      return `Option ${name} has ${option.ideas.length} ideas but there are ${slotCount} posts: every option needs exactly ${slotCount} ideas, one per numbered post, in order.`;
    }
  }
  return null;
}

export function buildOptionsCard({
  args,
  slots,
  timezone,
  brandCheck,
}: {
  args: PlanOptionsArgs;
  slots: readonly PlanSlot[];
  timezone: string;
  brandCheck?: BrandCheckState;
}): PlanOptionsCardData {
  const card: PlanOptionsCardData = {
    kind: "content-plan-options",
    title: args.title.trim(),
    reason: args.reason.trim(),
    timezone,
    state: "open",
    slots: slots.map((slot) => ({
      date: slot.date,
      time: slot.time,
      channel: slot.channel,
      formatKey: slot.formatKey,
    })),
    options: args.options.map((option, index) => {
      const built: PlanOption = {
        id: OPTION_IDS[index]!,
        label: option.label.trim(),
        angle: option.angle.trim(),
        ideas: option.ideas.map((idea) => ({
          topic: idea.topic.trim(),
          captionIdea: idea.captionIdea.trim(),
        })),
      };
      const basis = option.basis?.trim();
      if (basis) built.basis = basis;
      return built;
    }),
  };
  if (args.goal) card.goal = args.goal;
  if (brandCheck) card.brandCheck = brandCheck;
  return card;
}

export type OptionItem = PlanOptionSlot & {
  topic: string;
  captionIdea: string;
};

// The picked direction as plan items: slots x ideas. Null for an unknown
// option or a length mismatch (a corrupt card must not become a short plan).
export function optionItems(
  card: Pick<PlanOptionsCardData, "slots" | "options">,
  optionId: string,
): OptionItem[] | null {
  const option = card.options.find((o) => o.id === optionId);
  if (!option || option.ideas.length !== card.slots.length) return null;
  return card.slots.map((slot, index) => ({
    date: slot.date,
    time: slot.time,
    channel: slot.channel,
    formatKey: slot.formatKey,
    topic: option.ideas[index]!.topic,
    captionIdea: option.ideas[index]!.captionIdea,
  }));
}
