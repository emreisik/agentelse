import { z } from "zod";
import {
  CHANNELS,
  CHANNEL_KEYS,
  PLAN_GOALS,
  defaultFormat,
  isChannelKey,
  type ChannelKey,
} from "@/lib/content-channels";
import type { BrandCheckState } from "./brand-rules";
import { copyText } from "./copy";
import { channelNeedsConnection } from "./work";
import { integrationsHref } from "./starter-cards";

// Pure contracts of the master-content card (spec 3.9): one message, adapted
// per channel, then turned into a saved plan. No IO, so cards and the server
// share it.

export type MasterTarget = {
  channel: string;
  formatKey: string;
  included: boolean;
  adaptation?: { topic: string; captionIdea: string; issues?: string[] };
};

export type MasterContentCardData = {
  kind: "master-content";
  title: string;
  state: "draft" | "adapted" | "superseded";
  master: {
    title: string;
    message: string;
    cta?: string;
    goal?: string;
    ideaId?: string;
  };
  targets: MasterTarget[];
  adaptRuns?: number;
  adapting?: { startedAt: string };
  brandCheck?: BrandCheckState;
};

// No transforms: the schema must survive z.toJSONSchema for the tool list.
export const MasterContentArgsSchema = z.object({
  title: z.string().min(1).max(80),
  message: z.string().min(1).max(600),
  cta: z.string().max(80).optional(),
  goal: z.enum(PLAN_GOALS).optional(),
  channels: z.array(z.enum(CHANNEL_KEYS)).max(6).optional(),
});

export const MAX_ADAPT_RUNS = 3;
// An adaptation claim older than this no longer blocks a new run.
export const ADAPT_CLAIM_TTL_MS = 120_000;

const TOPIC_LIMIT = 120;

// Same 200 clip as plan ideas; X posts are short by nature so they get 240.
export function captionIdeaLimit(formatKey: string): number {
  return formatKey === "x.post" ? 240 : 200;
}

function clip(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : clean.slice(0, limit).trimEnd();
}

function targetFor(channel: ChannelKey, included: boolean): MasterTarget {
  return { channel, formatKey: defaultFormat(channel).key, included };
}

// Ads is a campaign brief that never goes live without an explicit approval,
// so it is only ever ticked by the person.
export function defaultTargets(
  workChannels: readonly ChannelKey[],
  include?: readonly ChannelKey[],
): MasterTarget[] {
  const keys = include ?? workChannels.filter((key) => key !== "ads");
  return keys.map((key) => targetFor(key, true));
}

export function buildMasterCard(
  args: {
    title: string;
    message: string;
    cta?: string;
    goal?: string;
    ideaId?: string;
    channels?: readonly ChannelKey[];
  },
  workChannels: readonly ChannelKey[],
  brandCheck?: BrandCheckState,
): MasterContentCardData {
  const master: MasterContentCardData["master"] = {
    title: args.title,
    message: args.message,
  };
  if (args.cta) master.cta = args.cta;
  if (args.goal) master.goal = args.goal;
  if (args.ideaId) master.ideaId = args.ideaId;
  const card: MasterContentCardData = {
    kind: "master-content",
    title: args.title,
    state: "draft",
    master,
    targets: args.channels?.length
      ? defaultTargets(workChannels, args.channels)
      : defaultTargets(workChannels),
  };
  if (brandCheck) card.brandCheck = brandCheck;
  return card;
}

// The channel the panel suggests a slot for: the first ticked connected social
// channel, else the first ticked one.
export function leadChannelOf(
  targets: readonly MasterTarget[],
  connected: ReadonlySet<string>,
): MasterTarget | undefined {
  const included = targets.filter((t) => t.included);
  return (
    included.find(
      (t) =>
        connected.has(t.channel) &&
        isChannelKey(t.channel) &&
        CHANNELS[t.channel].group === "social",
    ) ?? included[0]
  );
}

export type MasterChip = {
  key: ChannelKey;
  label: string;
  state: "included" | "excluded" | "outside" | "locked";
  connectHref?: string;
};

// Display override for the master card only: relabelling CHANNELS.seo would
// change strings elsewhere (plan card, wizard, calendar filter).
const MASTER_LABEL_OVERRIDE: Partial<Record<ChannelKey, string>> = {
  seo: copyText("master.chip.website"),
};

// Derived at render from live connection state; nothing is stored on the card.
export function chipStates(input: {
  targets: readonly MasterTarget[];
  workChannels: readonly { key: ChannelKey; connected: boolean }[];
  projectId: string;
}): MasterChip[] {
  const inWork = new Map(input.workChannels.map((c) => [c.key, c.connected]));
  return CHANNEL_KEYS.map((key) => {
    const label = MASTER_LABEL_OVERRIDE[key] ?? CHANNELS[key].label;
    if (!inWork.has(key)) return { key, label, state: "outside" };
    const included = input.targets.some(
      (t) => t.channel === key && t.included,
    );
    if (!included) return { key, label, state: "excluded" };
    if (channelNeedsConnection(key) && !inWork.get(key)) {
      return {
        key,
        label,
        state: "locked",
        connectHref: integrationsHref(input.projectId, key),
      };
    }
    return { key, label, state: "included" };
  });
}

export function fallbackAdaptation(
  master: { title: string; message: string },
  _channel: string,
  formatKey: string,
): { topic: string; captionIdea: string } {
  return {
    topic: clip(master.title, TOPIC_LIMIT),
    captionIdea: clip(master.message, captionIdeaLimit(formatKey)),
  };
}

// `slots` line up with the INCLUDED targets, in order.
export function toPlanItems(
  targets: readonly MasterTarget[],
  slots: readonly { date: string; time: string }[],
  master: { title: string; message: string },
): {
  date: string;
  time: string;
  channel: string;
  formatKey: string;
  topic: string;
  captionIdea: string;
}[] {
  const included = targets.filter((t) => t.included);
  const items: ReturnType<typeof toPlanItems> = [];
  included.forEach((target, i) => {
    const slot = slots[i];
    if (!slot) return;
    const text =
      target.adaptation ??
      fallbackAdaptation(master, target.channel, target.formatKey);
    items.push({
      date: slot.date,
      time: slot.time,
      channel: target.channel,
      formatKey: target.formatKey,
      topic: text.topic,
      captionIdea: text.captionIdea,
    });
  });
  return items;
}
