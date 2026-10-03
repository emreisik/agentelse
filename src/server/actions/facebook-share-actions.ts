"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  deleteFacebookShareCore,
  editFacebookShareCore,
  readFacebookShareState,
  shareCreativeToFacebookCore,
  type FacebookShareResult,
  type FacebookShareState,
} from "@/server/commands/facebook-share";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type { FacebookShareResult, FacebookShareState };

// The creative card's Facebook row (facebook-share-row.tsx). Like the other
// card actions it only knows the creativeId: the project comes from the
// Creative row, and access is checked against it before anything is read.
async function scopeOf(creativeId: string) {
  const { userId } = await requireUser();
  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { projectId: true },
  });
  if (!creative) return null;
  const access = await requireProjectAccess(userId, creative.projectId);
  return {
    creativeId,
    projectId: creative.projectId,
    workspaceId: access.workspaceId,
    actorUserId: userId,
  };
}

function failed(error: unknown): FacebookShareResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Something went wrong.",
  };
}

export async function getFacebookShareAction(
  creativeId: string,
): Promise<FacebookShareState> {
  try {
    const scope = await scopeOf(creativeId);
    if (!scope) return { kind: "unavailable" };
    return await readFacebookShareState(scope.projectId, creativeId);
  } catch (error) {
    console.error("[facebook-share] reading the share state failed:", error);
    return { kind: "unavailable" };
  }
}

export async function shareCreativeToFacebookAction(
  creativeId: string,
): Promise<FacebookShareResult> {
  try {
    const scope = await scopeOf(creativeId);
    if (!scope) return { ok: false, message: "Creative not found." };
    const result = await shareCreativeToFacebookCore(scope);
    revalidatePath(`/projects/${scope.projectId}`);
    return result;
  } catch (error) {
    return failed(error);
  }
}

export async function editFacebookPostAction(
  creativeId: string,
  message: string,
): Promise<FacebookShareResult> {
  try {
    const scope = await scopeOf(creativeId);
    if (!scope) return { ok: false, message: "Creative not found." };
    return await editFacebookShareCore({ ...scope, message: String(message) });
  } catch (error) {
    return failed(error);
  }
}

export async function deleteFacebookPostAction(
  creativeId: string,
): Promise<FacebookShareResult> {
  try {
    const scope = await scopeOf(creativeId);
    if (!scope) return { ok: false, message: "Creative not found." };
    return await deleteFacebookShareCore(scope);
  } catch (error) {
    return failed(error);
  }
}
