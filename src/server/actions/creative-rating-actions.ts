"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { isRateLimited } from "@/lib/rate-limit";
import {
  MAX_RATING_NOTE_CHARS,
  RATINGS,
  cleanReasons,
  type CreativeRating,
} from "@/lib/creative-rating";
import { addExampleFromAsset } from "@/server/brand/post-style-service";
import { getExample } from "@/server/brand/post-style-store";
import { MemoryService } from "@/server/memory/memory-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The client's verdict on a finished post (like / not quite) and, for a liked
// post, the one-tap way to make it an example of the brand's Post Style Kit. The
// post is looked up first and the user's access checked against ITS project.

const RATE = { key: "creative-rating", max: 60, windowMs: 10 * 60_000 };
const ADD_RATE = { key: "creative-example", max: 12, windowMs: 10 * 60_000 };

export type RateCreativeResult =
  | {
      ok: true;
      // A liked post with a picture that is not an example yet.
      canAddExample: boolean;
    }
  | { ok: false; message: string };

export type AddLikedExampleResult =
  | { ok: true }
  | { ok: false; message: string };

const FAILED = "That didn't work. Try again.";

async function creativeScope(creativeId: unknown) {
  if (typeof creativeId !== "string" || !creativeId || creativeId.length > 64) {
    return null;
  }
  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: {
      id: true,
      projectId: true,
      title: true,
      status: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { assetId: true },
      },
    },
  });
  if (!creative) return null;
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, creative.projectId);
  return {
    userId,
    creative,
    assetId: creative.versions[0]?.assetId ?? null,
    scope: {
      workspaceId: access.workspaceId,
      projectId: creative.projectId,
      brandId: access.defaultBrandId,
    },
  };
}

export async function rateCreativeAction(input: {
  creativeId: string;
  rating: string;
  reasons?: string[];
  note?: string;
}): Promise<RateCreativeResult> {
  try {
    if (!(RATINGS as readonly string[]).includes(input?.rating)) {
      return { ok: false, message: FAILED };
    }
    const found = await creativeScope(input.creativeId);
    if (!found) return { ok: false, message: "That post isn't available." };
    const { userId, scope, creative, assetId } = found;
    if (isRateLimited(`${RATE.key}:${userId}`, RATE.max, RATE.windowMs)) {
      return { ok: false, message: "Slow down for a moment." };
    }
    const rating = input.rating as CreativeRating;
    const note =
      typeof input.note === "string"
        ? input.note.replace(/\s+/g, " ").trim().slice(0, MAX_RATING_NOTE_CHARS)
        : undefined;
    const remembered = await MemoryService.rememberCreativeRating({
      scope,
      creativeId: creative.id,
      rating,
      reasons: Array.isArray(input.reasons) ? cleanReasons(input.reasons) : [],
      note,
    });
    await AuditLogRepository.record({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      actorType: "USER",
      actorId: userId,
      action: "creative.rated",
      entityType: "Creative",
      entityId: creative.id,
      metadata: { rating, learned: remembered !== null },
    }).catch(() => undefined);
    revalidatePath(`/projects/${scope.projectId}`);

    const alreadyExample =
      rating === "LIKE" && assetId
        ? (await getExample(scope.brandId, assetId)) !== null
        : false;
    return {
      ok: true,
      canAddExample: rating === "LIKE" && Boolean(assetId) && !alreadyExample,
    };
  } catch (error) {
    console.error(
      "[creative-rating] failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: FAILED };
  }
}

export async function addLikedCreativeToPostStyleAction(input: {
  creativeId: string;
}): Promise<AddLikedExampleResult> {
  try {
    const found = await creativeScope(input?.creativeId);
    if (!found) return { ok: false, message: "That post isn't available." };
    const { userId, scope, creative, assetId } = found;
    if (!assetId) {
      return { ok: false, message: "This post has no picture to use as an example." };
    }
    if (isRateLimited(`${ADD_RATE.key}:${userId}`, ADD_RATE.max, ADD_RATE.windowMs)) {
      return { ok: false, message: "Slow down for a moment." };
    }
    const result = await addExampleFromAsset({
      scope,
      assetId,
      label: creative.title ?? undefined,
      source: "liked",
    });
    if (!result.ok) return { ok: false, message: result.reason };
    revalidatePath(`/projects/${scope.projectId}`);
    return { ok: true };
  } catch (error) {
    console.error(
      "[creative-rating] add example failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: FAILED };
  }
}
