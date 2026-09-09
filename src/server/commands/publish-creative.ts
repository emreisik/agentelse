import "server-only";

import { prisma } from "@/lib/prisma";
import { CommandService } from "@/server/commands/command-service";
import { CommandRepository } from "@/server/repositories/command.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { buildAssetPublicUrl } from "@/server/security/asset-public-link";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";

export type PublishQuickActionResult =
  { ok: true; message: string } | { ok: false; message: string };

// The core logic shared by publishCreativeToInstagramAction
// (src/server/actions/publish-actions.ts, web/session-based) AND the
// Telegram callback (telegram-approval-poller.ts, sessionless background
// context). Deliberately NOT marked "use server" — this isn't a Server
// Action, it's a plain server-side function; there's NO requireUser() here,
// the caller (the web action or the poller) does its own authorization and
// passes workspaceId/projectId/actorUserId already validated. The same
// logic as applyApprovalDecision's "telegram:<id>" pseudo-user pattern for
// reviewedByUserId applies here for actorUserId too.
export async function publishCreativeCore(input: {
  creativeId: string;
  format: "FEED" | "STORIES";
  workspaceId: string;
  projectId: string;
  actorUserId: string;
}): Promise<PublishQuickActionResult> {
  const { creativeId, format, workspaceId, projectId, actorUserId } = input;

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!creative) return { ok: false, message: "Creative not found." };

  const targets = await getPublishTargets(projectId);
  if (targets.length === 0) {
    return {
      ok: false,
      message: "There's no connected Meta page with an Instagram account.",
    };
  }

  const version = creative.versions[0];
  if (!version?.assetId) {
    return {
      ok: false,
      message: "This creative has no image to publish.",
    };
  }

  const ideaId = creative.createdByTaskId
    ? await IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId)
    : null;

  const imageUrl = await buildAssetPublicUrl(version.assetId);
  const caption = version.caption || version.copy || "";
  const title = creative.title ?? "Creative";
  const formatLabel = format === "STORIES" ? "story" : "post";

  const submission = await CommandService.submit({
    workspaceId,
    source: "WEB",
    rawText: `Publish on Instagram (${formatLabel}): ${title}`,
    actorType: "USER",
    userId: actorUserId,
    knownProjectId: projectId,
    ideaId: ideaId ?? undefined,
    departmentKey: "SOCIAL_MEDIA",
    intent: {
      kind: "CAPABILITY",
      capability: "INSTAGRAM_PUBLISH",
      targetPlatform: "INSTAGRAM",
      request: `${title} — Instagram ${formatLabel} publish`,
    },
    payloadExtra: {
      imageUrl,
      caption,
      targetFormat: format === "STORIES" ? "STORIES" : undefined,
      // Read back by the completion handler below to flip THIS Creative to
      // PUBLISHED once the post actually goes live — the provider itself
      // ignores unknown payload fields, confirmed against
      // meta-api-provider.ts's INSTAGRAM_PUBLISH handling.
      creativeId,
    },
  });

  const reply =
    submission.status === "PLANNED"
      ? submission.requiresApproval
        ? `📤 Instagram ${formatLabel} publish sent for approval.`
        : `📤 Instagram ${formatLabel} publish queued.`
      : "Failed to create the publish request.";
  await CommandRepository.recordReply(
    submission.commandId,
    reply,
    submission.status === "PLANNED" ? "PLANNED" : "ERROR",
  );

  if (submission.status !== "PLANNED") {
    return { ok: false, message: "Failed to create the publish request." };
  }
  return { ok: true, message: reply };
}

const SOCIAL_PUBLISH_CONFIG = {
  tiktok: {
    label: "TikTok",
    capability: "TIKTOK_PUBLISH",
    targetPlatform: "TIKTOK",
  },
  linkedin: {
    label: "LinkedIn",
    capability: "LINKEDIN_PUBLISH",
    targetPlatform: "LINKEDIN",
  },
  x: { label: "X", capability: "X_PUBLISH", targetPlatform: "X" },
} as const;

// The shared core for TikTok/LinkedIn/X, alongside publishCreativeCore
// (Instagram-only — its capability/payload shape is fixed). Differs from
// the Instagram version: TikTok requires a video asset (videoUrl, not
// imageUrl), while LinkedIn/X only need text (caption) — an image/video
// isn't required. publishCreativeCore is left UNTOUCHED (also called by the
// Telegram poller, a function whose behavior must stay fixed) — hence a
// separate function that repeats the shared `submit + reply` skeleton.
export async function publishCreativeToSocialCore(input: {
  creativeId: string;
  platform: "tiktok" | "linkedin" | "x";
  workspaceId: string;
  projectId: string;
  actorUserId: string;
}): Promise<PublishQuickActionResult> {
  const { creativeId, platform, workspaceId, projectId, actorUserId } = input;
  const config = SOCIAL_PUBLISH_CONFIG[platform];

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        include: { asset: true },
      },
    },
  });
  if (!creative) return { ok: false, message: "Creative not found." };

  const targets = await getPublishTargets(projectId);
  const hasTarget = targets.some((t) => t.platform === platform);
  if (!hasTarget) {
    return {
      ok: false,
      message: `There's no connected ${config.label} account.`,
    };
  }

  const version = creative.versions[0];
  const caption = version?.caption || version?.copy || "";

  // creativeId read back by the same completion handler that watches
  // INSTAGRAM_PUBLISH (see the module comment on that field above) — flips
  // this Creative to PUBLISHED once the post actually goes live.
  const payloadExtra: Record<string, unknown> = { caption, creativeId };
  if (platform === "tiktok") {
    if (!version || !version.asset || version.asset.type !== "VIDEO") {
      return {
        ok: false,
        message: "This creative has no video to publish to TikTok.",
      };
    }
    payloadExtra.videoUrl = await buildAssetPublicUrl(version.asset.id);
  } else if (!caption) {
    return { ok: false, message: "This creative has no text to publish." };
  }

  const ideaId = creative.createdByTaskId
    ? await IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId)
    : null;
  const title = creative.title ?? "Creative";

  const submission = await CommandService.submit({
    workspaceId,
    source: "WEB",
    rawText: `Publish on ${config.label}: ${title}`,
    actorType: "USER",
    userId: actorUserId,
    knownProjectId: projectId,
    ideaId: ideaId ?? undefined,
    departmentKey: "SOCIAL_MEDIA",
    intent: {
      kind: "CAPABILITY",
      capability: config.capability,
      targetPlatform: config.targetPlatform,
      request: `${title} — ${config.label} publish`,
    },
    payloadExtra,
  });

  const reply =
    submission.status === "PLANNED"
      ? submission.requiresApproval
        ? `📤 ${config.label} publish sent for approval.`
        : `📤 ${config.label} publish queued.`
      : "Failed to create the publish request.";
  await CommandRepository.recordReply(
    submission.commandId,
    reply,
    submission.status === "PLANNED" ? "PLANNED" : "ERROR",
  );

  if (submission.status !== "PLANNED") {
    return { ok: false, message: "Failed to create the publish request." };
  }
  return { ok: true, message: reply };
}
