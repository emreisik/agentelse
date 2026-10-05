import "server-only";

import type { CreativeStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import {
  loadLiveCreativeRows,
  loadLiveInputs,
  withLiveCreativeState,
  withLivePlan,
  type LiveCreativeRow,
  type LiveInputs,
} from "@/server/agency/journey/live-creative-state";
import { deriveItemStage } from "@/server/agency/journey/plan-progress";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Read-time overlays of the Work page (spec 3.14 and 7). The stored cards are
// snapshots; the records are the truth, and nothing here is persisted.

export type ScheduledIdea = { date: string; time: string; channel: string };

export type WorkOverlayInputs = {
  live: LiveInputs;
  liveRows: Map<string, LiveCreativeRow>;
  // Idea id -> where it stands on the calendar right now.
  scheduledIdeas: Map<string, ScheduledIdea>;
  // Post id -> the channels of its deliveries that are not left out, for the
  // posts of the creative cards on screen (docs/works.md "Posts").
  postChannels: Map<string, string[]>;
};

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

// A slot in one of these states no longer holds the idea's place.
const DEAD_SLOT_STATUSES: ReadonlySet<string> = new Set([
  "ARCHIVED",
  "REJECTED",
]);

// A Task of the Work counts as "working" only when it moved recently: a dead
// worker or an abandoned task must not keep the header lit forever.
const ACTIVE_TASK_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING_PROVIDER",
  "VERIFYING",
] as const;
const ACTIVITY_WINDOW_MS = 30 * 60_000;

const DEFAULT_TIMEZONE = "Europe/Istanbul";

function isSavedPlan(card: IdeaEventCardData | undefined): card is PlanCard {
  return (
    card?.kind === "content-plan-draft" &&
    card.state === "saved" &&
    Array.isArray(card.savedCreativeIds)
  );
}

// An idea counts as scheduled only while one of its slot Creatives is alive:
// the stored plan card never learns that a slot was archived, removed or moved,
// so trusting it left a stale chip that hid "Plan it" for good. Key = idea id;
// the first live slot wins, and its time is the Creative's own.
export function collectScheduledIdeas(
  cards: readonly (IdeaEventCardData | undefined)[],
  liveRows: ReadonlyMap<string, LiveCreativeRow>,
  timezone: string = DEFAULT_TIMEZONE,
): Map<string, ScheduledIdea> {
  const scheduled = new Map<string, ScheduledIdea>();
  for (const card of cards) {
    if (!isSavedPlan(card)) continue;
    const ids = card.savedCreativeIds ?? [];
    card.items.forEach((item, index) => {
      const origin = item.origin;
      if (origin?.kind !== "idea" || item.removed) return;
      if (scheduled.has(origin.ref)) return;
      const id = ids[index];
      const row = id ? liveRows.get(id) : undefined;
      if (!row || DEAD_SLOT_STATUSES.has(row.status)) return;
      let date = item.date;
      let time = item.time;
      if (row.scheduledFor) {
        const [liveDate, liveTime] = utcToZonedDateTimeLocal(
          row.scheduledFor,
          timezone,
        ).split("T");
        if (liveDate && liveTime) {
          date = liveDate;
          time = liveTime;
        }
      }
      scheduled.set(origin.ref, {
        date,
        time,
        channel: item.channel ?? row.channel ?? "",
      });
    });
  }
  return scheduled;
}

// The channels of each post's deliveries that are not left out: the same set
// the server checks before a Facebook share (facebook-share.ts). Never throws:
// without it a card keeps offering the share and the server still refuses a
// second Facebook post.
export async function loadPostChannels(
  projectId: string,
  postIds: readonly string[],
): Promise<Map<string, string[]>> {
  const channels = new Map<string, string[]>();
  if (postIds.length === 0) return channels;
  try {
    const deliveries = await prisma.creative.findMany({
      where: { projectId, postId: { in: [...new Set(postIds)] } },
      select: { id: true, postId: true, channel: true, excludedAt: true },
    });
    for (const delivery of deliveries) {
      if (!delivery.postId || !delivery.channel || delivery.excludedAt) {
        continue;
      }
      const own = channels.get(delivery.postId) ?? [];
      if (!own.includes(delivery.channel)) own.push(delivery.channel);
      channels.set(delivery.postId, own);
    }
  } catch {
    return new Map();
  }
  return channels;
}

export async function loadWorkOverlayInputs(
  projectId: string,
  cards: readonly (IdeaEventCardData | undefined)[],
): Promise<WorkOverlayInputs> {
  const ids = new Set<string>();
  for (const card of cards) {
    if (card?.kind === "creative-ready") ids.add(card.creativeId);
    else if (isSavedPlan(card)) {
      // Every slot: the pane shows each piece's text and time, an idea's chip
      // its day.
      for (const id of card.savedCreativeIds ?? []) ids.add(id);
    }
  }
  const [live, liveRows] = await Promise.all([
    loadLiveInputs(projectId),
    loadLiveCreativeRows(projectId, [...ids]),
  ]);
  // Only a creative card offers a Facebook share of its own.
  const postIds = cards.flatMap((card) => {
    if (card?.kind !== "creative-ready") return [];
    const postId = liveRows.get(card.creativeId)?.postId;
    return postId ? [postId] : [];
  });
  return {
    live,
    liveRows,
    scheduledIdeas: collectScheduledIdeas(cards, liveRows, live.timezone),
    postChannels: await loadPostChannels(projectId, postIds),
  };
}

// A channel left out of its post stays a tab of that post (faded, with
// "Include"), but the journey reads only the channels left in, so its slot
// arrives empty. Its own row brings it back; withLivePlan then marks it
// excluded. Only beside a delivery of the same post that is on screen: an
// orphan, or a plan whose journey could not be read, shows nothing new.
export function withLeftOutSlots(
  card: IdeaEventCardData,
  rows: ReadonlyMap<string, LiveCreativeRow>,
): IdeaEventCardData {
  if (!isSavedPlan(card) || !card.slots?.includes(null)) return card;
  const ids = card.savedCreativeIds ?? [];
  const postsOnScreen = new Set(
    card.slots.flatMap((slot) => {
      const postId = slot ? rows.get(slot.id)?.postId : undefined;
      return postId ? [postId] : [];
    }),
  );
  let revived = false;
  const slots = card.slots.map((slot, index) => {
    if (slot) return slot;
    const id = ids[index];
    const row = id ? rows.get(id) : undefined;
    if (!row?.excludedAt || !row.postId || !postsOnScreen.has(row.postId)) {
      return slot;
    }
    // Never made or retried once left out: no task decides its stage.
    const stage = deriveItemStage(
      {
        status: row.status as CreativeStatus,
        currentVersionId: row.version ? row.id : null,
      },
      [],
    );
    if (!stage) return slot;
    revived = true;
    const assetId = row.version?.assetId;
    return { id: row.id, stage, ...(assetId ? { assetId } : {}) };
  });
  return revived ? { ...card, slots } : card;
}

export function applyWorkOverlays(
  card: IdeaEventCardData | undefined,
  inputs: WorkOverlayInputs,
  context?: { isNewestCreativeCard?: boolean },
): IdeaEventCardData | undefined {
  if (!card) return card;
  switch (card.kind) {
    case "creative-ready": {
      const next = withLiveCreativeState(card, inputs.liveRows, inputs.live, {
        isNewestCard: context?.isNewestCreativeCard,
      });
      // An older card of a revised piece stays exactly as the page left it.
      if (next === card || next.kind !== "creative-ready") return next;
      const postId = inputs.liveRows.get(card.creativeId)?.postId;
      const postChannels = postId ? inputs.postChannels.get(postId) : undefined;
      return {
        ...next,
        ...(postId ? { postId } : {}),
        ...(postChannels ? { postChannels } : {}),
      };
    }
    case "content-plan-draft":
      return withLivePlan(
        withLeftOutSlots(card, inputs.liveRows),
        inputs.live,
        inputs.liveRows,
      );
    case "idea-options": {
      const scheduled: Record<string, ScheduledIdea> = {};
      for (const item of card.items) {
        const info = inputs.scheduledIdeas.get(item.ideaId);
        if (info) scheduled[item.ideaId] = info;
      }
      if (Object.keys(scheduled).length === 0 && card.scheduled === undefined) {
        return card;
      }
      return { ...card, scheduled };
    }
    default:
      return card;
  }
}

export async function loadWorkActivity(
  projectId: string,
  workId: string,
): Promise<{ working: boolean }> {
  try {
    const count = await prisma.task.count({
      where: {
        projectId,
        command: { workId },
        status: { in: [...ACTIVE_TASK_STATUSES] },
        updatedAt: { gte: new Date(Date.now() - ACTIVITY_WINDOW_MS) },
      },
    });
    return { working: count > 0 };
  } catch {
    return { working: false };
  }
}
