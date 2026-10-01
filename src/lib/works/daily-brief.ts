import {
  CHANNELS,
  CHANNEL_KEYS,
  type ChannelConnections,
  type ChannelKey,
} from "@/lib/content-channels";
import { STAGE_LABEL } from "@/lib/content-plan-view";
import type { NextStep, PlanItemStage } from "@/lib/journey";
import { serializePlanBrief } from "@/lib/plan-brief";
import type { CardAction } from "@/lib/works/card-action";
import { copyText } from "@/lib/works/copy";
import { defaultPlanBrief, layoutPlanSlots } from "@/lib/works/plan-layout";
import { slotWhenLabel } from "@/lib/works/slot-rules";
import { channelListText } from "@/lib/works/work";

// The Today Work's daily brief (spec 3.11.2). Pure and isomorphic: the page
// gathers real rows, this decides what the card shows. The result IS the card
// data: the brief is live (recomputed on every render) and never stored.
// Nothing is invented: only counts of real rows and the step's own label.

export type BriefAction =
  | CardAction
  | { kind: "next"; step: NextStep }
  | { kind: "open-channel-work"; channel: ChannelKey };

export type BriefRowGroup =
  "content" | "seo" | "ads" | "connect" | "ideas" | "channel";

export type BriefRow = {
  id: string;
  group: BriefRowGroup;
  title: string;
  stage?: PlanItemStage;
  // STAGE_LABEL[stage]: the brief must not invent its own status words.
  statusLabel?: string;
  channel?: ChannelKey;
  actionLabel: string;
  action: BriefAction;
};

export type DailyBrief = {
  kind: "daily-brief";
  day: string;
  heading: string;
  summary: string;
  rows: BriefRow[];
  // Rows cut by MAX_BRIEF_ROWS.
  more: number;
  // The top next step as its OWN row, with its own label and cost.
  next?: { title: string; label: string; costNote?: string; step: NextStep };
  // Always a plan-brief send or the connect link, never a next step.
  primary: { label: string; action: BriefAction };
  secondary?: { label: string; action: BriefAction };
  focus?: string;
  yesterday?: { published: number; failed: number };
};

export type BriefFacts = {
  today: string;
  // 'HH:mm' in the project timezone (decides Plan today vs Plan the week).
  nowLocalTime: string;
  projectId: string;
  connections: ChannelConnections;
  hasAnalytics: boolean;
  todayItems: {
    id: string;
    title: string;
    channel?: ChannelKey;
    stage: PlanItemStage;
    formatKey?: string;
    planId?: string;
  }[];
  nextSteps: readonly NextStep[];
  // The page computes it (produceCostNote) for a produce_plan step.
  nextStepCostNote?: string;
  yesterdayPublished: number;
  yesterdayFailed: number;
  goalTitle?: string;
  shortlistedIdeas: number;
  channelsWithoutWork: readonly ChannelKey[];
};

export const MAX_BRIEF_ROWS = 6;

const PERFORMANCE_QUESTION = "How is our performance lately?";
const GROUP_ORDER = { content: 0, seo: 1, ads: 2 } as const;

function integrationsLink(projectId: string): string {
  return `/projects/${projectId}/integrations`;
}

// Social channels are the ones the agency can publish to.
function connectedPublishingChannels(
  connections: ChannelConnections,
): ChannelKey[] {
  return CHANNEL_KEYS.filter(
    (key) => CHANNELS[key].group === "social" && connections[key]?.connected,
  );
}

function itemGroup(channel: ChannelKey | undefined): "content" | "seo" | "ads" {
  const group = channel ? CHANNELS[channel].group : "social";
  return group === "social" ? "content" : group;
}

// The starter's message: a friendly first line, then the machine brief line.
// Null when no brief can be built (the caller falls back to a plain sentence).
function planMessage(
  channels: readonly ChannelKey[],
  today: string,
): { text: string; startsToday: (nowLocalTime: string) => boolean } | null {
  const brief = defaultPlanBrief({ channels, today, start: today });
  if (!brief) return null;
  const machine = serializePlanBrief(brief).split("\n")[1];
  if (!machine) return null;
  const when = slotWhenLabel(brief.start, "").split(",")[0] ?? brief.start;
  return {
    text: `${copyText("starter.planWeek.visible", { when })}\n${machine}`,
    // The anchor rule of plan-layout: the plan really starts today only when a
    // time still fits.
    startsToday: (nowLocalTime) =>
      layoutPlanSlots({ brief, today, nowLocalTime })[0]?.date === today,
  };
}

function buildPrimary(facts: BriefFacts, connected: readonly ChannelKey[]) {
  if (connected.length === 0) {
    return {
      label: copyText("brief.connectFirst"),
      action: {
        kind: "link",
        href: integrationsLink(facts.projectId),
      } satisfies BriefAction,
    };
  }
  // The website is planned too, but only once something is connected.
  const message = planMessage([...connected, "seo"], facts.today);
  if (!message) {
    return {
      label: copyText("brief.planWeek"),
      action: {
        kind: "send",
        text: `Plan the week for ${channelListText(connected)}.`,
      } satisfies BriefAction,
    };
  }
  return {
    label: message.startsToday(facts.nowLocalTime)
      ? copyText("brief.plan")
      : copyText("brief.planWeek"),
    action: { kind: "send", text: message.text } satisfies BriefAction,
  };
}

export function buildDailyBrief(facts: BriefFacts): DailyBrief {
  const connected = connectedPublishingChannels(facts.connections);

  // Published items last; the sort is stable, so the page's order is kept
  // within a group.
  const items = facts.todayItems
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const published =
        Number(a.item.stage === "PUBLISHED") -
        Number(b.item.stage === "PUBLISHED");
      if (published !== 0) return published;
      const group =
        GROUP_ORDER[itemGroup(a.item.channel)] -
        GROUP_ORDER[itemGroup(b.item.channel)];
      return group !== 0 ? group : a.index - b.index;
    })
    .map(({ item }) => item);

  const itemRows: BriefRow[] = items.map((item) => ({
    id: `item-${item.id}`,
    group: itemGroup(item.channel),
    title: item.title,
    stage: item.stage,
    statusLabel: STAGE_LABEL[item.stage],
    channel: item.channel,
    // Production is not started from a row: it lives in the next row.
    actionLabel:
      item.stage === "IN_REVIEW"
        ? copyText("brief.rowReview")
        : copyText("brief.rowOpen"),
    action: {
      kind: "link",
      href: `/projects/${facts.projectId}/takvim?creative=${encodeURIComponent(item.id)}`,
    },
  }));

  const extraRows: BriefRow[] = [];
  if (connected.length === 0) {
    extraRows.push({
      id: "connect",
      group: "connect",
      title: copyText("brief.connectRow"),
      actionLabel: copyText("brief.connectAction"),
      action: { kind: "link", href: integrationsLink(facts.projectId) },
    });
  }
  if (facts.shortlistedIdeas > 0) {
    extraRows.push({
      id: "ideas",
      group: "ideas",
      title: copyText("brief.ideasRow", { n: facts.shortlistedIdeas }),
      actionLabel: copyText("brief.rowOpen"),
      action: { kind: "link", href: `/projects/${facts.projectId}/fikirler` },
    });
  }
  for (const channel of facts.channelsWithoutWork) {
    extraRows.push({
      id: `channel-${channel}`,
      group: "channel",
      title: copyText("brief.channelRow", { channel: CHANNELS[channel].label }),
      channel,
      actionLabel: copyText("brief.startAction"),
      action: { kind: "open-channel-work", channel },
    });
  }

  const allRows = [...itemRows, ...extraRows];
  const rows = allRows.slice(0, MAX_BRIEF_ROWS);

  const top = facts.nextSteps[0];
  const costNote = facts.nextStepCostNote?.trim() || undefined;
  const next = top
    ? {
        title: top.title,
        label: top.label,
        ...(costNote ? { costNote } : {}),
        step: top,
      }
    : undefined;

  const open =
    itemRows.filter((row) => row.stage !== "PUBLISHED").length +
    extraRows.length +
    (next ? 1 : 0);
  const summary =
    open === 0
      ? copyText("brief.summary.none")
      : open === 1
        ? copyText("brief.summary.one")
        : copyText("brief.summary.some", { n: open });

  const secondary: DailyBrief["secondary"] = facts.hasAnalytics
    ? {
        label: copyText("brief.performance"),
        action: { kind: "send", text: PERFORMANCE_QUESTION },
      }
    : {
        label: copyText("brief.connectAnalytics"),
        action: { kind: "link", href: integrationsLink(facts.projectId) },
      };

  const focus = facts.goalTitle?.trim();
  const clamp = (n: number) =>
    Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

  return {
    kind: "daily-brief",
    day: facts.today,
    heading: copyText("brief.heading"),
    summary,
    rows,
    more: allRows.length - rows.length,
    ...(next ? { next } : {}),
    primary: buildPrimary(facts, connected),
    secondary,
    ...(focus ? { focus } : {}),
    yesterday: {
      published: clamp(facts.yesterdayPublished),
      failed: clamp(facts.yesterdayFailed),
    },
  };
}
