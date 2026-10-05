"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { shareCreativeToFacebookCore } from "@/server/commands/facebook-share";
import {
  publishCreativeCore,
  publishCreativeToSocialCore,
} from "@/server/commands/publish-creative";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The post-level actions (docs/works.md "Posts"): one idea, one post, delivered
// to its channels. Each works through the per-delivery paths that already
// exist (approval, publishing), so a post behaves exactly like its channels
// handled one by one, only in one tap.

export type PostActionResult =
  { ok: true; message?: string } | { ok: false; message: string };

const NOT_FOUND = "This post is no longer here.";
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

async function postForUser(postId: unknown) {
  if (typeof postId !== "string" || !ID_SHAPE.test(postId)) return null;
  const { userId } = await requireUser();
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, projectId: true },
  });
  if (!post) return null;
  const access = await requireProjectAccess(userId, post.projectId);
  return { post, userId, workspaceId: access.workspaceId };
}

function failed(error: unknown): PostActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Operation failed",
  };
}

// One Approve for the whole post: its first waiting channel is approved
// through the usual decision, which approves the post's other channels with it
// (approval-decisions.ts approveRestOfPost). Every channel left in the post
// must have its content first.
export async function approvePostAction(
  postId: string,
): Promise<PostActionResult> {
  try {
    const found = await postForUser(postId);
    if (!found) return { ok: false, message: NOT_FOUND };
    const { post, userId } = found;

    const deliveries = await prisma.creative.findMany({
      where: { postId: post.id, excludedAt: null, status: { not: "ARCHIVED" } },
      select: { id: true, status: true },
    });
    if (deliveries.some((delivery) => delivery.status === "DRAFT")) {
      return {
        ok: false,
        message: "Every channel of this post needs its content first.",
      };
    }
    const approval = await prisma.approval.findFirst({
      where: {
        projectId: post.projectId,
        entityType: "Creative",
        entityId: { in: deliveries.map((delivery) => delivery.id) },
        status: "PENDING",
      },
      orderBy: { createdAt: "asc" },
    });
    if (!approval) {
      return { ok: false, message: "Nothing in this post is waiting for you." };
    }
    await applyApprovalDecision({
      approval,
      to: "APPROVED",
      reviewedByUserId: userId,
      actorType: "USER",
    });
    revalidatePath(`/projects/${post.projectId}`);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

// A channel out of its post, or back in. Out: it is never made, approved or
// posted. Back in: the post waits for this channel's approval again. A post
// keeps at least one channel, and a posted channel stays as it is.
export async function setDeliveryExcludedAction(
  creativeId: string,
  excluded: boolean,
): Promise<PostActionResult> {
  try {
    if (
      typeof creativeId !== "string" ||
      !ID_SHAPE.test(creativeId) ||
      typeof excluded !== "boolean"
    ) {
      return { ok: false, message: NOT_FOUND };
    }
    const { userId } = await requireUser();
    const creative = await prisma.creative.findUnique({
      where: { id: creativeId },
      select: { projectId: true, postId: true, status: true, excludedAt: true },
    });
    if (!creative?.postId) return { ok: false, message: NOT_FOUND };
    await requireProjectAccess(userId, creative.projectId);
    if (creative.status === "PUBLISHED") {
      return { ok: false, message: "This channel is already posted." };
    }
    if (Boolean(creative.excludedAt) === excluded) return { ok: true };

    if (excluded) {
      const others = await prisma.creative.count({
        where: {
          postId: creative.postId,
          id: { not: creativeId },
          excludedAt: null,
          status: { not: "ARCHIVED" },
        },
      });
      if (others === 0) {
        return { ok: false, message: "A post keeps at least one channel." };
      }
    }
    await prisma.$transaction([
      prisma.creative.update({
        where: { id: creativeId },
        data: { excludedAt: excluded ? new Date() : null },
      }),
      // Back in, the post is no longer fully approved.
      ...(excluded
        ? []
        : [
            prisma.post.update({
              where: { id: creative.postId },
              data: { approvedAt: null, approvedByUserId: null },
            }),
          ]),
    ]);
    revalidatePath(`/projects/${creative.projectId}`);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

const SOCIAL_CHANNELS = new Set(["tiktok", "linkedin", "x"]);

// Post now: every approved channel of the post goes out now, each through its
// own channel's publish path (with its own locks and refusals). Hand-posted
// formats (carousel, reel) stay with the person.
export async function publishPostNowAction(
  postId: string,
): Promise<PostActionResult> {
  try {
    const found = await postForUser(postId);
    if (!found) return { ok: false, message: NOT_FOUND };
    const { post, userId, workspaceId } = found;

    const deliveries = await prisma.creative.findMany({
      where: { postId: post.id, excludedAt: null, status: "APPROVED" },
      select: { id: true, channel: true, formatKey: true },
    });
    if (deliveries.length === 0) {
      return { ok: false, message: "Approve the post before posting it." };
    }
    const scope = {
      workspaceId,
      projectId: post.projectId,
      actorUserId: userId,
    };
    const refusals: string[] = [];
    for (const delivery of deliveries) {
      const result =
        delivery.channel === "facebook"
          ? await shareCreativeToFacebookCore({
              ...scope,
              creativeId: delivery.id,
            })
          : delivery.channel === "instagram"
            ? delivery.formatKey === "instagram.post" ||
              delivery.formatKey === "instagram.story"
              ? await publishCreativeCore({
                  ...scope,
                  creativeId: delivery.id,
                  format:
                    delivery.formatKey === "instagram.story"
                      ? "STORIES"
                      : "FEED",
                })
              : { ok: false, message: "This format is posted by hand." }
            : delivery.channel && SOCIAL_CHANNELS.has(delivery.channel)
              ? await publishCreativeToSocialCore({
                  ...scope,
                  creativeId: delivery.id,
                  platform: delivery.channel as "tiktok" | "linkedin" | "x",
                })
              : { ok: false, message: "This channel is posted by hand." };
      if (!result.ok) refusals.push(result.message);
    }
    revalidatePath(`/projects/${post.projectId}`);
    return refusals.length === deliveries.length
      ? { ok: false, message: refusals[0] ?? "Nothing could be posted." }
      : { ok: true, ...(refusals.length ? { message: refusals[0] } : {}) };
  } catch (error) {
    return failed(error);
  }
}
