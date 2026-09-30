import "server-only";

import { Prisma, type CreativeContentFormat } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { ensureProjectActive } from "@/server/projects/activation";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import {
  DELIVERABLE_KEYS,
  DELIVERABLES,
  INSTAGRAM_POST_FORMATS,
  isDeliverableActive,
  type DeliverableKey,
} from "./deliverables";
import {
  createChannel,
  patchCommandCard,
  runProductionItem,
  type FinalCardPolls,
  type ItemOutcome,
} from "./production-run";
import type { ChatStreamEvent } from "./types";

// "Create selected" on a content-package chat card: every ticked deliverable
// is produced RIGHT NOW, all at once, and the whole run is a stream of tagged
// events (see the item.* / package.done variants in types.ts) that the chat
// turns into one live message per item — images sharpen in place, text shows
// a running card, and each ends as the real result card.
//
// Each item is a Task for the owning department driven inline instead of
// waiting for a worker tick (production-run.ts, shared with the content-plan
// run).

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

// Nothing could be started — reopen the card so the client can try again.
export function reopenContentPackage(commandId: string): Promise<void> {
  return patchCommandCard(commandId, {
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

function runItem(
  item: ChosenItem,
  topic: string,
  input: RunContentPackageInput,
  emit: (event: ChatStreamEvent) => void,
): Promise<ItemOutcome> {
  const deliverable = DELIVERABLES[item.deliverable];
  return runProductionItem(
    {
      itemId: item.id,
      title: item.title,
      label: deliverable.label,
      department: deliverable.department,
      capability: deliverable.capability,
      targetPlatform: deliverable.platform,
      request: packageRequestText(item, topic),
      // Image items (the only ones with a format) render as drafts, like
      // everything shown in the conversation (generate_image's default):
      // several high-quality renders side by side run into the image call's
      // time limit.
      payloadExtra: item.contentFormat
        ? { contentFormat: item.contentFormat, quality: "medium" }
        : undefined,
      logPrefix: `[content-package] ${item.deliverable}`,
    },
    input,
    emit,
  );
}

// The whole run as one event stream. The route serializes it onto SSE; it is
// consumed to the end even if the client disconnects (the work is already
// claimed, so it must finish and persist its cards).
export async function* runContentPackage(
  input: RunContentPackageInput,
): AsyncGenerator<ChatStreamEvent> {
  // A project that has not run setup is activated on the spot; only a project
  // on hold (PAUSED / CLOSED) is refused. See projects/activation.ts.
  const activation = await ensureProjectActive(input.projectId);
  if (!activation.usable) {
    yield {
      type: "error",
      code: "PROJECT_INACTIVE",
      message: "This project is on hold, so no new work can start.",
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
      await patchCommandCard(input.commandId, {
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
