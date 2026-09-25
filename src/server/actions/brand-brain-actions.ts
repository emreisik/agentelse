"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import type {
  BrandBrainQuestion,
  BrandBrainRevision,
} from "@/server/reasoning/prompts/brand-brain-chat";
import {
  BRAND_BRAIN_TOPIC,
  BrandBrainChatService,
} from "@/server/commands/brand-brain-chat-service";
import { CommandRepository } from "@/server/repositories/command.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

// The shape the floating widget renders per turn — one entry per Command
// row on the BRAND_BRAIN_TOPIC thread.
export type BrandBrainChatTurn = {
  commandId: string;
  source: "WEB" | "SYSTEM";
  text: string;
  reply: string | null;
  questions: BrandBrainQuestion[] | null;
  proposedRevision: BrandBrainRevision | null;
  revisionSummary: string | null;
};

function fail(error: unknown): { ok: false; message: string } {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Operation failed",
  };
}

export type SendBrandBrainMessageResult =
  | {
      ok: true;
      commandId: string;
      reply: string;
      questions: BrandBrainQuestion[] | null;
      proposedRevision: BrandBrainRevision | null;
      revisionSummary: string | null;
    }
  | { ok: false; message: string };

// The Brand Brain chat's send action — see BrandBrainChatService.turn for
// why this doesn't go through CommandService.submit (no task/approval
// classification here, purely a standing conversation).
export async function sendBrandBrainMessageAction(
  projectId: string,
  message: string,
): Promise<SendBrandBrainMessageResult> {
  try {
    const trimmed = message.trim();
    if (!trimmed) return { ok: false, message: "Message is empty" };
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const turn = await BrandBrainChatService.turn({
      workspaceId: access.workspaceId,
      projectId,
      userId,
      message: trimmed,
    });

    revalidatePath(`/projects/${projectId}`);
    return {
      ok: true,
      commandId: turn.commandId,
      reply: turn.reply,
      questions: turn.questions,
      proposedRevision: turn.proposedRevision,
      revisionSummary: turn.revisionSummary,
    };
  } catch (error) {
    return fail(error);
  }
}

// Lazy-loads the standing Brand Brain thread — called by the floating
// widget (brand-brain-assistant.tsx) the first time it's expanded, so
// AppShell (which mounts the widget on every page of the project) never has
// to eagerly fetch chat history on every navigation.
export async function getBrandBrainChatHistoryAction(
  projectId: string,
): Promise<
  { ok: true; turns: BrandBrainChatTurn[] } | { ok: false; message: string }
> {
  try {
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const commands = await prisma.command.findMany({
      where: { projectId, topic: BRAND_BRAIN_TOPIC },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        source: true,
        rawText: true,
        replyText: true,
        parsedIntent: true,
      },
    });

    const turns: BrandBrainChatTurn[] = commands.reverse().map((command) => {
      const parsed = command.parsedIntent as {
        proposedRevision?: BrandBrainRevision | null;
        revisionSummary?: string | null;
        questions?: BrandBrainQuestion[] | null;
      } | null;
      return {
        commandId: command.id,
        source: command.source as "WEB" | "SYSTEM",
        text: command.rawText,
        reply: command.replyText,
        questions: parsed?.questions ?? null,
        proposedRevision: parsed?.proposedRevision ?? null,
        revisionSummary: parsed?.revisionSummary ?? null,
      };
    });

    return { ok: true, turns };
  } catch (error) {
    return fail(error);
  }
}

// "Apply" on a proposed-revision card: re-reads the proposal from the
// Command it was attached to (not trusted from the client) and hands it to
// ConstitutionService.applyConversationRevision, which does the actual
// merge + version + activate + promote.
export async function applyBrandBrainRevisionAction(
  projectId: string,
  commandId: string,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const command = await prisma.command.findFirst({
      where: { id: commandId, projectId, topic: BRAND_BRAIN_TOPIC },
      select: { brandId: true, parsedIntent: true },
    });
    if (!command || !command.brandId) {
      return { ok: false, message: "Conversation message not found" };
    }
    const parsed = command.parsedIntent as {
      proposedRevision?: BrandBrainRevision;
      revisionSummary?: string;
    } | null;
    if (!parsed?.proposedRevision) {
      return { ok: false, message: "No proposed revision on this message" };
    }

    const activated = await ConstitutionService.applyConversationRevision({
      workspaceId: access.workspaceId,
      projectId,
      brandId: command.brandId,
      revision: parsed.proposedRevision,
      summary: parsed.revisionSummary ?? "Revised via Brand Brain chat",
      userId,
    });

    await CommandRepository.create({
      workspaceId: access.workspaceId,
      projectId,
      brandId: command.brandId,
      topic: BRAND_BRAIN_TOPIC,
      source: "SYSTEM",
      rawText: "",
      parsedIntent: { applied: true, commandId },
    }).then((row) =>
      CommandRepository.recordReply(
        row.id,
        `✅ Brand Brain updated — v${activated.version} is now active.`,
        "ANSWERED",
      ),
    );

    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
