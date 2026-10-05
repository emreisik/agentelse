import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { channelOfFormatKey, resolveFormat } from "@/lib/content-channels";
import { WORKS_COPY } from "@/lib/works/copy";
import { canPublishNow } from "@/lib/works/publish-guard";
import { isWorksEnabled } from "@/server/works/flag";
import { CommandService } from "@/server/commands/command-service";
import { CommandRepository } from "@/server/repositories/command.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { buildAssetPublicUrl } from "@/server/security/asset-public-link";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";

export type PublishQuickActionResult =
  | {
      ok: true;
      message: string;
      // True when the publish progress was mirrored onto an existing
      // creative-ready card (markCreativePublishState) — callers that would
      // otherwise post their own "published!" confirmation can skip it when
      // this is true, since the card already shows the outcome.
      cardUpdated: boolean;
    }
  | { ok: false; message: string };

// The core logic shared by publishCreativeToInstagramAction
// (src/server/actions/publish-actions.ts, web/session-based) AND the
// Telegram callback (telegram-approval-poller.ts, sessionless background
// context). Deliberately NOT marked "use server" — this isn't a Server
// Action, it's a plain server-side function; there's NO requireUser() here,
// the caller (the web action or the poller) does its own authorization and
// passes workspaceId/projectId/actorUserId already validated. The same
// logic as applyApprovalDecision's "telegram:<id>" pseudo-user pattern for
// reviewedByUserId applies here for actorUserId too.
type InstagramPublishInput = {
  creativeId: string;
  format: "FEED" | "STORIES";
  workspaceId: string;
  projectId: string;
  actorUserId: string;
};

export async function publishCreativeCore(
  input: InstagramPublishInput,
): Promise<PublishQuickActionResult> {
  if (!isWorksEnabled()) return publishInstagramCreative(input, null);
  // Works only: two tabs, two devices or a stale card serialize on the
  // creative, so a double Post now (or a queue tick racing one) cannot create
  // two publish Tasks. The lock is held until the transaction ends; the
  // in-flight check inside it sees the Task the first caller committed.
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.creativeId}))`;
      return publishInstagramCreative(input, tx);
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
}

// A channel left out of its post (docs/works.md "Posts") is never posted.
const EXCLUDED_MESSAGE = "This channel was left out of its post.";

const EXPLICIT_REFUSAL = {
  MANUAL_FORMAT:
    "This format is posted by hand, so it can't be sent to Instagram from here.",
  WRONG_PLATFORM: "This isn't an Instagram piece, so it can't be posted there.",
} as const;

// The format of a catalog Instagram piece comes from its formatKey, never from
// the (client supplied) argument: a feed piece must not go out as a story.
function formatFromCatalog(
  formatKey: string | null,
): "FEED" | "STORIES" | null {
  if (!formatKey) return null;
  const channel = channelOfFormatKey(formatKey);
  if (channel !== "instagram" || !resolveFormat(channel, formatKey)) {
    return null;
  }
  return formatKey === "instagram.story" ? "STORIES" : "FEED";
}

// `tx` is set only when Works is on (the caller holds the creative's advisory
// lock); flag off it is null and the body is the original one.
async function publishInstagramCreative(
  input: InstagramPublishInput,
  tx: Prisma.TransactionClient | null,
): Promise<PublishQuickActionResult> {
  const { creativeId, workspaceId, projectId, actorUserId } = input;

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!creative) return { ok: false, message: "Creative not found." };
  if (creative.excludedAt) return { ok: false, message: EXCLUDED_MESSAGE };
  // Works only: these three refusals close holes for every creative (another
  // project's piece, a piece nobody approved).
  if (tx && creative.projectId !== projectId) {
    return { ok: false, message: "Creative not found." };
  }

  const targets = await getPublishTargets(projectId);
  // Flag on: an Instagram target specifically (a LinkedIn-only project asked
  // to post to Instagram used to pass this check).
  const hasInstagramTarget = tx
    ? targets.some((t) => t.platform === "instagram")
    : targets.length > 0;
  if (!hasInstagramTarget) {
    return {
      ok: false,
      message: "There's no connected Instagram account.",
    };
  }
  if (tx && creative.status === "PUBLISHED") {
    return { ok: false, message: WORKS_COPY["publish.alreadyPosting"] };
  }
  if (tx && creative.status !== "APPROVED") {
    return { ok: false, message: WORKS_COPY["publish.notReady"] };
  }

  const version = creative.versions[0];
  if (!version?.assetId) {
    return {
      ok: false,
      message: "This creative has no image to publish.",
    };
  }

  if (tx) {
    // The explicit path (Post now, the Telegram Post / Story buttons) shares
    // the guard's format and platform rules: a hand-posted format (carousel,
    // reel) or another channel's piece is never sent to Instagram as a single
    // feed photo. A creative with no platform is a legacy piece and passes.
    const decision = canPublishNow(
      {
        status: creative.status,
        platform: creative.platform ?? "INSTAGRAM",
        formatKey: creative.formatKey,
        hasAsset: true,
        scheduledFor: creative.scheduledFor,
        connectedPlatforms: new Set(["instagram"]),
      },
      "explicit",
    );
    if (!decision.ok && decision.reason === "MANUAL_FORMAT") {
      return { ok: false, message: EXPLICIT_REFUSAL.MANUAL_FORMAT };
    }
    if (!decision.ok && decision.reason === "WRONG_PLATFORM") {
      return { ok: false, message: EXPLICIT_REFUSAL.WRONG_PLATFORM };
    }
  }

  const format = tx
    ? (formatFromCatalog(creative.formatKey) ?? input.format)
    : input.format;

  if (tx) {
    // A FAILED or CANCELLED Task does not block a deliberate retry.
    const publishTasks = await tx.task.findMany({
      where: {
        projectId,
        capability: "INSTAGRAM_PUBLISH",
        status: { notIn: ["FAILED", "CANCELLED"] },
      },
      select: { payload: true },
    });
    const taskInFlight = publishTasks.some(
      (task) =>
        (task.payload as { creativeId?: unknown } | null)?.creativeId ===
        creativeId,
    );
    if (taskInFlight) {
      return { ok: false, message: WORKS_COPY["publish.alreadyPosting"] };
    }
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
    // An APPROVED creative already had its human decision — publishing
    // it doesn't ask again (see TaskPlanner contentApproved).
    contentApproved: creative.status === "APPROVED",
    rawText: `Publish on Instagram (${formatLabel}): ${title}`,
    actorType: "USER",
    userId: actorUserId,
    knownProjectId: projectId,
    ideaId: ideaId ?? undefined,
    departmentKey: "SOCIAL_MEDIA",
    // Mirrored onto the creative-ready card below instead — this row is
    // kept off the general chat feed (Command.topic, see schema.prisma) so
    // the click doesn't also spawn its own bubble.
    topic: "PUBLISH_RELAY",
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

  const cardUpdated = await IdeaChatRepository.markCreativePublishState({
    taskId: submission.taskId,
    creativeId,
    publishState: submission.requiresApproval ? "queued" : "publishing",
  }).catch(() => false);
  // No matching creative-ready card to mirror onto (e.g. a taskless/batch
  // creative) — fall back to a normal, visible chat row instead of a
  // relay row nobody will ever see.
  if (!cardUpdated) {
    await prisma.command
      .update({ where: { id: submission.commandId }, data: { topic: null } })
      .catch(() => undefined);
  }

  return { ok: true, message: reply, cardUpdated };
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
// isn't required. Facebook is a cross-post with its own path
// (facebook-share.ts), not one of these. publishCreativeCore is left UNTOUCHED (also called by the
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
  if (creative.excludedAt) return { ok: false, message: EXCLUDED_MESSAGE };

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
    // An APPROVED creative already had its human decision — publishing
    // it doesn't ask again (see TaskPlanner contentApproved).
    contentApproved: creative.status === "APPROVED",
    rawText: `Publish on ${config.label}: ${title}`,
    actorType: "USER",
    userId: actorUserId,
    knownProjectId: projectId,
    ideaId: ideaId ?? undefined,
    departmentKey: "SOCIAL_MEDIA",
    // Same relay treatment as publishCreativeCore above — mirrored onto
    // the creative-ready card instead of its own chat bubble.
    topic: "PUBLISH_RELAY",
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

  const cardUpdated = await IdeaChatRepository.markCreativePublishState({
    taskId: submission.taskId,
    creativeId,
    publishState: submission.requiresApproval ? "queued" : "publishing",
  }).catch(() => false);
  if (!cardUpdated) {
    await prisma.command
      .update({ where: { id: submission.commandId }, data: { topic: null } })
      .catch(() => undefined);
  }

  return { ok: true, message: reply, cardUpdated };
}
