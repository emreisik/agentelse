import { z } from "zod";

import {
  CHANNELS,
  CHANNEL_KEYS,
  PLAN_GOALS,
  PLAN_GOAL_LABEL,
  channelOfFormatKey,
  resolveFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { isSocialPlatform } from "@/lib/works/plan-platforms";

// What the plan wizard collects, and how it travels: the wizard sends an
// ordinary chat message (readable line + one machine line), the agent reads
// the machine line, and propose_content_plan checks its own plan against the
// same parsed brief. One shared parser means the model cannot drift from what
// the client actually picked.

export const MAX_BRIEF_WEEKS = 4;
export const MAX_BRIEF_PER_WEEK = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARKER_RE = /^\[Plan brief\] (.+)$/m;

export const PlanBriefSchema = z.object({
  goal: z.enum(PLAN_GOALS),
  channels: z
    .array(
      z.object({
        channel: z.enum(CHANNEL_KEYS),
        // Full catalog keys ("instagram.reel"), all belonging to `channel`.
        formats: z.array(z.string()).min(1),
      }),
    )
    .min(1),
  // "+ Story": each Instagram post also goes out as a Story made from its
  // picture (the plan card's instagramStory). Only kept with Instagram among
  // the channels; absent = off.
  story: z.boolean().optional(),
  perWeek: z.number().int().min(1).max(MAX_BRIEF_PER_WEEK),
  weeks: z.number().int().min(1).max(MAX_BRIEF_WEEKS),
  start: z.string().regex(DATE_RE),
  theme: z.string().trim().max(200).optional(),
});
export type PlanBrief = z.infer<typeof PlanBriefSchema>;

// What is known before the wizard opens (the New Chat module start reads it
// from the client's own words): each field preselects its step.
export type PlanBriefPrefill = {
  channels?: readonly ChannelKey[];
  story?: boolean;
  perWeek?: number;
  weeks?: number;
  topic?: string;
};

// What a brief's slots rotate through, in brief order. A post is general
// (docs/works.md "Posts"): it goes to every social channel of the brief (the
// plan's platforms), so the social channels share ONE place, drawn on the
// first of them with its formats. Blog/SEO and Ads are not posts: each of
// their formats keeps a place of its own.
export function briefRotation(
  channels: PlanBrief["channels"],
): { channel: ChannelKey; formatKey: string }[] {
  let posts = false;
  return channels.flatMap(({ channel, formats }) => {
    if (isSocialPlatform(channel)) {
      if (posts) return [];
      posts = true;
    }
    return formats.map((formatKey) => ({ channel, formatKey }));
  });
}

// The brief's channels its plan gives nothing at all, because perWeek x weeks
// is smaller than what the slots rotate through. Any post reaches every social
// channel.
export function channelsLeftOut(
  brief: Pick<PlanBrief, "channels" | "perWeek" | "weeks">,
): ChannelKey[] {
  const reached = briefRotation(brief.channels).slice(
    0,
    totalBriefItems(brief),
  );
  const posted = reached.some(({ channel }) => isSocialPlatform(channel));
  const used = new Set(reached.map(({ channel }) => channel));
  return brief.channels
    .map(({ channel }) => channel)
    .filter((channel) =>
      isSocialPlatform(channel) ? !posted : !used.has(channel),
    );
}

// The Story switch only means something with Instagram among the channels.
function storyOn(brief: Pick<PlanBrief, "story" | "channels">): boolean {
  return (
    brief.story === true &&
    brief.channels.some(({ channel }) => channel === "instagram")
  );
}

function briefIsConsistent(brief: PlanBrief): boolean {
  const seen = new Set<ChannelKey>();
  for (const { channel, formats } of brief.channels) {
    if (seen.has(channel)) return false;
    seen.add(channel);
    if (!formats.every((key) => resolveFormat(channel, key))) return false;
  }
  return true;
}

export function totalBriefItems(brief: Pick<PlanBrief, "perWeek" | "weeks">) {
  return brief.perWeek * brief.weeks;
}

// "instagram:carousel+reel,seo:article" — the format keys drop their channel
// prefix here (it is already in front of the colon).
function encodeChannels(channels: PlanBrief["channels"]): string {
  return channels
    .map(
      ({ channel, formats }) =>
        `${channel}:${formats.map((key) => key.slice(channel.length + 1)).join("+")}`,
    )
    .join(",");
}

function decodeChannels(value: string): PlanBrief["channels"] | null {
  const result: PlanBrief["channels"] = [];
  for (const part of value.split(",")) {
    const [channel, formats] = part.split(":");
    if (!channel || !formats) return null;
    result.push({
      channel: channel as ChannelKey,
      formats: formats.split("+").map((suffix) => `${channel}.${suffix}`),
    });
  }
  return result;
}

// The chat message the wizard sends: a plain sentence a human (and the
// conversation history) can read, then the machine line the agent and the
// tool validation parse. The bubble hides the machine line
// (stripPlanBriefMarker).
export function serializePlanBrief(brief: PlanBrief): string {
  const story = storyOn(brief);
  const channels = brief.channels
    .map(({ channel, formats }) => {
      const labels = formats
        .map((key) => resolveFormat(channel, key)?.label ?? key)
        .join(", ");
      const extra = channel === "instagram" && story ? " + Story" : "";
      return `${CHANNELS[channel].label} (${labels})${extra}`;
    })
    .join("; ");
  const sentence = [
    `Plan my content. Goal: ${PLAN_GOAL_LABEL[brief.goal].label}.`,
    `Channels: ${channels}.`,
    `${brief.perWeek} per week for ${brief.weeks} week${brief.weeks === 1 ? "" : "s"}, starting ${brief.start}.`,
    // One line: a line break in the theme would start a line of its own (the
    // machine line keeps the exact text).
    brief.theme ? `Theme: ${brief.theme.replace(/\s+/g, " ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const fields = [
    `goal=${brief.goal}`,
    `channels=${encodeChannels(brief.channels)}`,
    story ? "story=1" : "",
    `perWeek=${brief.perWeek}`,
    `weeks=${brief.weeks}`,
    `start=${brief.start}`,
    brief.theme ? `theme=${encodeURIComponent(brief.theme)}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `${sentence}\n[Plan brief] ${fields}`;
}

// Null when the message carries no (valid) brief line.
export function parsePlanBrief(message: string): PlanBrief | null {
  const line = MARKER_RE.exec(message)?.[1];
  if (!line) return null;
  const fields = new Map<string, string>();
  for (const part of line.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    fields.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  const channels = decodeChannels(fields.get("channels") ?? "");
  if (!channels) return null;
  let theme: string | undefined;
  try {
    const raw = fields.get("theme");
    theme = raw ? decodeURIComponent(raw) : undefined;
  } catch {
    return null;
  }
  const parsed = PlanBriefSchema.safeParse({
    goal: fields.get("goal"),
    channels,
    ...(fields.get("story") === "1" ? { story: true } : {}),
    perWeek: Number(fields.get("perWeek")),
    weeks: Number(fields.get("weeks")),
    start: fields.get("start"),
    theme,
  });
  if (!parsed.success || !briefIsConsistent(parsed.data)) return null;
  const brief = parsed.data;
  if (brief.story && !storyOn(brief)) delete brief.story;
  return brief;
}

// The visible part of a wizard message (what the bubble shows).
export function stripPlanBriefMarker(message: string): string {
  return message.replace(/\n?\[Plan brief\] .+$/m, "").trimEnd();
}

// A wizard message: it carries the machine line stripPlanBriefMarker hides
// (such a message is not edited as text, its brief would be lost).
export function hasPlanBriefMarker(message: string): boolean {
  return /\[Plan brief\] .+$/m.test(message);
}

type PlanItemLike = { date: string; channel?: string; formatKey?: string };

// A message the MODEL can act on (handed back as the tool result so it
// re-proposes), or null when the plan honours the brief.
export function validatePlanAgainstBrief(
  items: readonly PlanItemLike[],
  brief: PlanBrief,
): string | null {
  const allowed = new Map(
    brief.channels.map(({ channel, formats }) => [channel, new Set(formats)]),
  );
  const max = totalBriefItems(brief);
  if (items.length > max) {
    return `The client asked for ${brief.perWeek} per week for ${brief.weeks} week(s) = at most ${max} items; the plan has ${items.length}.`;
  }
  for (const item of items) {
    const channel = item.channel;
    if (!channel || !item.formatKey) {
      return "Every item needs `channel` and `formatKey` from the client's brief.";
    }
    const formats = allowed.get(channel as ChannelKey);
    if (!formats) {
      return `Channel "${channel}" is not in the client's brief (${[...allowed.keys()].join(", ")}). Use only those.`;
    }
    if (!formats.has(item.formatKey)) {
      return `Format "${item.formatKey}" was not chosen for ${channel}; the client picked: ${[...formats].join(", ")}.`;
    }
    if (item.date < brief.start) {
      return `${item.date} is before the client's start date ${brief.start}.`;
    }
  }
  // Covering every channel is only possible when the total allows it (the
  // wizard warns when it does not). A post goes to every social channel of
  // the brief (the plan's platforms), so any social item covers them all;
  // Blog/SEO and Ads each need an item of their own.
  const places = [
    ...new Set(briefRotation(brief.channels).map(({ channel }) => channel)),
  ];
  if (max >= places.length) {
    const usedChannels = new Set(items.map((item) => item.channel));
    const posted = items.some((item) => isSocialPlatform(item.channel));
    const missing = places.filter((channel) =>
      isSocialPlatform(channel) ? !posted : !usedChannels.has(channel),
    );
    if (missing.length > 0) {
      return `The brief includes ${missing.join(", ")} but the plan has no item for it. Cover every chosen channel.`;
    }
  }
  return null;
}

export function isFormatOfChannel(
  channel: ChannelKey,
  formatKey: string,
): boolean {
  return (
    channelOfFormatKey(formatKey) === channel &&
    !!resolveFormat(channel, formatKey)
  );
}
