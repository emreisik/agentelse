import "server-only";

import type {
  CapabilityKey,
  DepartmentKey,
  SocialPlatform,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  isIdeaEventCardData,
  type IdeaEventCardData,
} from "@/types/idea-event-card";
import { TaskPlanner } from "@/server/commands/task-planner";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { subscribeCreativeProgress } from "@/server/media/creative-progress";
import { isAgentelseError } from "@/server/security/errors";
import { isWorksEnabled } from "@/server/works/flag";

import { updateCommandCard } from "./card-store";

import { driveJobInline } from "./inline-job";
import type { ChatStreamEvent } from "./types";

// The part of a live production run that does not care WHAT is being produced:
// one piece becomes a Task for its department (TaskPlanner, the entry the
// scheduler uses — no chat bubble per item) that is driven inline instead of
// waiting for a worker tick, exactly like generate_image does (driveJobInline:
// the job's dispatch event is taken first, so the worker never runs the same
// job a second time), streaming tagged item.* events the chat turns into one
// live message per piece. Shared by the content-package run (content-package-
// run.ts, pieces ticked on a card) and the content-plan run (plan-run.ts,
// pieces of a saved plan's calendar).

export type ProductionSpec = {
  // Id the client keys the piece's live message by (package item id, or the
  // plan slot's Creative id).
  itemId: string;
  title: string;
  // Plain-language name used in messages ("Instagram post").
  label: string;
  department: DepartmentKey;
  capability: CapabilityKey;
  targetPlatform?: SocialPlatform;
  // The worker's brief.
  request: string;
  // Extra task payload: an image piece's format and quality, a plan slot's
  // `planCreativeId` (see plan-creative-link.ts).
  payloadExtra?: Record<string, unknown>;
  // Prefix of the error log line ("[content-package] seo_article").
  logPrefix: string;
};

export type ProductionContext = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  // The Command row the tasks keep their lineage on (the package or the plan).
  commandId: string;
  // How long to look for the final card of a job another process ran.
  finalCardPolls?: FinalCardPolls;
};

export type ItemOutcome = { itemId: string; planned: boolean; ok: boolean };

// Read-modify-write of a run card's stored fields (the package or plan card on
// its Command row). Only the run itself writes a claimed card, so there is no
// concurrent writer to lose to.
export async function patchCommandCard(
  commandId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (isWorksEnabled()) {
    // Works: swap/pick write the same row, so go through the atomic writer.
    const head = await prisma.command.findUnique({
      where: { id: commandId },
      select: { projectId: true, parsedIntent: true },
    });
    const headIntent = head?.parsedIntent as {
      card?: Record<string, unknown>;
    } | null;
    if (!head?.projectId || !headIntent?.card) return;
    // updateCommandCard retries a write conflict itself; if it still loses
    // (swap/move kept hitting the same row), try the whole write once more and
    // then throw so the caller's catch logs it. Silently dropping the patch
    // would leave production.state "running" until the claim expires.
    // NOT_FOUND / WRONG_KIND mean the card is gone or replaced: nothing to
    // patch, as in the legacy branch below.
    for (let attempt = 1; ; attempt += 1) {
      const result = await updateCommandCard({
        commandId,
        projectId: head.projectId,
        update: (card) => ({ ...card, ...patch }) as typeof card,
      });
      if (result.ok || result.code !== "CONFLICT") return;
      if (attempt >= 2) {
        throw new Error(`card patch lost a write conflict: ${result.message}`);
      }
    }
  }
  const row = await prisma.command.findUnique({
    where: { id: commandId },
    select: { parsedIntent: true },
  });
  const intent = row?.parsedIntent as {
    card?: Record<string, unknown>;
  } | null;
  if (!intent?.card) return;
  await prisma.command.update({
    where: { id: commandId },
    data: {
      parsedIntent: { ...intent, card: { ...intent.card, ...patch } } as never,
    },
  });
}

// The chat row a task's card lives on (written by the execution pipeline:
// "creative-loading" / "task-running" at start, resolved in place to
// "creative-ready" / "creative-failed" / "task-result" at the end).
async function loadTaskCard(projectId: string, taskId: string) {
  const row = await prisma.command.findFirst({
    where: {
      projectId,
      source: "SYSTEM",
      parsedIntent: { path: ["card", "taskId"], equals: taskId },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, replyText: true, parsedIntent: true },
  });
  const card = (row?.parsedIntent as { card?: unknown } | null)?.card;
  if (!row || !isIdeaEventCardData(card)) return null;
  return { commandId: row.id, reply: row.replyText ?? "", card };
}

const FINAL_CARD_KINDS: ReadonlySet<string> = new Set([
  "creative-ready",
  "creative-failed",
  "task-result",
]);

export type FinalCardPolls = { tries: number; everyMs: number };
const DEFAULT_FINAL_CARD_POLLS: FinalCardPolls = { tries: 5, everyMs: 1000 };

// The job is COMPLETED, but when another process ran it (the worker got the
// dispatch first) it may still be materializing the creative / resolving the
// chat row: look again for a few seconds before giving up on the card.
async function loadFinalCard(
  projectId: string,
  taskId: string,
  polls: FinalCardPolls,
) {
  let stored = await loadTaskCard(projectId, taskId);
  for (
    let attempt = 0;
    attempt < polls.tries &&
    !(stored && FINAL_CARD_KINDS.has(stored.card.kind));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, polls.everyMs));
    stored = await loadTaskCard(projectId, taskId);
  }
  return stored && FINAL_CARD_KINDS.has(stored.card.kind) ? stored : null;
}

export function createChannel<T>() {
  const queue: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(item: T) {
      queue.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // Re-check after registering: an event or the close may have
          // landed between the checks above and this line.
          if (queue.length || closed) resolve();
        });
        wake = undefined;
      }
    },
  };
}

// Runs `task` over `items`, at most `limit` at a time. Never rejects for one
// item: `task` reports its own failures (runProductionItem never throws).
export async function forEachWithLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await task(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

export async function runProductionItem(
  spec: ProductionSpec,
  input: ProductionContext,
  emit: (event: ChatStreamEvent) => void,
): Promise<ItemOutcome> {
  const lowerLabel = spec.label.toLowerCase();
  let taskId: string | undefined;
  try {
    const plan = await TaskPlanner.planForCapability({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      // The run's own Command row: the task keeps its lineage there (and
      // an idea thread, when it was proposed inside one).
      commandId: input.commandId,
      capability: spec.capability,
      targetPlatform: spec.targetPlatform,
      request: spec.request,
      title: spec.title,
      createdByType: "USER",
      createdByUserId: input.userId,
      departmentKey: spec.department,
      payloadExtra: spec.payloadExtra,
    });
    taskId = plan.task.id;
    emit({ type: "item.start", itemId: spec.itemId, taskId });

    // Parked behind an approval (autonomy settings): nothing runs yet; the
    // approval card is in the chat.
    if (!plan.dispatched) {
      emit({
        type: "item.done",
        itemId: spec.itemId,
        ok: true,
        reply: `${spec.label} needs your approval before it starts — it is waiting in the chat.`,
      });
      return { itemId: spec.itemId, planned: true, ok: true };
    }

    // Subscribe BEFORE starting so no early preview is missed; a listener
    // also tells the creative provider somebody is watching (streamed
    // previews, no Gemini detour).
    const unsubscribe = subscribeCreativeProgress(plan.job.id, (event) =>
      emit({
        type: "item.partial",
        itemId: spec.itemId,
        index: event.index,
        dataUrl: event.dataUrl,
      }),
    );
    let settled: { status: string; errorMessage: string | null };
    try {
      settled = await driveJobInline(plan.job.id, plan.task.riskLevel);
    } finally {
      unsubscribe();
    }

    if (settled.status === "CANCELLED") {
      emit({
        type: "item.done",
        itemId: spec.itemId,
        ok: false,
        reply: `The ${lowerLabel} was cancelled.`,
      });
      return { itemId: spec.itemId, planned: true, ok: false };
    }
    if (settled.status !== "COMPLETED" && settled.status !== "FAILED") {
      emit({
        type: "item.done",
        itemId: spec.itemId,
        ok: true,
        reply: `${spec.label} is still being made in the background — it will appear here when it is ready.`,
      });
      return { itemId: spec.itemId, planned: true, ok: true };
    }

    const failed = settled.status === "FAILED";
    const final = await loadFinalCard(
      input.projectId,
      taskId,
      failed
        ? { tries: 0, everyMs: 0 }
        : (input.finalCardPolls ?? DEFAULT_FINAL_CARD_POLLS),
    );
    const failureCard: IdeaEventCardData =
      spec.capability === "CREATE_SOCIAL_CREATIVE"
        ? {
            kind: "creative-failed",
            taskId,
            title: spec.title,
            message: settled.errorMessage ?? undefined,
          }
        : {
            kind: "task-result",
            taskId,
            title: spec.title,
            department: spec.department,
            status: "FAILED",
            resultText: settled.errorMessage ?? undefined,
          };
    emit({
      type: "item.done",
      itemId: spec.itemId,
      ok: !failed,
      reply:
        final?.reply ||
        (failed
          ? `Could not make the ${lowerLabel}.`
          : `${spec.label} ready: ${spec.title}`),
      commandId: final?.commandId,
      card: final?.card ?? (failed ? failureCard : undefined),
    });
    return { itemId: spec.itemId, planned: true, ok: !failed };
  } catch (error) {
    // PROVIDER_UNAVAILABLE from inside a run is typically the router refusing
    // a circuit-broken provider: the limit card would blame a missing API
    // key and hide the real cause, so it gets its own plain message.
    const unavailable =
      isAgentelseError(error) && error.code === "PROVIDER_UNAVAILABLE";
    const notice = unavailable ? null : limitNoticeFromError(error);
    console.error(
      `${spec.logPrefix} failed:`,
      error instanceof Error ? error.message : error,
    );
    emit({
      type: "item.done",
      itemId: spec.itemId,
      ok: false,
      reply: notice
        ? limitNoticeReplyText(notice)
        : unavailable
          ? `The service that makes the ${lowerLabel} is temporarily unavailable on our side. Try again in a few minutes.`
          : `Could not make the ${lowerLabel} right now. Try again in a moment.`,
      card: notice ?? undefined,
    });
    return { itemId: spec.itemId, planned: taskId !== undefined, ok: false };
  }
}
