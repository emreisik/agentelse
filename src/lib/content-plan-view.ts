import {
  resolvePlanItem,
  type ChannelConnections,
  type ChannelFormat,
  type ChannelKey,
  type PublishMode,
} from "@/lib/content-channels";
import type { PlanItemStage } from "@/lib/journey";
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
  // Where the saved slot stands right now (card.slots); absent before saving.
  slot?: { id: string; stage: PlanItemStage; assetId?: string };
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
  slots?: readonly (PlanViewItem["slot"] | null)[],
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
      slot: slots?.[index] ?? undefined,
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

// --- Progress of a saved plan ---

// Plain-language stage names shown on the card.
export const STAGE_LABEL: Record<PlanItemStage, string> = {
  PLANNED: "Needs content",
  PRODUCING: "Being made",
  FAILED: "Could not be made",
  IN_REVIEW: "Waiting for your decision",
  REJECTED: "Declined",
  APPROVED: "Approved",
  PUBLISHED: "Published",
};

export function countStages(
  items: readonly Pick<PlanViewItem, "slot">[],
): Record<PlanItemStage, number> {
  const counts: Record<PlanItemStage, number> = {
    PLANNED: 0,
    PRODUCING: 0,
    FAILED: 0,
    IN_REVIEW: 0,
    REJECTED: 0,
    APPROVED: 0,
    PUBLISHED: 0,
  };
  for (const item of items) if (item.slot) counts[item.slot.stage] += 1;
  return counts;
}

const SUMMARY_PART: [PlanItemStage, (n: number) => string][] = [
  ["PRODUCING", (n) => `${n} being made`],
  ["FAILED", (n) => `${n} failed`],
  ["IN_REVIEW", (n) => `${n} in review`],
  ["PLANNED", (n) => `${n} need content`],
  ["APPROVED", (n) => `${n} approved`],
  ["REJECTED", (n) => `${n} declined`],
  ["PUBLISHED", (n) => `${n} published`],
];

// "3 in review · 4 need content": the one line under a saved plan.
export function stageSummary(
  items: readonly Pick<PlanViewItem, "slot">[],
): string {
  const counts = countStages(items);
  return SUMMARY_PART.filter(([stage]) => counts[stage] > 0)
    .map(([stage, text]) => text(counts[stage]))
    .join(" · ");
}
