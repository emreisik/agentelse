import "server-only";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  brandBrainChatDef,
  type BrandBrainQuestion,
  type BrandBrainRevision,
} from "@/server/reasoning/prompts/brand-brain-chat";
import { CommandRepository } from "@/server/repositories/command.repository";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";

// The scope tag distinguishing this thread from an idea's chat and from the
// general project chat (schema.prisma's Command.topic comment,
// projects/[projectId]/page.tsx's topic:null exclusion).
export const BRAND_BRAIN_TOPIC = "BRAND_BRAIN";

const HISTORY_TURNS = 20;

export type BrandBrainChatTurn = {
  commandId: string;
  reply: string;
  questions: BrandBrainQuestion[] | null;
  proposedRevision: BrandBrainRevision | null;
  revisionSummary: string | null;
};

// Same shape as ChatService.turn (chat-service.ts) — a standing,
// non-idea-scoped conversation, deliberately NOT routed through
// CommandService.submit: there's no task/approval classification here, just
// discuss-or-propose. A proposed revision is stored on the Command's
// parsedIntent for applyBrandBrainRevisionAction (agency-strategy-actions.ts)
// to pick up later; it does not apply itself.
export const BrandBrainChatService = {
  async turn(input: {
    workspaceId: string;
    projectId: string;
    userId: string;
    message: string;
  }): Promise<BrandBrainChatTurn> {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: input.projectId },
      select: {
        brands: { where: { isDefault: true }, select: { id: true }, take: 1 },
      },
    });
    const brandId = project.brands[0]?.id;
    if (!brandId) {
      throw new Error(`Project ${input.projectId} has no default brand`);
    }

    const [brand, recent] = await Promise.all([
      ConstitutionService.getBrandContext(brandId),
      prisma.command.findMany({
        where: { projectId: input.projectId, topic: BRAND_BRAIN_TOPIC },
        orderBy: { createdAt: "desc" },
        take: HISTORY_TURNS,
        select: { rawText: true, replyText: true },
      }),
    ]);

    const history = recent
      .reverse()
      .flatMap((command) => {
        const lines = [`Client: ${command.rawText}`];
        if (command.replyText) lines.push(`You: ${command.replyText}`);
        return lines;
      })
      .join("\n");

    try {
      const { output } = await ReasoningService.run(brandBrainChatDef, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId,
        context: { brand, history, message: input.message },
      });

      const command = await CommandRepository.create({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId,
        topic: BRAND_BRAIN_TOPIC,
        source: "WEB",
        rawText: input.message,
        createdByUserId: input.userId,
        parsedIntent:
          output.proposedRevision || output.questions
            ? {
                proposedRevision: output.proposedRevision,
                revisionSummary: output.revisionSummary,
                questions: output.questions,
              }
            : undefined,
      });
      await CommandRepository.recordReply(command.id, output.reply, "ANSWERED");

      return {
        commandId: command.id,
        reply: output.reply,
        questions: output.questions,
        proposedRevision: output.proposedRevision,
        revisionSummary: output.revisionSummary,
      };
    } catch (error) {
      // Same recognized-block handling as ChatService.turn: a daily
      // cap/budget hit or provider hiccup gets an honest limit-notice card
      // instead of a broken/queued fallback (there's no task-queue fallback
      // that makes sense here — this thread never creates tasks).
      const notice = limitNoticeFromError(error);
      const replyText = notice
        ? limitNoticeReplyText(notice)
        : `I can't reply right now: ${error instanceof Error ? error.message : "unknown error"}. Please try again.`;
      const command = await CommandRepository.create({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId,
        topic: BRAND_BRAIN_TOPIC,
        source: "WEB",
        rawText: input.message,
        createdByUserId: input.userId,
      });
      await CommandRepository.recordReply(command.id, replyText, "ERROR");
      return {
        commandId: command.id,
        reply: replyText,
        questions: null,
        proposedRevision: null,
        revisionSummary: null,
      };
    }
  },
};
