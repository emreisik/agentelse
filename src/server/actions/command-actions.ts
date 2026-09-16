"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { CommandService } from "@/server/commands/command-service";
import { ChatService } from "@/server/commands/chat-service";
import { putAsset } from "@/server/storage/asset-storage";
import type { CommandAttachment } from "@/server/repositories/command.repository";
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

// Types understood by the reasoning backend's inline attachments. Images
// can also be used as creative editing input; documents only provide
// context.
const CHAT_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
};
const MAX_CHAT_FILE_SIZE = 8 * 1024 * 1024; // below the inlineData request limit
const MAX_CHAT_FILES = 4;

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
  if (files.length > MAX_CHAT_FILES) {
    return {
      ok: false,
      message: `You can attach at most ${MAX_CHAT_FILES} files.`,
    };
  }
  for (const file of files) {
    if (!CHAT_MIME_TO_EXT[file.type]) {
      return {
        ok: false,
        message: `Unsupported file type: ${file.name}. Attach an image (PNG/JPG/WebP), PDF, or text file.`,
      };
    }
    if (file.size > MAX_CHAT_FILE_SIZE) {
      return {
        ok: false,
        message: `${file.name} is too large (limit ${MAX_CHAT_FILE_SIZE / 1024 / 1024} MB).`,
      };
    }
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  // Write files to storage + the Asset table; extract the base64 body from
  // the same read so it goes to the reasoning backend without a second
  // round-trip.
  const attachments: CommandAttachment[] = [];
  const attachmentBodies: { mimeType: string; data: string }[] = [];

  for (const file of files) {
    const ext = CHAT_MIME_TO_EXT[file.type]!;
    const buffer = Buffer.from(await file.arrayBuffer());
    const { storageKey, filename } = await putAsset(buffer, ext, file.type);

    const asset = await prisma.asset.create({
      data: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        type: file.type.startsWith("image/") ? "IMAGE" : "DOCUMENT",
        source: "CUSTOMER_UPLOAD",
        filename,
        mimeType: file.type,
        storageKey,
        size: file.size,
      },
    });

    attachments.push({
      assetId: asset.id,
      // The original name is shown to the user; the on-disk name is always a UUID.
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    });
    attachmentBodies.push({
      mimeType: file.type,
      data: buffer.toString("base64"),
    });
  }

  try {
    const result = await ChatService.turn({
      workspaceId: access.workspaceId,
      projectId,
      userId,
      message: text || "(file only, no message text)",
      attachments,
      attachmentBodies,
      ideaId: typeof ideaId === "string" && ideaId ? ideaId : undefined,
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
