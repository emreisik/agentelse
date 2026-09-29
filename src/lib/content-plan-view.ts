import {
  resolvePlanItem,
  type ChannelConnections,
  type ChannelFormat,
  type ChannelKey,
  type PublishMode,
} from "@/lib/content-channels";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Pure view-model helpers for the plan card (kept out of the component so
// the week grid and the publish summary are unit-testable).

type PlanItem = Extract<
  IdeaEventCardData,
  { kind: "content-plan-draft" }
>["items"][number];

export type PlanViewItem = {
  // Position in the card's `items` (stable key, and what selection points at).
  index: number;
  date: string;
  time: string;
  topic: string;
  captionIdea: string;
  // Undefined for a platform outside the catalog (Facebook, YouTube...): the
  // card then shows the raw platform name instead of a channel badge.
  channel?: ChannelKey;
  format?: ChannelFormat;
  platform?: string;
  // Unknown (undefined) on plans drawn before connection status was stored.
  publish?: PublishMode;
};

// What actually happens to a piece once it is ready: an "auto" format only
// publishes by itself when its channel is connected; otherwise the client
// posts it. Ads always need an approval, blog articles are always manual.
export function effectivePublish(
  channel: ChannelKey,
  format: ChannelFormat,
  connections: ChannelConnections | undefined,
): PublishMode | undefined {
  if (format.publish !== "auto") return format.publish;
  if (!connections) return undefined;
  return connections[channel]?.connected ? "auto" : "manual";
}

export function toViewItems(
  items: readonly PlanItem[],
  connections: ChannelConnections | undefined,
): PlanViewItem[] {
  return items.map((item, index) => {
    const resolved = resolvePlanItem(item);
    return {
      index,
      date: item.date,
      time: item.time,
      topic: item.topic,
      captionIdea: item.captionIdea,
      channel: resolved?.channel,
      format: resolved?.format,
      platform: item.platform,
      publish: resolved
        ? effectivePublish(resolved.channel, resolved.format, connections)
        : undefined,
    };
  });
}

export function publishSummary(
  items: readonly PlanViewItem[],
): Record<PublishMode, number> {
  const counts: Record<PublishMode, number> = {
    auto: 0,
    manual: 0,
    approval: 0,
  };
  for (const item of items) {
    if (item.publish) counts[item.publish] += 1;
  }
  return counts;
}

// The distinct channels of a plan, in first-appearance order.
export function planChannels(items: readonly PlanViewItem[]): ChannelKey[] {
  const seen = new Set<ChannelKey>();
  for (const item of items) if (item.channel) seen.add(item.channel);
  return [...seen];
}

// --- Calendar arithmetic (Gregorian, no timezone: same approach as the
// calendar page — day keys are plain YYYY-MM-DD strings). ---

export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

// Monday of the week containing `dateKey` (Monday-first, like the calendar).
export function mondayOf(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const weekday = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
  return addDaysToKey(dateKey, -weekday);
}

export type PlanWeek = { start: string; days: string[] };

// Every Monday-first week from the first to the last item, empty weeks in
// between included so the pager never skips a stretch of the plan.
export function buildWeeks(items: readonly { date: string }[]): PlanWeek[] {
  if (items.length === 0) return [];
  const dates = items.map((item) => item.date).sort();
  const last = mondayOf(dates[dates.length - 1]!);
  const weeks: PlanWeek[] = [];
  for (
    let start = mondayOf(dates[0]!);
    start <= last;
    start = addDaysToKey(start, 7)
  ) {
    weeks.push({
      start,
      days: Array.from({ length: 7 }, (_, offset) =>
        addDaysToKey(start, offset),
      ),
    });
  }
  return weeks;
}
