import "server-only";

import type { CommandSource, Prisma } from "@prisma/client";

import { INTERRUPTED_REPLY, STOPPED_REPLY } from "@/lib/chat-reply";
import { hasPlanBriefMarker } from "@/lib/plan-brief";
import { prisma } from "@/lib/prisma";

// A file attached to a chat turn. A soft reference to the Asset row:
// no real FK, because Command is multi-tenant and attachments are cleaned
// up together with the Asset when the project is deleted.
export type CommandAttachment = {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
};

// The outcome of the assistant's reply to a turn.
export type CommandReplyStatus =
  | "PLANNED" // a task was created
  | "ANSWERED" // the question was answered, no work was opened
  | "APPROVAL_HANDLED" // a pending approval was decided by this message
  | "NEEDS_PROJECT" // the project could not be resolved (doesn't occur on the chat surface)
  | "UNCLEAR" // intent could not be understood, a question was asked
  | "ERROR" // an error occurred while generating the reply
  // The agent's turn is in flight (written on create, replaced by the final
  // status at the end). Never a final status.
  | "RUNNING"
  // Final: the client pressed Stop, or the run hit its deadline.
  | "STOPPED"
  // Final: the process died mid-turn. Written only by the orphan cleanup
  // (the chat route), for a RUNNING row no live run drives any more.
  | "INTERRUPTED";

// Command.topic of the chat rows an edit replaced (the edited message and
// everything after it). Every chat feed reads `topic: null` (the page, the
// model's history), so they drop out of the chat; what their turns produced
// (creatives, calendar slots, tasks) stays where it is.
export const SUPERSEDED_TOPIC = "SUPERSEDED";

// Why an edit was refused (the route answers every one the same way).
export type SupersedeRefusal =
  | "not_found" // no such row in this project
  | "not_editable" // not the person's own message of this chat
  | "running" // its reply is still being written
  | "plan_brief"; // a wizard message: its machine line is not editable text

// A RUNNING row's final status, with the placeholder reply when it has no
// text of its own. Guarded on RUNNING, so a turn that settled meanwhile is
// left alone. Returns how many rows changed.
async function settleRunning(
  where: Prisma.CommandWhereInput,
  replyStatus: "STOPPED" | "INTERRUPTED",
  placeholder: string,
): Promise<number> {
  const withoutText = await prisma.command.updateMany({
    where: { ...where, replyStatus: "RUNNING", replyText: null },
    data: { replyStatus, replyText: placeholder },
  });
  const withText = await prisma.command.updateMany({
    where: { ...where, replyStatus: "RUNNING" },
    data: { replyStatus },
  });
  return withoutText.count + withText.count;
}

// The stored attachments of a row (a JSON column): the well-formed entries.
function attachmentsOf(value: unknown): CommandAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CommandAttachment[] => {
    if (!item || typeof item !== "object") return [];
    const { assetId, filename, mimeType, size } = item as Record<
      string,
      unknown
    >;
    if (typeof assetId !== "string" || typeof mimeType !== "string") {
      return [];
    }
    return [
      {
        assetId,
        filename: typeof filename === "string" ? filename : "file",
        mimeType,
        size: typeof size === "number" ? size : 0,
      },
    ];
  });
}

export const CommandRepository = {
  create(input: {
    // Optional caller-chosen primary key: a deterministic id makes the insert
    // an idempotent "create if absent" (a duplicate raises P2002).
    id?: string;
    workspaceId: string;
    projectId?: string;
    brandId?: string;
    ideaId?: string;
    // The Work (conversation) this row belongs to; absent = legacy single chat.
    workId?: string;
    // A non-idea, non-general conversation scope (e.g. "BRAND_BRAIN") — see
    // schema.prisma's Command.topic comment.
    topic?: string;
    source: CommandSource;
    rawText: string;
    parsedIntent?: unknown;
    createdByUserId?: string;
    attachments?: CommandAttachment[];
    // Set at insert only by the streaming agent ("RUNNING"); everyone else
    // writes the reply and its status in one go (recordReply).
    replyStatus?: CommandReplyStatus;
  }) {
    const { attachments, parsedIntent, ...rest } = input;
    return prisma.command.create({
      data: {
        ...rest,
        parsedIntent: parsedIntent as never,
        attachments: (attachments?.length ? attachments : undefined) as never,
      },
    });
  },

  attachParsedIntent(
    id: string,
    parsedIntent: unknown,
    projectId?: string,
    brandId?: string,
  ) {
    return prisma.command.update({
      where: { id },
      data: { parsedIntent: parsedIntent as never, projectId, brandId },
    });
  },

  // Works only: the same write, but a card the turn already stored on the row
  // (slot-first generation stores the saved plan card before the turn ends)
  // survives. Replacing the whole parsedIntent would drop it and leave the
  // slots it created invisible, un-producible and uncounted.
  async attachParsedIntentKeepingCard(
    id: string,
    parsedIntent: unknown,
    projectId?: string,
    brandId?: string,
  ) {
    const existing = await prisma.command.findUnique({
      where: { id },
      select: { parsedIntent: true },
    });
    const kept = (existing?.parsedIntent as { card?: unknown } | null)?.card;
    const next =
      kept !== undefined &&
      kept !== null &&
      parsedIntent !== null &&
      typeof parsedIntent === "object" &&
      !("card" in parsedIntent)
        ? { ...(parsedIntent as Record<string, unknown>), card: kept }
        : parsedIntent;
    return prisma.command.update({
      where: { id },
      data: { parsedIntent: next as never, projectId, brandId },
    });
  },

  // A Command is normally created already knowing its ideaId (an idea's own
  // chat thread) or knowing it has none (general chat) — see the comment on
  // `create` above. The Deep Path (docs/brand-workspace-migration.md §7
  // Phase 8) is the one exception: a general-chat message that turns out to
  // START a brand-new idea, so the idea doesn't exist yet at Command-create
  // time. This retroactively links the two, so the "Chats" sidebar picks up
  // the new idea's thread and later replies in it show up here too.
  attachIdeaId(id: string, ideaId: string) {
    return prisma.command.update({
      where: { id },
      data: { ideaId },
    });
  },

  recordReply(id: string, replyText: string, replyStatus: CommandReplyStatus) {
    return prisma.command.update({
      where: { id },
      data: { replyText, replyStatus },
    });
  },

  // The WEB turns of one chat still marked RUNNING: in flight, or orphaned by
  // a process that died mid-turn (the caller tells them apart with the run
  // registry). `workId: null` is the project's general chat (Works off).
  async runningTurnIds(scope: {
    projectId: string;
    workId: string | null;
  }): Promise<string[]> {
    const rows = await prisma.command.findMany({
      where: {
        projectId: scope.projectId,
        workId: scope.workId,
        source: "WEB",
        replyStatus: "RUNNING",
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  // Orphaned turns (no live run drives them any more) end as INTERRUPTED.
  markInterrupted(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return Promise.resolve(0);
    return settleRunning(
      { id: { in: [...ids] } },
      "INTERRUPTED",
      INTERRUPTED_REPLY,
    );
  },

  // Stop pressed for a turn whose run is gone (the process restarted): the row
  // is settled as STOPPED instead of waiting for a run that never comes back.
  markStopped(scope: {
    projectId: string;
    commandId: string;
  }): Promise<number> {
    return settleRunning(
      { id: scope.commandId, projectId: scope.projectId, source: "WEB" },
      "STOPPED",
      STOPPED_REPLY,
    );
  },

  // An edit (Works): the edited message and EVERYTHING after it in its chat
  // leave the conversation and the model's history (topic SUPERSEDED, see
  // above); the route then sends the edited text as a new turn. Only the
  // person's own sent message of this chat can be edited: not a SYSTEM or
  // synthetic row, not one whose reply is still being written, not a wizard
  // message. Returns the edited row's files, which the new turn carries over.
  async supersedeFrom(input: {
    projectId: string;
    workId: string;
    commandId: string;
  }): Promise<
    | { ok: true; attachments: CommandAttachment[] }
    | { ok: false; reason: SupersedeRefusal }
  > {
    const row = await prisma.command.findFirst({
      where: { id: input.commandId, projectId: input.projectId },
      select: {
        source: true,
        workId: true,
        topic: true,
        replyStatus: true,
        rawText: true,
        attachments: true,
        createdAt: true,
      },
    });
    if (!row) return { ok: false, reason: "not_found" };
    if (
      row.source !== "WEB" ||
      row.workId !== input.workId ||
      row.topic !== null
    ) {
      return { ok: false, reason: "not_editable" };
    }
    if (row.replyStatus === "RUNNING") return { ok: false, reason: "running" };
    if (hasPlanBriefMarker(row.rawText)) {
      return { ok: false, reason: "plan_brief" };
    }
    // One write: the WEB turns and the SYSTEM rows they led to (creative
    // cards, task results) from the edited message on.
    await prisma.command.updateMany({
      where: {
        projectId: input.projectId,
        workId: input.workId,
        topic: null,
        createdAt: { gte: row.createdAt },
      },
      data: { topic: SUPERSEDED_TOPIC },
    });
    return { ok: true, attachments: attachmentsOf(row.attachments) };
  },
};
