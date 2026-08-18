"use server";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { CommandService } from "@/server/commands/command-service";
import { ChatService } from "@/server/commands/chat-service";
import type { CommandAttachment } from "@/server/repositories/command.repository";

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
// Sohbet ekranı
// ---------------------------------------------------------------------------

// Gemini inlineData'nın anladığı türler. Görseller ayrıca kreatif düzenleme
// girdisi olarak kullanılabilir; belgeler yalnızca bağlam sağlar.
const CHAT_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
};
const MAX_CHAT_FILE_SIZE = 8 * 1024 * 1024; // inlineData istek sınırının altında
const MAX_CHAT_FILES = 4;
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

export type ChatMessageResult =
  | {
      ok: true;
      commandId: string;
      reply: string;
      attachments: { assetId: string; filename: string; mimeType: string }[];
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
    return { ok: false, message: "Mesaj boş." };
  }
  if (files.length > MAX_CHAT_FILES) {
    return {
      ok: false,
      message: `En fazla ${MAX_CHAT_FILES} dosya eklenebilir.`,
    };
  }
  for (const file of files) {
    if (!CHAT_MIME_TO_EXT[file.type]) {
      return {
        ok: false,
        message: `Desteklenmeyen dosya türü: ${file.name}. Görsel (PNG/JPG/WebP), PDF veya metin dosyası ekleyin.`,
      };
    }
    if (file.size > MAX_CHAT_FILE_SIZE) {
      return {
        ok: false,
        message: `${file.name} çok büyük (sınır ${MAX_CHAT_FILE_SIZE / 1024 / 1024} MB).`,
      };
    }
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  // Dosyaları diske + Asset tablosuna yaz; aynı okumadan base64 gövdeyi de
  // çıkar ki Gemini'ye ikinci bir disk turu olmadan gitsin.
  const attachments: CommandAttachment[] = [];
  const attachmentBodies: { mimeType: string; data: string }[] = [];

  if (files.length > 0) {
    await mkdir(LOCAL_ASSETS_DIR, { recursive: true });
  }
  for (const file of files) {
    const ext = CHAT_MIME_TO_EXT[file.type]!;
    const filename = `${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(LOCAL_ASSETS_DIR, filename), buffer);

    const asset = await prisma.asset.create({
      data: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        type: file.type.startsWith("image/") ? "IMAGE" : "DOCUMENT",
        filename,
        mimeType: file.type,
        storageKey: `local-asset://${filename}`,
        size: file.size,
      },
    });

    attachments.push({
      assetId: asset.id,
      // Orijinal ad kullanıcıya gösterilir; diskteki ad her zaman UUID.
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
      message: text || "(yalnızca dosya gönderildi)",
      attachments,
      attachmentBodies,
      ideaId: typeof ideaId === "string" && ideaId ? ideaId : undefined,
    });

    revalidatePath(`/projects/${projectId}`);
    return {
      ok: true,
      commandId: result.commandId,
      reply: result.reply,
      attachments: attachments.map(({ assetId, filename, mimeType }) => ({
        assetId,
        filename,
        mimeType,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Mesaj gönderilemedi",
    };
  }
}
