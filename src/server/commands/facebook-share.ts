import "server-only";

import { prisma } from "@/lib/prisma";
import { driveJobInline } from "@/server/chat/inline-job";
import { CommandService } from "@/server/commands/command-service";
import {
  META_PROVIDER,
  MetaApiError,
  deleteFacebookPagePost,
  fetchFacebookPagePost,
  fetchPageAccessToken,
  isMetaObjectMissing,
  updateFacebookPagePost,
  type MetaFacebookMetadata,
} from "@/server/integrations/meta-client";
import { getFacebookPublishTarget } from "@/server/integrations/meta-connection-status";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CommandRepository } from "@/server/repositories/command.repository";
import { buildAssetPublicUrl } from "@/server/security/asset-public-link";
import { decryptSecret } from "@/server/security/crypto";

// Sharing a finished creative on the project's Facebook Page. It is a cross-post
// next to the creative's own channel, not its publication: it never changes the
// Creative's status or the card's publish state, so an Instagram piece shared on
// Facebook still goes out on Instagram at its time. The post is made by a
// FACEBOOK_PUBLISH task run inline; everything after that (its text, its link,
// whether it still exists) is read back from Facebook itself, so a post deleted
// on Facebook can simply be shared again.

export type FacebookShareState =
  | { kind: "unavailable" }
  | { kind: "ready"; pageName: string }
  | { kind: "sharing"; pageName: string }
  | { kind: "failed"; pageName: string; reason?: string }
  | {
      kind: "posted";
      pageName: string;
      // null when the post id is unknown (a mock run): shown, not manageable.
      postId: string | null;
      message?: string;
      permalinkUrl?: string;
      // The post exists but its details could not be read right now.
      detailsUnavailable?: boolean;
    };

export type FacebookShareResult =
  { ok: true; message: string } | { ok: false; message: string };

type ShareInput = {
  creativeId: string;
  workspaceId: string;
  projectId: string;
  actorUserId: string;
};

// The share task names its creative under this key, NOT `creativeId`: every
// publish task carrying `creativeId` is mirrored onto that creative's card and
// flips it to PUBLISHED when done (execution-service.ts, task.repository.ts,
// creative-publish-completion.ts) — right for the piece's own channel, wrong
// for a cross-post.
const SHARED_CREATIVE_KEY = "sharedCreativeId";
const SHAREABLE_STATUSES = new Set(["APPROVED", "PUBLISHED"]);
// A job holding a live post: VERIFYING is the window before the worker's
// automatic verification moves it to COMPLETED.
const POSTED_JOB_STATUSES = new Set(["VERIFYING", "COMPLETED"]);
// Facebook accepts far longer posts; this only stops an accidental paste.
const MAX_MESSAGE_LENGTH = 10_000;

type LatestShare = {
  taskId: string;
  taskStatus: string;
  jobStatus: string | null;
  postId: string | null;
  pageId: string | null;
  errorMessage: string | null;
};

// The newest FACEBOOK_PUBLISH task made for this creative, with its newest job.
async function findLatestShare(
  projectId: string,
  creativeId: string,
): Promise<LatestShare | null> {
  const task = await prisma.task.findFirst({
    where: {
      projectId,
      capability: "FACEBOOK_PUBLISH",
      payload: { path: [SHARED_CREATIVE_KEY], equals: creativeId },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      executionJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, rawResult: true, errorMessage: true },
      },
    },
  });
  if (!task) return null;
  const job = task.executionJobs[0] ?? null;
  const raw = (job?.rawResult ?? {}) as Record<string, unknown>;
  return {
    taskId: task.id,
    taskStatus: task.status,
    jobStatus: job?.status ?? null,
    postId: typeof raw.postId === "string" ? raw.postId : null,
    pageId: typeof raw.pageId === "string" ? raw.pageId : null,
    errorMessage: job?.errorMessage ?? null,
  };
}

type ShareOutcome = "none" | "sharing" | "failed" | "posted";

function outcomeOf(share: LatestShare | null): ShareOutcome {
  if (!share) return "none";
  if (share.jobStatus && POSTED_JOB_STATUSES.has(share.jobStatus)) {
    return "posted";
  }
  if (share.jobStatus === "FAILED" || share.taskStatus === "FAILED") {
    return "failed";
  }
  if (share.jobStatus === "CANCELLED" || share.taskStatus === "CANCELLED") {
    return "none";
  }
  return "sharing";
}

async function activeFacebookCredential(projectId: string) {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.facebook },
    },
  });
  return credential?.status === "ACTIVE" ? credential : null;
}

function pageNameOf(
  credential: { metadata: unknown } | null,
  pageId: string | null,
  fallback: string,
): string {
  const pages = ((credential?.metadata ?? {}) as Partial<MetaFacebookMetadata>)
    .pages;
  return pages?.find((p) => p.pageId === pageId)?.pageName ?? fallback;
}

// A Page post id is "<pageId>_<postId>"; the job also records the Page.
function pageIdOf(share: LatestShare): string | null {
  return share.pageId ?? share.postId?.split("_")[0] ?? null;
}

function describeError(error: unknown): string {
  if (error instanceof MetaApiError) {
    if (error.metaErrorCode === 190) {
      return "Facebook: the connection is no longer authorized. Reconnect Facebook in Connectors.";
    }
    return `Facebook: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function markExpiredOn190(credentialId: string, error: unknown) {
  if (error instanceof MetaApiError && error.metaErrorCode === 190) {
    await prisma.integrationCredential
      .update({ where: { id: credentialId }, data: { status: "EXPIRED" } })
      .catch(() => undefined);
  }
}

// Whether a posted share is still on Facebook. Anything but a definite "it no
// longer exists" counts as live, so an unreadable post is never posted twice.
async function postStillLive(
  projectId: string,
  share: LatestShare,
): Promise<boolean> {
  const pageId = pageIdOf(share);
  const credential = await activeFacebookCredential(projectId);
  if (!share.postId || !pageId || !credential) return true;
  try {
    const pageToken = await fetchPageAccessToken(
      pageId,
      decryptSecret(credential.encryptedSecret),
    );
    await fetchFacebookPagePost(share.postId, pageToken);
    return true;
  } catch (error) {
    return !isMetaObjectMissing(error);
  }
}

export async function readFacebookShareState(
  projectId: string,
  creativeId: string,
): Promise<FacebookShareState> {
  const [creative, target, share, credential] = await Promise.all([
    prisma.creative.findUnique({
      where: { id: creativeId },
      select: { projectId: true, status: true },
    }),
    getFacebookPublishTarget(projectId),
    findLatestShare(projectId, creativeId),
    activeFacebookCredential(projectId),
  ]);
  if (!creative || creative.projectId !== projectId) {
    return { kind: "unavailable" };
  }

  const outcome = outcomeOf(share);
  const fallbackName = target?.accountLabel ?? "Facebook Page";

  if (outcome === "posted" && share) {
    const pageId = pageIdOf(share);
    const pageName = pageNameOf(credential, pageId, fallbackName);
    if (!share.postId) return { kind: "posted", pageName, postId: null };
    if (!credential || !pageId) {
      return {
        kind: "posted",
        pageName,
        postId: share.postId,
        detailsUnavailable: true,
      };
    }
    try {
      const pageToken = await fetchPageAccessToken(
        pageId,
        decryptSecret(credential.encryptedSecret),
      );
      const post = await fetchFacebookPagePost(share.postId, pageToken);
      return {
        kind: "posted",
        pageName,
        postId: share.postId,
        message: post.message,
        permalinkUrl: post.permalinkUrl,
      };
    } catch (error) {
      // Deleted on Facebook: the piece can be shared again (below).
      if (!isMetaObjectMissing(error)) {
        await markExpiredOn190(credential.id, error);
        return {
          kind: "posted",
          pageName,
          postId: share.postId,
          detailsUnavailable: true,
        };
      }
    }
  }

  if (outcome === "sharing") return { kind: "sharing", pageName: fallbackName };

  if (!target || !SHAREABLE_STATUSES.has(creative.status)) {
    return { kind: "unavailable" };
  }
  if (outcome === "failed" && share) {
    return {
      kind: "failed",
      pageName: target.accountLabel,
      reason: share.errorMessage ?? undefined,
    };
  }
  return { kind: "ready", pageName: target.accountLabel };
}

export async function shareCreativeToFacebookCore(
  input: ShareInput,
): Promise<FacebookShareResult> {
  const { creativeId, workspaceId, projectId, actorUserId } = input;

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
  if (!creative || creative.projectId !== projectId) {
    return { ok: false, message: "Creative not found." };
  }
  if (!SHAREABLE_STATUSES.has(creative.status)) {
    return {
      ok: false,
      message: "Approve this piece before sharing it on Facebook.",
    };
  }

  const target = await getFacebookPublishTarget(projectId);
  if (!target) {
    return { ok: false, message: "There's no connected Facebook Page." };
  }

  const version = creative.versions[0];
  const caption = version?.caption || version?.copy || "";
  const imageUrl =
    version?.asset?.type === "IMAGE"
      ? await buildAssetPublicUrl(version.asset.id)
      : undefined;
  if (!imageUrl && !caption.trim()) {
    return {
      ok: false,
      message: "This piece has no image or text to share on Facebook.",
    };
  }

  // Already on Facebook, or a share still running: no second post. A post
  // deleted on Facebook counts as gone, so the piece can be shared again.
  const share = await findLatestShare(projectId, creativeId);
  const outcome = outcomeOf(share);
  if (outcome === "sharing") {
    return { ok: false, message: "This piece is already being shared." };
  }
  if (outcome === "posted" && share && (await postStillLive(projectId, share))) {
    return { ok: false, message: "This piece is already on Facebook." };
  }
  const seenTaskId = share?.taskId ?? null;

  const title = creative.title ?? "Creative";
  // Two tabs or a double click serialize on the creative; the second one finds
  // the task the first committed and stops.
  const submission = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`facebook-share:${creativeId}`}))`;
      const latest = await tx.task.findFirst({
        where: {
          projectId,
          capability: "FACEBOOK_PUBLISH",
          payload: { path: [SHARED_CREATIVE_KEY], equals: creativeId },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if ((latest?.id ?? null) !== seenTaskId) return null;
      return CommandService.submit({
        workspaceId,
        source: "WEB",
        // Only an approved piece gets here: its human decision was made.
        contentApproved: true,
        rawText: `Share on Facebook: ${title}`,
        actorType: "USER",
        userId: actorUserId,
        knownProjectId: projectId,
        departmentKey: "SOCIAL_MEDIA",
        // Kept off the chat feed: the card shows the outcome.
        topic: "PUBLISH_RELAY",
        intent: {
          kind: "CAPABILITY",
          capability: "FACEBOOK_PUBLISH",
          targetPlatform: "FACEBOOK",
          request: `${title} — Facebook share`,
        },
        payloadExtra: {
          caption,
          [SHARED_CREATIVE_KEY]: creativeId,
          ...(imageUrl ? { imageUrl } : {}),
        },
      });
    },
    { timeout: 20_000, maxWait: 5_000 },
  );

  if (!submission) {
    return { ok: false, message: "This piece is already being shared." };
  }
  if (submission.status !== "PLANNED") {
    return { ok: false, message: "Failed to create the Facebook share." };
  }

  if (!submission.dispatched) {
    const reply = "📤 Facebook share sent for approval.";
    await CommandRepository.recordReply(submission.commandId, reply, "PLANNED");
    return { ok: true, message: reply };
  }

  // Run it now rather than on the worker's next tick, so the card can show
  // the live post right away.
  const job = await prisma.executionJob.findFirst({
    where: { taskId: submission.taskId },
    orderBy: { createdAt: "desc" },
    select: { id: true, task: { select: { riskLevel: true } } },
  });
  const settled = job
    ? await driveJobInline(job.id, job.task.riskLevel)
    : { status: "QUEUED", errorMessage: null };

  if (settled.status === "FAILED") {
    const reply = `Couldn't share on Facebook${settled.errorMessage ? `: ${settled.errorMessage}` : "."}`;
    await CommandRepository.recordReply(submission.commandId, reply, "ERROR");
    return { ok: false, message: reply };
  }
  const reply = POSTED_JOB_STATUSES.has(settled.status)
    ? `📤 Shared on Facebook (${target.accountLabel}).`
    : "📤 Facebook share queued.";
  await CommandRepository.recordReply(submission.commandId, reply, "PLANNED");
  return { ok: true, message: reply };
}

// The post an edit or delete acts on: the creative's live Facebook post and the
// Page token to change it with.
async function resolveLivePost(
  projectId: string,
  creativeId: string,
): Promise<
  | {
      ok: true;
      postId: string;
      pageToken: string;
      credentialId: string;
    }
  | { ok: false; message: string }
> {
  const share = await findLatestShare(projectId, creativeId);
  if (!share || outcomeOf(share) !== "posted" || !share.postId) {
    return { ok: false, message: "This piece isn't on Facebook." };
  }
  const pageId = pageIdOf(share);
  const credential = await activeFacebookCredential(projectId);
  if (!credential || !pageId) {
    return { ok: false, message: "Reconnect Facebook in Connectors first." };
  }
  try {
    const pageToken = await fetchPageAccessToken(
      pageId,
      decryptSecret(credential.encryptedSecret),
    );
    return {
      ok: true,
      postId: share.postId,
      pageToken,
      credentialId: credential.id,
    };
  } catch (error) {
    await markExpiredOn190(credential.id, error);
    return { ok: false, message: describeError(error) };
  }
}

export async function editFacebookShareCore(
  input: ShareInput & { message: string },
): Promise<FacebookShareResult> {
  const message = input.message.trim();
  if (!message) return { ok: false, message: "The post text can't be empty." };
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, message: "The post text is too long." };
  }

  const live = await resolveLivePost(input.projectId, input.creativeId);
  if (!live.ok) return live;
  try {
    await updateFacebookPagePost(live.postId, live.pageToken, message);
  } catch (error) {
    await markExpiredOn190(live.credentialId, error);
    return { ok: false, message: describeError(error) };
  }

  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorType: "USER",
    actorId: input.actorUserId,
    action: "facebook_post.updated",
    entityType: "Creative",
    entityId: input.creativeId,
    metadata: { postId: live.postId },
  });
  return { ok: true, message: "Facebook post updated." };
}

export async function deleteFacebookShareCore(
  input: ShareInput,
): Promise<FacebookShareResult> {
  const live = await resolveLivePost(input.projectId, input.creativeId);
  if (!live.ok) return live;
  try {
    await deleteFacebookPagePost(live.postId, live.pageToken);
  } catch (error) {
    // Already gone on Facebook: the outcome the person asked for.
    if (!isMetaObjectMissing(error)) {
      await markExpiredOn190(live.credentialId, error);
      return { ok: false, message: describeError(error) };
    }
  }

  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorType: "USER",
    actorId: input.actorUserId,
    action: "facebook_post.deleted",
    entityType: "Creative",
    entityId: input.creativeId,
    metadata: { postId: live.postId },
  });
  return { ok: true, message: "Deleted from Facebook." };
}
