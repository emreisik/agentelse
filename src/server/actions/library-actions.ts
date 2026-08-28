"use server";

import { revalidatePath } from "next/cache";
import sharp from "sharp";

import { prisma } from "@/lib/prisma";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { putAsset } from "@/server/storage/asset-storage";
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
  // Added for TikTok publishing (see publish-creative.ts's
  // publishCreativeToSocialCore) — before this, AssetType.VIDEO was declared
  // in the Prisma schema but no upload path ever produced one, making the
  // TikTok publish flow permanently unreachable.
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};
const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const MAX_LIBRARY_FILE_SIZE = 20 * 1024 * 1024;
// Videos are inherently larger than the image/document assets this limit was
// sized for — TikTok's own content limits run into the hundreds of MB, so a
// higher ceiling avoids rejecting normal short-form video.
const MAX_VIDEO_FILE_SIZE = 200 * 1024 * 1024;

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
      message: `Unsupported file type: ${file.name}. Upload an image (PNG/JPG/WebP), video (MP4/MOV/WebM), PDF, or text file (TXT/CSV/MD).`,
    };
  }
  const isVideo = VIDEO_MIME_TYPES.has(file.type);
  const sizeLimit = isVideo ? MAX_VIDEO_FILE_SIZE : MAX_LIBRARY_FILE_SIZE;
  if (file.size > sizeLimit) {
    return {
      ok: false,
      message: `${file.name} is too large (limit ${sizeLimit / 1024 / 1024} MB).`,
    };
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);

  const buffer = Buffer.from(await file.arrayBuffer());
  const { storageKey, filename } = await putAsset(buffer, ext, file.type);

  const isImage = file.type.startsWith("image/");
  // Real pixel size, measured up front — this is what the TikTok
  // aspect-ratio check in createCreativeFromLibraryAssetAction (and the
  // "N x M px" note wherever this asset later shows up as a creative) reads.
  // Video dimensions aren't probed here (would need ffprobe, not sharp) —
  // width/height stay null for VIDEO/DOCUMENT rows.
  const dimensions = isImage
    ? await sharp(buffer)
        .metadata()
        .then((meta) => ({ width: meta.width, height: meta.height }))
        .catch(() => ({ width: undefined, height: undefined }))
    : { width: undefined, height: undefined };

  const asset = await prisma.asset.create({
    data: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      type: isImage ? "IMAGE" : isVideo ? "VIDEO" : "DOCUMENT",
      source: "CUSTOMER_UPLOAD",
      filename,
      mimeType: file.type,
      storageKey,
      size: file.size,
      width: dimensions.width,
      height: dimensions.height,
    },
  });

  // A customer-provided video is real, ready-to-publish content — feed it
  // into the same Signal -> Insight -> Opportunity -> Idea funnel every
  // other signal source uses instead of leaving it sitting in the library
  // until someone remembers to do something with it. Goes through the
  // normal council/director gate (not an automatic publish) since customer
  // content still needs a brand-safety/quality check before it goes out.
  if (isVideo) {
    await SignalUniverse.ingestRaw({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      source: "customer-video-upload",
      category: "CUSTOMER",
      externalRef: `asset:${asset.id}`,
      title: `New customer video: ${file.name}`,
      summary: `A customer-provided video ("${file.name}") was uploaded to the library and may be worth publishing.`,
      payload: { assetId: asset.id },
      reliability: 1,
    }).catch((error) => {
      console.error(
        `[library-actions] Failed to ingest signal for video asset ${asset.id}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
