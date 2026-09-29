import type { ImageGenState } from "@/lib/image-progress";
import type { ChatStreamEvent } from "@/server/chat/types";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Pure state logic for a content-package run in the chat: one optimistic
// "item" message per ticked deliverable, driven by the tagged item.* events of
// POST /api/projects/[id]/chat/package. Kept apart from project-chat.tsx so it
// can be unit-tested without React.

// The slice of a local chat turn that an item message uses.
export type ItemTurnFields = {
  state: "pending" | "done" | "error";
  reply?: string;
  card?: IdeaEventCardData;
  // The persisted chat row behind the finished card (item.done).
  commandId?: string;
  previewUrl?: string;
  imageGen?: ImageGenState;
  // Set once the item's task exists (item.start).
  taskId?: string;
  itemId?: string;
  itemTitle?: string;
  // The owning department, for the running card's badge.
  department?: string;
};

// Image items start their live progress block on click (imageGen); text items
// get the same "running" card the persisted pipeline row shows, as soon as
// their task exists.
export function reduceItemEvent<T extends ItemTurnFields>(
  turn: T,
  event: ChatStreamEvent,
): T {
  if (
    !("itemId" in event) ||
    turn.itemId === undefined ||
    event.itemId !== turn.itemId
  ) {
    return turn;
  }
  switch (event.type) {
    case "item.start":
      return {
        ...turn,
        taskId: event.taskId,
        card: turn.imageGen
          ? turn.card
          : {
              kind: "task-running",
              taskId: event.taskId,
              title: turn.itemTitle ?? "Working",
              department: turn.department,
            },
      };
    case "item.partial":
      return {
        ...turn,
        previewUrl: event.dataUrl,
        imageGen: {
          startedAt: turn.imageGen?.startedAt ?? Date.now(),
          partials: Math.max(turn.imageGen?.partials ?? 0, event.index + 1),
          done: false,
        },
      };
    case "item.done":
      return {
        ...turn,
        state: event.ok ? "done" : "error",
        reply: event.reply,
        card: event.card,
        commandId: event.commandId,
        previewUrl: undefined,
        imageGen: undefined,
      };
    default:
      return turn;
  }
}

// A stream-level failure (claim refused, network drop): every item of the run
// still waiting is settled with the message instead of spinning forever.
// `inRun` scopes it to one run's items — two packages can reuse item ids.
export function failPendingItems<T extends ItemTurnFields>(
  turns: readonly T[],
  inRun: (turn: T) => boolean,
  message: string,
): T[] {
  return turns.map((turn) =>
    turn.state === "pending" && turn.itemId !== undefined && inRun(turn)
      ? {
          ...turn,
          state: "error" as const,
          reply: message,
          card: undefined,
          previewUrl: undefined,
          imageGen: undefined,
        }
      : turn,
  );
}

export function taskIdOfCard(card: IdeaEventCardData | undefined): string | undefined {
  if (!card || !("taskId" in card)) return undefined;
  return typeof card.taskId === "string" ? card.taskId : undefined;
}

// The card kinds a task's chat row ends on (the "creative-loading" /
// "task-running" ones are the in-progress states of the same row).
const FINAL_TASK_CARD_KINDS: ReadonlySet<string> = new Set([
  "creative-ready",
  "creative-failed",
  "task-result",
]);

export function isFinalTaskCard(card: IdeaEventCardData | undefined): boolean {
  return card !== undefined && FINAL_TASK_CARD_KINDS.has(card.kind);
}

// The chat shows an item from exactly one place at a time, and the persisted
// row wins only once it is FINAL: while it is still "running" the live local
// message stays (and the running row is hidden); once the row is final the
// local copy is dropped.
export function finalTaskIds(
  cards: Iterable<IdeaEventCardData | undefined>,
): Set<string> {
  const ids = new Set<string>();
  for (const card of cards) {
    const taskId = isFinalTaskCard(card) ? taskIdOfCard(card) : undefined;
    if (taskId) ids.add(taskId);
  }
  return ids;
}

export function localItemTaskIds(local: readonly ItemTurnFields[]): Set<string> {
  const ids = new Set<string>();
  for (const turn of local) {
    if (turn.itemId !== undefined && turn.taskId) ids.add(turn.taskId);
  }
  return ids;
}

// The in-progress states of a task's persisted chat row.
const IN_PROGRESS_TASK_CARD_KINDS: ReadonlySet<string> = new Set([
  "creative-loading",
  "task-running",
]);

// A persisted, still-in-progress row of a task that has a live local message.
export function isServerRowHidden(
  card: IdeaEventCardData | undefined,
  localTaskIds: ReadonlySet<string>,
): boolean {
  const taskId = taskIdOfCard(card);
  return (
    taskId !== undefined &&
    localTaskIds.has(taskId) &&
    IN_PROGRESS_TASK_CARD_KINDS.has(card!.kind)
  );
}

export function isLocalItemSuperseded(
  turn: ItemTurnFields,
  finalServerTaskIds: ReadonlySet<string>,
): boolean {
  return (
    turn.itemId !== undefined &&
    turn.taskId !== undefined &&
    finalServerTaskIds.has(turn.taskId)
  );
}

// How often the chat pulls the page while a package piece is being made
// without a live stream driving it (reload, dropped connection), how long an
// in-progress row counts as real work rather than a stale leftover, and how
// long a just-started package is given to show its first rows.
export const PROGRESS_POLL_MS = 6_000;
const IN_PROGRESS_ROW_MAX_AGE_MS = 10 * 60_000;
const FRESH_START_MAX_AGE_MS = 2 * 60_000;
// The rows are stamped by the database, the start by the app server.
const CLOCK_SKEW_MS = 5_000;

type PollableTurn = {
  source: string;
  createdAt: string;
  card?: IdeaEventCardData;
};

// Whether the persisted chat still has package work in flight that nothing
// live is showing: a fresh "generating"/"running" row, or a package that was
// just started but has fewer task rows than items so far (the running row is
// only posted once the job actually starts, a moment after the click).
export function needsProgressPoll(
  turns: readonly PollableTurn[],
  now: number,
): boolean {
  if (
    turns.some(
      (turn) =>
        (turn.card?.kind === "creative-loading" ||
          turn.card?.kind === "task-running") &&
        now - Date.parse(turn.createdAt) < IN_PROGRESS_ROW_MAX_AGE_MS,
    )
  ) {
    return true;
  }

  return turns.some((turn) => {
    const card = turn.card;
    if (card?.kind !== "content-package" || card.state !== "started") {
      return false;
    }
    const startedAt = card.startedAt ? Date.parse(card.startedAt) : NaN;
    if (Number.isNaN(startedAt) || now - startedAt > FRESH_START_MAX_AGE_MS) {
      return false;
    }
    const rows = turns.filter(
      (other) =>
        other.source === "SYSTEM" &&
        taskIdOfCard(other.card) !== undefined &&
        Date.parse(other.createdAt) >= startedAt - CLOCK_SKEW_MS,
    ).length;
    return rows < (card.startedCount ?? card.items.length);
  });
}
