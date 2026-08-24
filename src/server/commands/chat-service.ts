import "server-only";

import { prisma } from "@/lib/prisma";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  chatTurnDef,
  type ChatTurnOutput,
} from "@/server/reasoning/prompts/chat-turn";
import { CommandService } from "@/server/commands/command-service";
import {
  CommandRepository,
  type CommandAttachment,
  type CommandReplyStatus,
} from "@/server/repositories/command.repository";
import type { ParsedIntent } from "@/server/commands/intent-router";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import type { IdeaEventCardData } from "@/types/idea-event-card";

export type ChatTurnInput = {
  workspaceId: string;
  projectId: string;
  userId: string;
  message: string;
  attachments?: CommandAttachment[];
  // Bodies sent to Gemini as inlineData; same order as attachments.
  // Carried separately because the base64 body isn't written to the
  // Command row (it would bloat the JSON) — it's only shown to the model.
  attachmentBodies?: { mimeType: string; data: string }[];
  // Set when a message is sent from an idea's own chat thread — the
  // Command gets tagged with this idea AND the history context
  // (buildContext) is scoped to this idea's thread instead of project-wide.
  ideaId?: string;
};

export type ChatTurnResult = {
  commandId: string;
  reply: string;
  status: CommandReplyStatus;
  // Set when the reply is a structured chat card (today: the limit-notice
  // card explaining why no reply could be generated). The client renders
  // this instead of the plain reply text, without waiting for the next
  // server refresh.
  card?: IdeaEventCardData;
};

// Server side of the chat screen: on every user message, gathers the brand
// context, has the LLM produce an intent + reply, hands off to
// CommandService if it's a work request, and saves the reply to the
// Command row — so on page reload the conversation history comes back
// from the database exactly as it was.
export const ChatService = {
  async turn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const context = await buildContext(input.projectId, input.ideaId);

    let turn: ChatTurnOutput;
    try {
      const result = await ReasoningService.run(chatTurnDef, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: context.brandId,
        attachments: input.attachmentBodies,
        context: {
          project: context.project,
          brand: context.brand,
          state: context.state,
          pending: context.pending,
          history: context.history,
          attachments: (input.attachments ?? []).map((attachment) => ({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          })),
          message: input.message,
        },
      });
      turn = result.output;
    } catch (error) {
      // A recognized block (daily cap/budget hit, provider key missing,
      // provider rate-limited/timed out): don't queue fallback work — it
      // would hit the same wall in the worker — record the message with a
      // limit-notice card instead. The card explains the cause and (for
      // caps) links into the autonomy settings panel (idea-event-card.tsx).
      const notice = limitNoticeFromError(error);
      if (notice) {
        const command = await CommandRepository.create({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: context.brandId,
          ideaId: input.ideaId,
          source: "WEB",
          rawText: input.message,
          parsedIntent: { card: notice },
          createdByUserId: input.userId,
          attachments: input.attachments,
        });
        const reply = limitNoticeReplyText(notice);
        await CommandRepository.recordReply(command.id, reply, "ERROR");
        return { commandId: command.id, reply, status: "ERROR", card: notice };
      }

      // Even if the LLM fails, the message must not be lost: the command is
      // still recorded, the rule-based parser kicks in (legacy behavior),
      // and an honest error message is written as the reply. Since the
      // real cause (invalid key, model not found, quota, etc.) is never
      // shown to the user, it would be lost entirely if not logged here.
      console.error(
        "[chat-service] Gemini reasoning failed, falling back to rule-based intent:",
        error instanceof Error ? error.message : error,
      );
      const fallback = await CommandService.submit({
        workspaceId: input.workspaceId,
        source: "WEB",
        rawText: input.message,
        actorType: "USER",
        userId: input.userId,
        knownProjectId: input.projectId,
        ideaId: input.ideaId,
        attachments: input.attachments,
      });
      const reply =
        fallback.status === "PLANNED"
          ? "Got your request as a task. (The AI reply couldn't be generated right now, but the work was still queued.)"
          : `I can't generate a reply right now: ${error instanceof Error ? error.message : "unknown error"}. Please try again.`;
      const status: CommandReplyStatus =
        fallback.status === "PLANNED" ? "PLANNED" : "ERROR";
      await CommandRepository.recordReply(fallback.commandId, reply, status);
      return { commandId: fallback.commandId, reply, status };
    }

    // Convert the LLM's decision into the intent CommandService understands.
    // For TASK, taskBrief is used (chat context embedded); otherwise the raw message.
    const intent = toParsedIntent(turn, input.message);

    const submission = await CommandService.submit({
      workspaceId: input.workspaceId,
      source: "WEB",
      rawText: input.message,
      actorType: "USER",
      userId: input.userId,
      knownProjectId: input.projectId,
      ideaId: input.ideaId,
      attachments: input.attachments,
      intent,
    });

    let reply = turn.reply.trim() || "Got it.";
    let status: CommandReplyStatus;

    switch (submission.status) {
      case "PLANNED":
        status = "PLANNED";
        if (submission.requiresApproval) {
          reply +=
            "\n\nThis work is critical, so it'll come to you for approval first.";
        }
        break;
      case "APPROVAL_HANDLED":
        status = "APPROVAL_HANDLED";
        break;
      case "NEEDS_PROJECT":
        // In practice this never happens since knownProjectId is always provided.
        status = "NEEDS_PROJECT";
        break;
      default:
        status = turn.intentKind === "UNCLEAR" ? "UNCLEAR" : "ANSWERED";
        break;
    }

    await CommandRepository.recordReply(submission.commandId, reply, status);
    return { commandId: submission.commandId, reply, status };
  },
};

function toParsedIntent(turn: ChatTurnOutput, message: string): ParsedIntent {
  if (turn.intentKind === "TASK" && turn.capability) {
    return {
      kind: "CAPABILITY",
      capability: turn.capability,
      targetPlatform: turn.platform,
      request: turn.taskBrief?.trim() || message,
    };
  }
  if (turn.intentKind === "APPROVAL" && turn.approvalDecision) {
    return {
      kind: "APPROVAL_DECISION",
      decision: turn.approvalDecision,
      note: turn.approvalDecision === "REVISE" ? message : undefined,
    };
  }
  // ANSWER and UNCLEAR don't open a task — CommandService records the
  // command and returns UNKNOWN_INTENT; the reply already came from the LLM.
  return { kind: "UNKNOWN" };
}

const HISTORY_TURNS = 12;

async function buildContext(projectId: string, ideaId?: string) {
  const [project, dossier, constitution, dailyStat, pendingApprovals, recent] =
    await Promise.all([
      prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: {
          name: true,
          domain: true,
          status: true,
          language: true,
          country: true,
          brands: { where: { isDefault: true }, select: { id: true }, take: 1 },
        },
      }),
      prisma.brandDossier.findFirst({
        where: { projectId },
        select: { summary: true, positioning: true, toneOfVoice: true },
      }),
      prisma.brandConstitution.findFirst({
        where: { projectId, status: "ACTIVE" },
        orderBy: { version: "desc" },
        select: { summary: true },
      }),
      latestDailyStat(projectId),
      prisma.approval.findMany({
        where: { projectId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { type: true, entityType: true, createdAt: true },
      }),
      // In an idea's chat thread, history is ALL messages belonging to that
      // idea — both what the user wrote (WEB) and the system events written
      // by the pipeline (SYSTEM: council decision, work plan, task/creative
      // completion). This way the LLM replies knowing what the pipeline
      // just did. If there's no ideaId (project-wide chat), the old
      // behavior is preserved: WEB only.
      prisma.command.findMany({
        where: ideaId
          ? { ideaId, source: { in: ["WEB", "SYSTEM"] } }
          : { projectId, source: "WEB" },
        orderBy: { createdAt: "desc" },
        take: HISTORY_TURNS,
        select: {
          source: true,
          rawText: true,
          replyText: true,
          attachments: true,
        },
      }),
    ]);

  const brandId = project.brands[0]?.id;
  if (!brandId) {
    throw new Error(`Project ${projectId} has no default brand`);
  }

  // The newest record comes first; reversed so the chat reads
  // chronologically. SYSTEM-sourced rows have an empty rawText (a pipeline
  // event, not a user message) — the "Client:" line is skipped and only the
  // event note is written.
  const history = recent
    .reverse()
    .flatMap((command) => {
      const attachmentNote = Array.isArray(command.attachments)
        ? ` [attached: ${(command.attachments as { filename?: string }[])
            .map((a) => a.filename ?? "file")
            .join(", ")}]`
        : "";
      if (command.source === "SYSTEM") {
        return command.replyText ? [`System: ${command.replyText}`] : [];
      }
      const lines = [`Client: ${command.rawText}${attachmentNote}`];
      if (command.replyText) lines.push(`You: ${command.replyText}`);
      return lines;
    })
    .join("\n");

  return {
    brandId,
    project: {
      name: project.name,
      domain: project.domain,
      status: project.status,
      language: project.language,
      country: project.country,
    },
    brand: {
      summary: constitution?.summary ?? dossier?.summary,
      positioning: dossier?.positioning,
      toneOfVoice: dossier?.toneOfVoice,
    },
    state: dailyStat,
    pending: pendingApprovals.map((approval) => ({
      type: approval.type,
      entityType: approval.entityType,
      waitingSince: approval.createdAt.toISOString(),
    })),
    history,
  };
}

async function latestDailyStat(projectId: string) {
  const stat = await prisma.agencyDailyStat.findFirst({
    where: { projectId },
    orderBy: { date: "desc" },
    select: {
      date: true,
      signalsIngested: true,
      opportunitiesCreated: true,
      ideasCreated: true,
      tasksCreated: true,
    },
  });
  if (!stat) return null;
  return { ...stat, date: stat.date.toISOString().slice(0, 10) };
}
