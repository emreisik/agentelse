"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import {
  publishCreativeCore,
  publishCreativeToSocialCore,
  type PublishQuickActionResult,
} from "@/server/commands/publish-creative";
import {
  getPublishTargets,
  type PublishTarget,
} from "@/server/integrations/meta-connection-status";

export type { PublishQuickActionResult };

// Returns which accounts the "Share on Social Accounts" section of the
// approved creative card (see creative-card.tsx) will list. The card only
// knows the creativeId — just like approveApprovalAction/rejectApprovalAction
// work self-contained from approvalId, here too projectId is resolved from
// the Creative row, so the caller doesn't have to carry ideaId/projectId.
export async function getCreativePublishTargetsAction(
  creativeId: string,
): Promise<PublishTarget[]> {
  const { userId } = await requireUser();
  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { projectId: true },
  });
  if (!creative) return [];
  await requireProjectAccess(userId, creative.projectId);
  return getPublishTargets(creative.projectId);
}

// The card's "Publish" button — sends the CURRENT version of this creative
// to the connected Instagram account with the INSTAGRAM_PUBLISH capability
// (via CommandService, skipping the LLM with a directly pre-resolved
// intent). INSTAGRAM_PUBLISH is a capability that requires approval
// (execution-policy.ts) — so the result is not an INSTANT publish, but a
// task submitted for approval. The actual logic lives in
// publish-creative.ts — the Telegram callback (sessionless) also calls the
// same core; here we're only validating the web session.
export async function publishCreativeToInstagramAction(
  creativeId: string,
  format: "FEED" | "STORIES" = "FEED",
): Promise<PublishQuickActionResult> {
  const { userId } = await requireUser();

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { projectId: true },
  });
  if (!creative) return { ok: false, message: "Creative not found." };

  const access = await requireProjectAccess(userId, creative.projectId);

  const result = await publishCreativeCore({
    creativeId,
    format,
    workspaceId: access.workspaceId,
    projectId: creative.projectId,
    actorUserId: userId,
  });

  revalidatePath(`/projects/${creative.projectId}`);
  return result;
}

// The card's "Publish" button for TikTok/LinkedIn/X — same shape as
// publishCreativeToInstagramAction, delegates to
// publishCreativeToSocialCore (publish-creative.ts) which resolves the
// right capability/payload per platform. All three publish capabilities
// require approval (execution-policy.ts), same as Instagram.
export async function publishCreativeToSocialAction(
  creativeId: string,
  platform: "tiktok" | "linkedin" | "x",
): Promise<PublishQuickActionResult> {
  const { userId } = await requireUser();

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { projectId: true },
  });
  if (!creative) return { ok: false, message: "Creative not found." };

  const access = await requireProjectAccess(userId, creative.projectId);

  const result = await publishCreativeToSocialCore({
    creativeId,
    platform,
    workspaceId: access.workspaceId,
    projectId: creative.projectId,
    actorUserId: userId,
  });

  revalidatePath(`/projects/${creative.projectId}`);
  return result;
}
