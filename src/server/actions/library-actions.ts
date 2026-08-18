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
import type { ActionResult } from "@/components/shared/action-form";

// Direct file upload to the Library panel — the same allowed type set as the
// chat attachment's CHAT_MIME_TO_EXT (command-actions.ts), because both have
// to pass through the same /api/assets/[assetId]/route.ts SAFE_FILENAME
// regex. The chat-specific size/count limits (inlineData request) don't
// apply here — a single file with a higher limit is enough.
const LIBRARY_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
};
const MAX_LIBRARY_FILE_SIZE = 20 * 1024 * 1024;
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

export async function uploadLibraryAssetAction(
  formData: FormData,
): Promise<ActionResult> {
  const projectId = String(formData.get("projectId") ?? "");
  const file = formData.get("file");
  if (!projectId || !(file instanceof File) || file.size === 0) {
    return { ok: false, message: "No file selected." };
  }

  const ext = LIBRARY_MIME_TO_EXT[file.type];
  if (!ext) {
    return {
      ok: false,
      message: `Unsupported file type: ${file.name}. Upload an image (PNG/JPG/WebP), PDF, or text file (TXT/CSV/MD).`,
    };
  }
  if (file.size > MAX_LIBRARY_FILE_SIZE) {
    return {
      ok: false,
      message: `${file.name} is too large (limit ${MAX_LIBRARY_FILE_SIZE / 1024 / 1024} MB).`,
    };
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  await mkdir(LOCAL_ASSETS_DIR, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(
    path.join(LOCAL_ASSETS_DIR, filename),
    Buffer.from(await file.arrayBuffer()),
  );

  await prisma.asset.create({
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

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
