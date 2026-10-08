"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { cleanTags } from "@/lib/brand-media";
import { MEDIA_MAX_UPLOAD_BYTES } from "@/lib/brand-media";
import { isRateLimited } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { analyzeBrandMedia } from "@/server/brand/media/analyze";
import { makePhotoPost } from "@/server/brand/media/photo-post";
import { addBrandPhoto } from "@/server/brand/media/store";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { deleteAsset } from "@/server/storage/asset-storage";
import type { ActionResult } from "@/components/shared/action-form";
import {
  authorizeWorks,
  guardedAction,
  refreshWorkPages,
  validId,
  type GuardFail,
} from "@/server/works/guard";

// The brand's own photos (docs/brand-media.md): adding, tagging, archiving and
// removing them. Every action takes the project from the caller's access and
// looks each row up inside it, never by id alone.

export type UploadPhotoResult =
  | { ok: true; mediaId: string; duplicate: boolean }
  | { ok: false; message: string };

// One photo per call (the client sends them one by one), so a big batch stays
// under the request size limit and each file reports for itself.
export async function uploadBrandPhotoAction(
  formData: FormData,
): Promise<UploadPhotoResult> {
  const projectId = String(formData.get("projectId") ?? "");
  const file = formData.get("file");
  const consent = formData.get("consent") === "yes";
  if (!projectId || !(file instanceof File) || file.size === 0) {
    return { ok: false, message: "No photo selected." };
  }
  if (!consent) {
    return {
      ok: false,
      message:
        "Confirm that you have the right to use these photos, and the permission of the people in them.",
    };
  }
  if (file.size > MEDIA_MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `${file.name} is too large (limit ${MEDIA_MAX_UPLOAD_BYTES / 1024 / 1024} MB).`,
    };
  }

  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (isRateLimited(`brand-media:${userId}`, 120, 10 * 60_000)) {
    return { ok: false, message: "Too many photos at once. Try again in a few minutes." };
  }

  const result = await addBrandPhoto({
    scope: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
    },
    bytes: Buffer.from(await file.arrayBuffer()),
    filename: file.name,
  });
  if (!result.ok) return { ok: false, message: `${file.name}: ${result.reason}` };

  // Read the photo right away; the worker picks it up if this does not run
  // (a restart, no request scope) or fails.
  if (!result.duplicate) {
    try {
      after(() => analyzeBrandMedia(result.mediaId).catch(() => undefined));
    } catch {
      // Outside a request scope: the worker's tick step does it.
    }
  }
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, mediaId: result.mediaId, duplicate: result.duplicate };
}

async function mediaOf(projectId: string, mediaId: string) {
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  const media = await prisma.brandMedia.findFirst({
    where: { id: mediaId, projectId },
  });
  return { userId, access, media };
}

export async function updateBrandMediaTagsAction(
  projectId: string,
  mediaId: string,
  input: { tags: string[]; description?: string },
): Promise<ActionResult> {
  try {
    const { media } = await mediaOf(projectId, mediaId);
    if (!media) return { ok: false, message: "Photo not found." };
    await prisma.brandMedia.update({
      where: { id: media.id },
      data: {
        tags: cleanTags(input.tags),
        // Tags a person wrote are kept through any later re-analysis.
        tagsEdited: true,
        ...(input.description !== undefined
          ? { description: input.description.trim().slice(0, 300) || null }
          : {}),
      },
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save the tags",
    };
  }
}

export async function archiveBrandMediaAction(
  projectId: string,
  mediaId: string,
  archived: boolean,
): Promise<ActionResult> {
  try {
    const { media } = await mediaOf(projectId, mediaId);
    if (!media) return { ok: false, message: "Photo not found." };
    await prisma.brandMedia.update({
      where: { id: media.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not update the photo",
    };
  }
}

export async function reanalyzeBrandMediaAction(
  projectId: string,
  mediaId: string,
): Promise<ActionResult> {
  try {
    const { media } = await mediaOf(projectId, mediaId);
    if (!media) return { ok: false, message: "Photo not found." };
    await prisma.brandMedia.update({
      where: { id: media.id },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: null },
    });
    try {
      after(() => analyzeBrandMedia(media.id).catch(() => undefined));
    } catch {
      // The worker's tick step does it.
    }
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not read the photo again",
    };
  }
}

// Removes a photo for good, file included. Only one no post has used: a post
// made from a photo keeps pointing at it (to be re-cropped or regenerated), so
// that photo can be archived but not deleted.
export async function deleteBrandMediaAction(
  projectId: string,
  mediaId: string,
): Promise<ActionResult> {
  try {
    const { userId, access, media } = await mediaOf(projectId, mediaId);
    if (!media) return { ok: false, message: "Photo not found." };
    if (media.useCount > 0) {
      return {
        ok: false,
        message:
          "Posts were made from this photo, so it can't be deleted. Archive it instead.",
      };
    }
    const asset = await prisma.asset.findFirst({
      where: { id: media.assetId, projectId },
      select: { id: true, storageKey: true },
    });
    await prisma.brandMedia.delete({ where: { id: media.id } });
    if (asset) {
      await prisma.asset.delete({ where: { id: asset.id } });
      await deleteAsset(asset.storageKey).catch(() => undefined);
    }
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "brand_media.deleted",
      entityType: "BrandMedia",
      entityId: media.id,
    }).catch(() => undefined);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not delete the photo",
    };
  }
}

export type MakePhotoPostActionResult =
  | { ok: true; workId: string }
  | { ok: false; code: string; message: string }
  | GuardFail;

// "Make a post from this photo": a Social chat with the photo's post ready to
// make (server/brand/media/photo-post.ts). The photo is looked up inside the
// project, never by id alone.
export async function makePhotoPostAction(
  projectId: string,
  assetId: string,
): Promise<MakePhotoPostActionResult> {
  return guardedAction(
    "media-make-post",
    async (): Promise<MakePhotoPostActionResult> => {
      const gate = await authorizeWorks(projectId, {
        bucket: "media-make-post",
        limit: 40,
      });
      if (!gate.ok) return gate;
      if (!validId(assetId)) {
        return { ok: false, code: "INVALID", message: "That didn't work. Try again." };
      }
      const result = await makePhotoPost({
        projectId,
        assetId,
        userId: gate.auth.userId,
        workspaceId: gate.auth.workspaceId,
      });
      if (!result.ok) return result;
      refreshWorkPages(projectId, [`/projects/${projectId}/takvim`]);
      return { ok: true, workId: result.workId };
    },
  );
}
