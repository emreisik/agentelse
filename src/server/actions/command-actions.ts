"use server";

import { revalidatePath } from "next/cache";

import { getEnv } from "@/lib/env";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { CommandService } from "@/server/commands/command-service";
import { ChatService } from "@/server/commands/chat-service";
import { storeChatFiles, validateChatFiles } from "@/server/chat/attachments";
import type { IdeaEventCardData } from "@/types/idea-event-card";

export async function submitProjectCommandAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return;

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  await CommandService.submit({
    workspaceId: access.workspaceId,
    source: "WEB",
    rawText: text,
    actorType: "USER",
    userId,
    knownProjectId: projectId,
  });

  revalidatePath(`/projects/${projectId}`);
}

// ---------------------------------------------------------------------------
// Chat screen
// ---------------------------------------------------------------------------

export type ChatMessageResult =
  | {
      ok: true;
      commandId: string;
      reply: string;
      attachments: { assetId: string; filename: string; mimeType: string }[];
      // Structured chat card (e.g. limit-notice) — rendered by the client
      // in place of the plain reply text (see ChatTurnResult.card).
      card?: IdeaEventCardData;
    }
  | { ok: false; message: string };

export async function submitChatMessageAction(
  formData: FormData,
): Promise<ChatMessageResult> {
  const projectId = String(formData.get("projectId"));
  const ideaId = formData.get("ideaId");
  const text = String(formData.get("text") ?? "").trim();
  const files = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (!text && files.length === 0) {
    return { ok: false, message: "Message is empty." };
  }
  const fileError = validateChatFiles(files);
  if (fileError) return { ok: false, message: fileError };

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  const { attachments, attachmentBodies } = await storeChatFiles(files, {
    workspaceId: access.workspaceId,
    projectId,
    brandId: access.defaultBrandId,
  });

  try {
    const result = await ChatService.turn({
      workspaceId: access.workspaceId,
      projectId,
      userId,
      message: text || "(file only, no message text)",
      attachments,
      attachmentBodies,
      ideaId: typeof ideaId === "string" && ideaId ? ideaId : undefined,
      guidedSetup: getEnv().GUIDED_SETUP,
    });

    revalidatePath(`/projects/${projectId}`);
    return {
      ok: true,
      commandId: result.commandId,
      reply: result.reply,
      card: result.card,
      attachments: attachments.map(({ assetId, filename, mimeType }) => ({
        assetId,
        filename,
        mimeType,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Failed to send message",
    };
  }
}
