import "server-only";

import { Prisma, type CreativeContentFormat } from "@prisma/client";

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
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";

import {
  DELIVERABLE_KEYS,
  DELIVERABLES,
  INSTAGRAM_POST_FORMATS,
  isDeliverableActive,
  type DeliverableKey,
} from "./deliverables";
import { driveJobInline } from "./inline-job";
import type { ChatStreamEvent } from "./types";

// "Create selected" on a content-package chat card: every ticked deliverable
// is produced RIGHT NOW, all at once, and the whole run is a stream of tagged
// events (see the item.* / package.done variants in types.ts) that the chat
// turns into one live message per item — images sharpen in place, text shows
// a running card, and each ends as the real result card.
//
// Each item is a Task for the owning department (TaskPlanner, the entry the
// scheduler uses — no chat bubble per item) that is driven inline instead of
// waiting for a worker tick, exactly like generate_image does
// (driveJobInline: the job's dispatch event is taken first, so the worker
// never runs the same job a second time).

export type PackageSelection = { id: string; contentFormat?: string };

export type ChosenItem = {
  id: string;
  deliverable: DeliverableKey;
  title: string;
  angle: string;
  contentFormat?: CreativeContentFormat;
};

export type ClaimResult =
  | { ok: true; topic: string; items: ChosenItem[] }
  | { ok: false; message: string };

const isDeliverableKey = (value: string): value is DeliverableKey =>
  (DELIVERABLE_KEYS as readonly string[]).includes(value);

const isPostFormat = (
  value: string | undefined,
): value is CreativeContentFormat =>
  (INSTAGRAM_POST_FORMATS as readonly string[]).includes(value ?? "");

// Flips the card draft -> started inside a serializable transaction, so a
// double click (or two tabs) can't queue the whole package twice, and returns
// what to produce: the ticked items, with the client's format choice for
// image items (unknown values fall back to the 3:4 post).
export async function claimContentPackage(input: {
  projectId: string;
  commandId: string;
  selections: readonly PackageSelection[];
}): Promise<ClaimResult> {
  try {
    return await prisma.$transaction(
      async (tx): Promise<ClaimResult> => {
        const row = await tx.command.findUnique({
          where: { id: input.commandId },
          select: { parsedIntent: true, projectId: true },
        });
        const intent = row?.parsedIntent as { card?: unknown } | null;
        const card = intent?.card;
        if (
          row?.projectId !== input.projectId ||
          !isIdeaEventCardData(card) ||
          card.kind !== "content-package"
        ) {
          return { ok: false, message: "Package not found." };
        }
        if (card.state === "started") {
          return { ok: false, message: "This package was already started." };
        }
        if (card.state === "superseded") {
          return {
            ok: false,
            message: "A newer version of this package exists. Use that one.",
          };
        }

        const items: ChosenItem[] = [];
        const seen = new Set<string>();
        for (const selection of input.selections) {
          if (seen.has(selection.id)) continue;
          seen.add(selection.id);
          const item = card.items.find(
            (candidate) => candidate.id === selection.id,
          );
          if (!item || !isDeliverableKey(item.deliverable)) continue;
          if (!isDeliverableActive(item.deliverable)) continue;
          const wanted = selection.contentFormat ?? item.contentFormat;
          items.push({
            id: item.id,
            deliverable: item.deliverable,
            title: item.title,
            angle: item.angle,
            contentFormat: DELIVERABLES[item.deliverable].needsFormat
              ? isPostFormat(wanted)
                ? wanted
                : "FEED_PORTRAIT"
              : undefined,
          });
        }
        if (items.length === 0) {
          return { ok: false, message: "Select at least one item." };
        }

        await tx.command.update({
          where: { id: input.commandId },
          data: {
            parsedIntent: {
              ...intent,
              card: {
                ...card,
                state: "started",
                startedAt: new Date().toISOString(),
                startedCount: items.length,
                startedItemIds: items.map((item) => item.id),
              },
            } as never,
          },
        });
        return { ok: true, topic: card.topic, items };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    // Two claims raced (double click, two tabs): the loser gets a serialization
    // failure — say what it means instead of surfacing database text.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      return { ok: false, message: "This package is already being started." };
    }
    throw error;
  }
}

// Read-modify-write of the package card's stored fields. Only the run itself
// writes a claimed card, so there is no concurrent writer to lose to.
async function patchStartedCard(
  commandId: string,
  patch: Record<string, unknown>,
): Promise<void> {
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

// Nothing could be started — reopen the card so the client can try again.
export function reopenContentPackage(commandId: string): Promise<void> {
  return patchStartedCard(commandId, {
    state: "draft",
    startedAt: undefined,
    startedCount: undefined,
    startedItemIds: undefined,
  });
}

// The worker's brief: the concrete piece, its angle, the topic and the shape
// of the deliverable (article outline, reel script...).
export function packageRequestText(item: ChosenItem, topic: string): string {
  const deliverable = DELIVERABLES[item.deliverable];
  return [
    `${deliverable.label}: ${item.title}`,
    `Angle: ${item.angle}`,
    `Topic: ${topic}`,
    `Deliverable: ${deliverable.brief}.`,
  ].join("\n");
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

type ItemOutcome = { itemId: string; planned: boolean; ok: boolean };

function createChannel<T>() {
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

export type RunContentPackageInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  commandId: string;
  selections: readonly PackageSelection[];
  // How long to look for the final card of a job another process ran.
  finalCardPolls?: FinalCardPolls;
};

async function runItem(
  item: ChosenItem,
  topic: string,
  input: RunContentPackageInput,
  emit: (event: ChatStreamEvent) => void,
): Promise<ItemOutcome> {
  const deliverable = DELIVERABLES[item.deliverable];
  let taskId: string | undefined;
  try {
    const plan = await TaskPlanner.planForCapability({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      // The package's own Command row: the task keeps its lineage there (and
      // an idea thread, when the package was proposed inside one).
      commandId: input.commandId,
      capability: deliverable.capability,
      targetPlatform: deliverable.platform,
      request: packageRequestText(item, topic),
      title: item.title,
      createdByType: "USER",
      createdByUserId: input.userId,
      departmentKey: deliverable.department,
      // Image items (the only ones with a format) render as drafts, like
      // everything shown in the conversation (generate_image's default):
      // several high-quality renders side by side run into the image call's
      // time limit.
      payloadExtra: item.contentFormat
        ? { contentFormat: item.contentFormat, quality: "medium" }
        : undefined,
    });
    taskId = plan.task.id;
    emit({ type: "item.start", itemId: item.id, taskId });

    // Parked behind an approval (autonomy settings): nothing runs yet; the
    // approval card is in the chat.
    if (!plan.dispatched) {
      emit({
        type: "item.done",
        itemId: item.id,
        ok: true,
        reply: `${deliverable.label} needs your approval before it starts — it is waiting in the chat.`,
      });
      return { itemId: item.id, planned: true, ok: true };
    }

    // Subscribe BEFORE starting so no early preview is missed; a listener
    // also tells the creative provider somebody is watching (streamed
    // previews, no Gemini detour).
    const unsubscribe = subscribeCreativeProgress(plan.job.id, (event) =>
      emit({
        type: "item.partial",
        itemId: item.id,
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
        itemId: item.id,
        ok: false,
        reply: `The ${deliverable.label.toLowerCase()} was cancelled.`,
      });
      return { itemId: item.id, planned: true, ok: false };
    }
    if (settled.status !== "COMPLETED" && settled.status !== "FAILED") {
      emit({
        type: "item.done",
        itemId: item.id,
        ok: true,
        reply: `${deliverable.label} is still being made in the background — it will appear here when it is ready.`,
      });
      return { itemId: item.id, planned: true, ok: true };
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
      deliverable.capability === "CREATE_SOCIAL_CREATIVE"
        ? {
            kind: "creative-failed",
            taskId,
            title: item.title,
            message: settled.errorMessage ?? undefined,
          }
        : {
            kind: "task-result",
            taskId,
            title: item.title,
            department: deliverable.department,
            status: "FAILED",
            resultText: settled.errorMessage ?? undefined,
          };
    emit({
      type: "item.done",
      itemId: item.id,
      ok: !failed,
      reply:
        final?.reply ||
        (failed
          ? `Could not make the ${deliverable.label.toLowerCase()}.`
          : `${deliverable.label} ready: ${item.title}`),
      commandId: final?.commandId,
      card: final?.card ?? (failed ? failureCard : undefined),
    });
    return { itemId: item.id, planned: true, ok: !failed };
  } catch (error) {
    // PROVIDER_UNAVAILABLE from inside a run is typically the router refusing
    // a circuit-broken provider: the limit card would blame a missing API
    // key and hide the real cause, so it gets its own plain message.
    const unavailable =
      isAgentelseError(error) && error.code === "PROVIDER_UNAVAILABLE";
    const notice = unavailable ? null : limitNoticeFromError(error);
    console.error(
      `[content-package] ${item.deliverable} failed:`,
      error instanceof Error ? error.message : error,
    );
    emit({
      type: "item.done",
      itemId: item.id,
      ok: false,
      reply: notice
        ? limitNoticeReplyText(notice)
        : unavailable
          ? `The service that makes the ${deliverable.label.toLowerCase()} is temporarily unavailable on our side. Try again in a few minutes.`
          : `Could not make the ${deliverable.label.toLowerCase()} right now. Try again in a moment.`,
      card: notice ?? undefined,
    });
    return { itemId: item.id, planned: taskId !== undefined, ok: false };
  }
}

// The whole run as one event stream. The route serializes it onto SSE; it is
// consumed to the end even if the client disconnects (the work is already
// claimed, so it must finish and persist its cards).
export async function* runContentPackage(
  input: RunContentPackageInput,
): AsyncGenerator<ChatStreamEvent> {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { status: true },
  });
  if (project?.status !== "ACTIVE") {
    yield {
      type: "error",
      code: "SETUP_REQUIRED",
      message: "This project's setup has not finished yet.",
    };
    return;
  }

  const claim = await claimContentPackage(input);
  if (!claim.ok) {
    yield { type: "error", code: "PACKAGE", message: claim.message };
    return;
  }

  const channel = createChannel<ChatStreamEvent>();
  const outcomes: ItemOutcome[] = [];
  const work = Promise.all(
    claim.items.map(async (item) => {
      outcomes.push(await runItem(item, claim.topic, input, channel.push));
    }),
  ).finally(() => channel.close());

  for await (const event of channel) yield event;
  await work;

  const plannedIds = outcomes
    .filter((outcome) => outcome.planned)
    .map((outcome) => outcome.itemId);
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  if (plannedIds.length === 0) {
    await reopenContentPackage(input.commandId).catch((error) => {
      console.error("[content-package] reopen failed:", error);
    });
  } else {
    // The claim recorded every ticked item; the card should list only the
    // ones that really got a task.
    if (plannedIds.length < claim.items.length) {
      await patchStartedCard(input.commandId, {
        startedCount: plannedIds.length,
        startedItemIds: plannedIds,
      }).catch((error) => {
        console.error("[content-package] card update failed:", error);
      });
    }
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      actorType: "USER",
      actorId: input.userId,
      action: "content_package.started",
      entityType: "Command",
      entityId: input.commandId,
      metadata: {
        items: plannedIds.length,
        requested: claim.items.length,
        failed,
      },
    }).catch(() => undefined);
  }
  yield { type: "package.done", started: plannedIds.length, failed };
}
