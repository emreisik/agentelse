import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  CHANNELS,
  CHANNEL_KEYS,
  PLAN_GOALS,
  legacyToFormat,
  resolveFormat,
  type ChannelConnections,
} from "@/lib/content-channels";
import { CHAT_PLATFORMS } from "@/server/reasoning/prompts/chat-turn";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Conversation-driven content planning: the model drafts the plan itself (in
// the propose_content_plan tool arguments — one structured output, no extra
// model call), the client reviews it as a card, and "Save plan" stores it as
// dated DRAFT creatives on the calendar. Shared here by the tool and the
// save action so both apply the same rules.

export type ContentPlanCard = Extract<
  IdeaEventCardData,
  { kind: "content-plan-draft" }
>;

// Four weeks at seven posts a week (the wizard's ceiling).
export const MAX_PLAN_ITEMS = 30;
// A plan further out than this is almost certainly a date the model got
// wrong (wrong year/month), not something the client meant.
export const MAX_PLAN_HORIZON_DAYS = 60;
const DEFAULT_TIME = "10:00";
const DEFAULT_TIMEZONE = "Europe/Istanbul";

// `channel` + `formatKey` (src/lib/content-channels.ts) say WHERE and IN WHAT
// SHAPE. `platform` + free-text `format` are the pre-channel shape, still
// accepted so older tool calls and saved plans keep working; buildPlanCard
// normalizes both to the same card.
export const PlanItemSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    channel: z.enum(CHANNEL_KEYS).optional(),
    formatKey: z.string().optional(),
    platform: z.enum(CHAT_PLATFORMS).optional(),
    format: z.string().optional(),
    topic: z.string().min(1),
    captionIdea: z.string().min(1),
  })
  .refine((item) => (item.channel && item.formatKey) || item.platform, {
    message: "Each item needs `channel` and `formatKey` (or a legacy `platform`).",
  });

export const ContentPlanArgsSchema = z.object({
  title: z.string().min(1),
  goal: z.enum(PLAN_GOALS).optional(),
  items: z.array(PlanItemSchema).min(1).max(MAX_PLAN_ITEMS),
});

// Same convention as the content calendar and the publish queue: the
// Instagram publishing schedule's timezone, Europe/Istanbul when unset.
export async function getProjectTimezone(projectId: string): Promise<string> {
  const schedule = await prisma.projectSchedule.findFirst({
    where: { projectId, capability: "INSTAGRAM_PUBLISH" },
    select: { timezone: true },
  });
  return schedule?.timezone ?? DEFAULT_TIMEZONE;
}

export function todayInTimezone(timezone: string, now = new Date()): string {
  return dayKeyInTimezone(now, timezone);
}

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function isRealDate(dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m! - 1 &&
    date.getUTCDate() === d
  );
}

// Returns a message the MODEL can act on (it gets it as the tool result and
// re-proposes), or null when every slot is acceptable.
export function validatePlanDates(
  items: readonly { date: string }[],
  today: string,
): string | null {
  const last = addDays(today, MAX_PLAN_HORIZON_DAYS);
  for (const item of items) {
    if (!isRealDate(item.date)) {
      return `"${item.date}" is not a real calendar date.`;
    }
    if (item.date < today) {
      return `${item.date} is in the past (today is ${today}). Use dates from today onward.`;
    }
    if (item.date > last) {
      return `${item.date} is more than ${MAX_PLAN_HORIZON_DAYS} days away (today is ${today}). Check the year/month.`;
    }
  }
  return null;
}

// The model picked a `formatKey` that does not belong to its `channel`
// (e.g. "instagram.thread"): hand it back the valid keys so it can fix it.
export function validatePlanChannels(
  items: readonly { channel?: string; formatKey?: string }[],
): string | null {
  for (const item of items) {
    if (!item.channel || !item.formatKey) continue;
    const channel = CHANNELS[item.channel as keyof typeof CHANNELS];
    if (!channel || !resolveFormat(channel.key, item.formatKey)) {
      const valid = channel?.formats.map((format) => format.key).join(", ");
      return `"${item.formatKey}" is not a format of ${item.channel}. Valid formatKey values for it: ${valid ?? "none"}.`;
    }
  }
  return null;
}

export function buildPlanCard(
  args: z.infer<typeof ContentPlanArgsSchema>,
  timezone: string,
  connections?: ChannelConnections,
): ContentPlanCard {
  const items = args.items
    .map((item) => {
      const legacy =
        !item.channel && item.platform
          ? legacyToFormat(item.platform, item.format)
          : undefined;
      const channel = item.channel ?? legacy?.channel;
      const formatKey = item.channel ? item.formatKey : legacy?.format.key;
      return {
        date: item.date,
        time: item.time ?? DEFAULT_TIME,
        platform: channel ? CHANNELS[channel].platform : item.platform,
        // Only what a legacy call sent: catalog plans read `formatKey`.
        format: item.channel ? undefined : item.format?.trim() || undefined,
        channel,
        formatKey,
        topic: item.topic.trim(),
        captionIdea: item.captionIdea.trim(),
      };
    })
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
  return {
    kind: "content-plan-draft",
    title: args.title.trim(),
    timezone,
    state: "draft",
    goal: args.goal,
    connections,
    items,
  };
}

// A new proposal replaces the previous open one: only ONE draft per project
// can be saved, so revising a plan ("make Tuesday a reel") never leaves an
// older card whose Save button would create duplicate calendar entries.
export async function supersedeOpenDrafts(
  projectId: string,
  exceptCommandId: string,
): Promise<void> {
  const commands = await prisma.command.findMany({
    where: {
      projectId,
      id: { not: exceptCommandId },
      parsedIntent: { path: ["card", "kind"], equals: "content-plan-draft" },
    },
    select: { id: true, parsedIntent: true },
  });
  for (const command of commands) {
    const intent = command.parsedIntent as {
      card?: { state?: string };
    } | null;
    if (intent?.card?.state !== "draft") continue;
    await prisma.command.update({
      where: { id: command.id },
      data: {
        parsedIntent: {
          ...intent,
          card: { ...intent.card, state: "superseded" },
        } as never,
      },
    });
  }
}
