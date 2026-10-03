import "server-only";

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
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Read-time overlays of the Work page (spec 3.14 and 7). The stored cards are
// snapshots; the records are the truth, and nothing here is persisted.

export type ScheduledIdea = { date: string; time: string; channel: string };

export type WorkOverlayInputs = {
  live: LiveInputs;
  liveRows: Map<string, LiveCreativeRow>;
  // Idea id -> where it stands on the calendar right now.
  scheduledIdeas: Map<string, ScheduledIdea>;
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
  return {
    live,
    liveRows,
    scheduledIdeas: collectScheduledIdeas(cards, liveRows, live.timezone),
  };
}

export function applyWorkOverlays(
  card: IdeaEventCardData | undefined,
  inputs: WorkOverlayInputs,
  context?: { isNewestCreativeCard?: boolean },
): IdeaEventCardData | undefined {
  if (!card) return card;
  switch (card.kind) {
    case "creative-ready":
      return withLiveCreativeState(card, inputs.liveRows, inputs.live, {
        isNewestCard: context?.isNewestCreativeCard,
      });
    case "content-plan-draft":
      return withLivePlan(card, inputs.live, inputs.liveRows);
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
