import "server-only";

import type { ExecutionJobStatus } from "@prisma/client";

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
  isMetaRateLimit,
  updateFacebookPagePost,
  type MetaFacebookMetadata,
} from "@/server/integrations/meta-client";
import { getFacebookPublishTarget } from "@/server/integrations/meta-connection-status";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CommandRepository } from "@/server/repositories/command.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
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
  // The Facebook connection stopped working (its token expired or was
  // revoked on Facebook): nothing can be shared or managed until it is
  // connected again.
  | { kind: "reconnect" }
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
// Job states a share can be stuck in when its inline run never got going.
const UNSETTLED_JOB_STATUSES: ExecutionJobStatus[] = [
  "QUEUED",
  "RUNNING",
  "WAITING_PROVIDER",
];
// A share runs inline and Facebook answers within a minute; one still not
// settled after this long never will (its dispatch was claimed by the inline
// run that failed), so it counts as failed and can be tried again.
const STALE_SHARE_MS = 3 * 60_000;
// Facebook accepts far longer posts; this only stops an accidental paste.
const MAX_MESSAGE_LENGTH = 10_000;

type LatestShare = {
  taskId: string;
  taskStatus: string;
  jobStatus: string | null;
  postId: string | null;
  pageId: string | null;
  errorMessage: string | null;
  lastActivityAt: Date;
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
      updatedAt: true,
      executionJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          status: true,
          rawResult: true,
          errorMessage: true,
          updatedAt: true,
        },
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
    lastActivityAt: job?.updatedAt ?? task.updatedAt,
  };
}

type ShareOutcome = "none" | "sharing" | "stale" | "failed" | "posted";

function outcomeOf(share: LatestShare | null, now = Date.now()): ShareOutcome {
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
  return now - share.lastActivityAt.getTime() > STALE_SHARE_MS
    ? "stale"
    : "sharing";
}

// Closes a share that can no longer post, so it neither blocks a new attempt
// nor wakes up later and posts a second copy. It only touches what provably
// never reached Facebook: a QUEUED job (or, for a stale share, an unsettled
// job that has not moved since the cutoff), or a task left without any job.
// A job that got further (the worker is running it, or it already posted and
// is VERIFYING) is left to settle — failing its task under a VERIFYING job
// would make the worker's verification step (FAILED -> COMPLETED) throw.
// Returns whether the share is closed.
async function closeUnsettledShare(
  taskId: string,
  projectId: string,
  reason: string,
  options: { onlyQueued?: boolean; staleBefore?: Date } = {},
): Promise<boolean> {
  const closed = await prisma.executionJob.updateMany({
    where: {
      taskId,
      status: { in: options.onlyQueued ? ["QUEUED"] : UNSETTLED_JOB_STATUSES },
      ...(options.staleBefore
        ? { updatedAt: { lt: options.staleBefore } }
        : {}),
    },
    data: { status: "FAILED", errorMessage: reason, completedAt: new Date() },
  });
  if (closed.count === 0) {
    const jobs = await prisma.executionJob.count({ where: { taskId } });
    if (jobs > 0) return false;
  }
  await TaskRepository.transition(taskId, projectId, "FAILED", {
    failureReason: reason,
  }).catch(() => undefined);
  return true;
}

async function facebookCredential(projectId: string) {
  return prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.facebook },
    },
  });
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

// Meta's own wording helps (a missing permission, a rejected picture); any
// other error is logged and kept out of the card, the reply and the job.
const GENERIC_FAILURE = "Facebook sharing failed, please try again.";

function describeError(error: unknown): string {
  if (error instanceof MetaApiError) {
    if (isMetaRateLimit(error)) {
      return "Facebook: Meta's request limit for this app was reached for now. Try again in about an hour.";
    }
    if (error.metaErrorCode === 190) {
      return "Facebook: the connection is no longer authorized. Reconnect Facebook in Connectors.";
    }
    return `Facebook: ${error.message}`;
  }
  console.error("[facebook-share]", error);
  return GENERIC_FAILURE;
}

function isExpiredToken(error: unknown): boolean {
  return error instanceof MetaApiError && error.metaErrorCode === 190;
}

// The Page token for the Page a post lives on. Only this step uses the stored
// user token, so only a 190 here means the connection itself expired; it is
// then flagged for reconnecting. Any other failure (the person no longer
// manages that Page) leaves the connection alone.
async function pageTokenFor(
  credential: { id: string; encryptedSecret: string },
  pageId: string,
): Promise<{ ok: true; token: string } | { ok: false; error: unknown }> {
  try {
    return {
      ok: true,
      token: await fetchPageAccessToken(
        pageId,
        decryptSecret(credential.encryptedSecret),
      ),
    };
  } catch (error) {
    if (isExpiredToken(error)) {
      await prisma.integrationCredential
        .update({ where: { id: credential.id }, data: { status: "EXPIRED" } })
        .catch(() => undefined);
    }
    return { ok: false, error };
  }
}

// Whether a posted share still blocks sharing to the current Page. Only the
// post read itself answering "it no longer exists" counts as gone; anything
// else (no token, an unreadable post) counts as live, so a post is never made
// twice on the same Page. A post on another Page the connection can no longer
// reach does not block the Page now selected.
async function postStillLive(
  credential: { id: string; encryptedSecret: string; status: string } | null,
  share: LatestShare,
  currentPageId: string,
): Promise<boolean> {
  const pageId = pageIdOf(share);
  if (!share.postId || !pageId || credential?.status !== "ACTIVE") return true;
  const token = await pageTokenFor(credential, pageId);
  if (!token.ok) return isExpiredToken(token.error) || pageId === currentPageId;
  try {
    await fetchFacebookPagePost(share.postId, token.token);
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
    facebookCredential(projectId),
  ]);
  if (!creative || creative.projectId !== projectId) {
    return { kind: "unavailable" };
  }
  if (credential?.status === "EXPIRED") return { kind: "reconnect" };

  const outcome = outcomeOf(share);
  const fallbackName = target?.accountLabel ?? "Facebook Page";
  const active = credential?.status === "ACTIVE" ? credential : null;

  if (outcome === "posted" && share) {
    const pageId = pageIdOf(share);
    const pageName = pageNameOf(credential, pageId, fallbackName);
    const unreadable = {
      kind: "posted" as const,
      pageName,
      postId: share.postId,
      detailsUnavailable: true,
    };
    if (!share.postId) return { kind: "posted", pageName, postId: null };
    if (!active || !pageId) return unreadable;

    const token = await pageTokenFor(active, pageId);
    if (!token.ok) {
      if (isExpiredToken(token.error)) return { kind: "reconnect" };
      // Its Page is out of reach now, but another Page is selected: offer that
      // one (below) instead of a post nobody can manage.
      if (!target || target.pageId === pageId) return unreadable;
    }
    if (token.ok) {
      try {
        const post = await fetchFacebookPagePost(share.postId, token.token);
        return {
          kind: "posted",
          pageName,
          postId: share.postId,
          message: post.message,
          permalinkUrl: post.permalinkUrl,
        };
      } catch (error) {
        // Deleted on Facebook: the piece can be shared again (below).
        if (!isMetaObjectMissing(error)) return unreadable;
      }
    }
  }

  if (outcome === "sharing") return { kind: "sharing", pageName: fallbackName };

  if (!target || !SHAREABLE_STATUSES.has(creative.status)) {
    return { kind: "unavailable" };
  }
  if ((outcome === "failed" || outcome === "stale") && share) {
    return {
      kind: "failed",
      pageName: target.accountLabel,
      reason:
        outcome === "stale"
          ? "The share didn't finish."
          : (share.errorMessage ?? undefined),
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
  // Generated pictures are stored as CREATIVE assets and uploads as IMAGE:
  // what matters is that the file is a picture.
  const imageUrl = version?.asset?.mimeType.startsWith("image/")
    ? await buildAssetPublicUrl(version.asset.id)
    : undefined;
  if (!imageUrl && !caption.trim()) {
    return {
      ok: false,
      message: "This piece has no image or text to share on Facebook.",
    };
  }

  // Already on Facebook, or a share still running: no second post. A post
  // deleted on Facebook counts as gone, so the piece can be shared again; a
  // share that never settled is closed first.
  const share = await findLatestShare(projectId, creativeId);
  const outcome = outcomeOf(share);
  if (outcome === "sharing") {
    return { ok: false, message: "This piece is already being shared." };
  }
  if (
    outcome === "posted" &&
    share &&
    (await postStillLive(
      await facebookCredential(projectId),
      share,
      target.pageId,
    ))
  ) {
    return { ok: false, message: "This piece is already on Facebook." };
  }
  if (outcome === "stale" && share) {
    // Re-checked at the write: a job that moved since the read is not closed,
    // and then nothing new is posted either.
    const closed = await closeUnsettledShare(
      share.taskId,
      projectId,
      "The share didn't finish.",
      { staleBefore: new Date(Date.now() - STALE_SHARE_MS) },
    );
    if (!closed) {
      return { ok: false, message: "This piece is already being shared." };
    }
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
  // the live post right away. The inline run claims the job's dispatch, so a
  // job it left QUEUED when it threw would never run: that one is closed as
  // FAILED and the card offers Try again. A job that got further is left to
  // settle (it may already be on Facebook) and the card keeps polling it.
  let settled: { status: string; errorMessage: string | null };
  try {
    const job = await prisma.executionJob.findFirst({
      where: { taskId: submission.taskId },
      orderBy: { createdAt: "desc" },
      select: { id: true, task: { select: { riskLevel: true } } },
    });
    settled = job
      ? await driveJobInline(job.id, job.task.riskLevel)
      : { status: "QUEUED", errorMessage: null };
  } catch (error) {
    const reason = describeError(error);
    const closed = await closeUnsettledShare(
      submission.taskId,
      projectId,
      reason,
      { onlyQueued: true },
    ).catch(() => false);
    if (!closed) {
      const reply = "📤 Facebook share is still running.";
      await CommandRepository.recordReply(
        submission.commandId,
        reply,
        "PLANNED",
      );
      return { ok: true, message: reply };
    }
    settled = { status: "FAILED", errorMessage: reason };
  }

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
  | { ok: true; postId: string; pageToken: string }
  | { ok: false; message: string }
> {
  const share = await findLatestShare(projectId, creativeId);
  if (!share || outcomeOf(share) !== "posted" || !share.postId) {
    return { ok: false, message: "This piece isn't on Facebook." };
  }
  const pageId = pageIdOf(share);
  const credential = await facebookCredential(projectId);
  if (credential?.status !== "ACTIVE" || !pageId) {
    return { ok: false, message: "Reconnect Facebook in Connectors first." };
  }
  const token = await pageTokenFor(credential, pageId);
  if (!token.ok) return { ok: false, message: describeError(token.error) };
  return { ok: true, postId: share.postId, pageToken: token.token };
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
