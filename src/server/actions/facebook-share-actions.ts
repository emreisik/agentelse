"use server";

import { prisma } from "@/lib/prisma";
import {
  deleteFacebookShareCore,
  editFacebookShareCore,
  shareCreativeToFacebookCore,
  type FacebookShareResult,
} from "@/server/commands/facebook-share";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type { FacebookShareResult };

// The creative card's Facebook row (facebook-share-row.tsx) changes a share
// through these; it reads the share's state from
// /api/creatives/[creativeId]/facebook-share instead. Like the other card
// actions they only know the creativeId: the project comes from the Creative
// row, and access is checked against it before anything is read.

const NOT_FOUND: FacebookShareResult = {
  ok: false,
  message: "Creative not found.",
};

async function scopeOf(creativeId: unknown) {
  const { userId } = await requireUser();
  if (typeof creativeId !== "string" || !creativeId) return null;
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

// Another workspace's creative reads exactly like a missing one, and an
// unexpected error is logged rather than handed to the browser.
function failed(error: unknown): FacebookShareResult {
  if (isAgentelseError(error)) return NOT_FOUND;
  console.error("[facebook-share] action failed:", error);
  return { ok: false, message: "Something went wrong, please try again." };
}

export async function shareCreativeToFacebookAction(
  creativeId: string,
): Promise<FacebookShareResult> {
  try {
    const scope = await scopeOf(creativeId);
    if (!scope) return NOT_FOUND;
    // No revalidatePath: a share changes nothing else on the page (the piece's
    // status and publish line stay as they are), and re-rendering the project
    // would only keep the client's action queue busy longer.
    return await shareCreativeToFacebookCore(scope);
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
    if (!scope) return NOT_FOUND;
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
    if (!scope) return NOT_FOUND;
    return await deleteFacebookShareCore(scope);
  } catch (error) {
    return failed(error);
  }
}
