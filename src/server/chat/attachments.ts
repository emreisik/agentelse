import "server-only";

import { prisma } from "@/lib/prisma";
import type { CommandAttachment } from "@/server/repositories/command.repository";
import { putAsset } from "@/server/storage/asset-storage";

// File attachments of a chat message — shared by the legacy Server Action
// (command-actions.ts) and the streaming route handler, so both enforce the
// same limits and store files the same way.

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
export const MAX_CHAT_FILES = 4;

// Cheap, auth-free checks — run before any session or database work. Returns
// the user-facing error message, or null when the files are acceptable.
export function validateChatFiles(files: readonly File[]): string | null {
  if (files.length > MAX_CHAT_FILES) {
    return `You can attach at most ${MAX_CHAT_FILES} files.`;
  }
  for (const file of files) {
    if (!CHAT_MIME_TO_EXT[file.type]) {
      return `Unsupported file type: ${file.name}. Attach an image (PNG/JPG/WebP), PDF, or text file.`;
    }
    if (file.size > MAX_CHAT_FILE_SIZE) {
      return `${file.name} is too large (limit ${MAX_CHAT_FILE_SIZE / 1024 / 1024} MB).`;
    }
  }
  return null;
}

// Writes the (already validated) files to storage + the Asset table and
// returns the persisted references plus the base64 bodies that go to the
// model only — extracted from the same read, so no second round-trip.
export async function storeChatFiles(
  files: readonly File[],
  scope: { workspaceId: string; projectId: string; brandId: string },
): Promise<{
  attachments: CommandAttachment[];
  attachmentBodies: { mimeType: string; data: string }[];
}> {
  const attachments: CommandAttachment[] = [];
  const attachmentBodies: { mimeType: string; data: string }[] = [];

  for (const file of files) {
    const ext = CHAT_MIME_TO_EXT[file.type]!;
    const buffer = Buffer.from(await file.arrayBuffer());
    const { storageKey, filename } = await putAsset(buffer, ext, file.type);

    const asset = await prisma.asset.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
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

  return { attachments, attachmentBodies };
}
