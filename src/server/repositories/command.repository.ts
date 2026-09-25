import "server-only";

import type { CommandSource } from "@prisma/client";

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
  | "ERROR"; // an error occurred while generating the reply

export const CommandRepository = {
  create(input: {
    workspaceId: string;
    projectId?: string;
    brandId?: string;
    ideaId?: string;
    // A non-idea, non-general conversation scope (e.g. "BRAND_BRAIN") — see
    // schema.prisma's Command.topic comment.
    topic?: string;
    source: CommandSource;
    rawText: string;
    parsedIntent?: unknown;
    createdByUserId?: string;
    attachments?: CommandAttachment[];
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
};
