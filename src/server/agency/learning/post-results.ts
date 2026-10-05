import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  PUBLISHED_AUDIT_ACTION,
  VERDICT_AUDIT_ACTION,
  compareToRecent,
  isPostVerdict,
  mergeIdeaResult,
  type PostResultItem,
  type PostResultsResponse,
  type PostResultsStatsNote,
  type PostVerdict,
} from "@/lib/post-results";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import {
  META_PROVIDER,
  MetaApiError,
  fetchInstagramPostStats,
  isMetaRateLimit,
  type InstagramPostStats,
  type MetaInstagramMetadata,
} from "@/server/integrations/meta-client";
import {
  instagramAccessFor,
  instagramLoginExpired,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";
import { MemoryService } from "@/server/memory/memory-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { decryptSecret } from "@/server/security/crypto";
import { StateMachine } from "@/server/state-machine/transitions";

// Faz 4, learning: the owner judges a published post ("Worked" / "Didn't
// work") with its live numbers in front of them; the verdict becomes a lesson in
// Brand Memory and moves the pool idea the post was built from to LEARNED.
// Instagram numbers are read only when the owner opens a results view and are
// never stored or sent to the AI (privacy page, Meta review texts).

const PUBLISH_CAPABILITIES: CapabilityKey[] = [
  "INSTAGRAM_PUBLISH",
  "TIKTOK_PUBLISH",
  "LINKEDIN_PUBLISH",
  "X_PUBLISH",
];
// Published posts the results views list (and ask a verdict for): the last 30
// days, at most 60. The bar's "See results (N)" counts the unjudged among the
// very same selection (countAwaitingVerdict), so every post it counts is one
// the dialog lists.
export const RESULTS_WINDOW_DAYS = 30;
const MAX_RESULTS = 60;

// The published posts of the results views, newest first.
function publishedSelection(projectId: string, now: Date) {
  return {
    projectId,
    status: "PUBLISHED" as const,
    updatedAt: {
      gte: new Date(now.getTime() - RESULTS_WINDOW_DAYS * 86_400_000),
    },
  };
}

// How many of the results views' posts still wait for the owner's verdict.
export async function countAwaitingVerdict(
  projectId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await prisma.creative.findMany({
    where: publishedSelection(projectId, now),
    orderBy: { updatedAt: "desc" },
    take: MAX_RESULTS,
    select: { id: true },
  });
  return (await postsAwaitingVerdict(projectId, rows.map((row) => row.id)))
    .length;
}
// The account's latest media read once per view: the posts to show and the
// yardstick they are compared with.
const MEDIA_LIMIT = 50;
// One read serves every card and the dialog for a while; Meta's request limit
// is per app, so nothing is read again while it is reached.
const MEDIA_FRESH_MS = 10 * 60_000;
const RATE_LIMIT_PAUSE_MS = 30 * 60_000;

type MediaRead =
  | { ok: true; media: InstagramPostStats[] }
  | { ok: false; note: Exclude<PostResultsStatsNote, null> };

const mediaCache = new Map<string, { read: MediaRead; at: number }>();
const mediaInFlight = new Map<string, Promise<MediaRead>>();
let mediaPausedUntil = 0;

export function clearPostResultsCache() {
  mediaCache.clear();
  mediaInFlight.clear();
  mediaPausedUntil = 0;
}

// --- the plan card link ------------------------------------------------------

// The pool idea a plan piece was built from: on the saved plan card, slot i is
// savedCreativeIds[i] and items[i] carries the idea (save-plan-core.ts keeps
// the two aligned). Null when the piece has no plan, the card is gone (its chat
// was deleted) or the post did not come from an idea.
export async function ideaOfPlanPiece(
  projectId: string,
  creativeId: string,
  planId: string | null,
): Promise<string | null> {
  if (!planId) return null;
  const command = await prisma.command.findFirst({
    where: { id: planId, projectId },
    select: { parsedIntent: true },
  });
  const card = (command?.parsedIntent as { card?: unknown } | null)?.card;
  return ideaOfCard(card, creativeId);
}

export function ideaOfCard(card: unknown, creativeId: string): string | null {
  if (!isIdeaEventCardData(card) || card.kind !== "content-plan-draft") {
    return null;
  }
  const index = card.savedCreativeIds?.indexOf(creativeId) ?? -1;
  if (index < 0) return null;
  const ideaId = card.items[index]?.ideaId;
  return typeof ideaId === "string" && ideaId ? ideaId : null;
}

// The idea link recorded when the piece was published (publishedIdeaLink), for
// a post whose plan card is gone.
async function publishedIdeaLink(
  projectId: string,
  creativeId: string,
): Promise<string | null> {
  const row = await prisma.auditLog.findFirst({
    where: {
      projectId,
      entityType: "Creative",
      entityId: creativeId,
      action: PUBLISHED_AUDIT_ACTION,
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const ideaId = (row?.metadata as { ideaId?: unknown } | null)?.ideaId;
  return typeof ideaId === "string" && ideaId ? ideaId : null;
}

// Called once a plan piece is PUBLISHED (by the agency: creative-publish-
// completion.ts; by hand: markCreativePublishedAction): keeps the idea link
// apart from the plan card, which goes when its chat is deleted. Written once
// per post, so a retried trigger or a second call is harmless. Never throws.
export async function recordPublishedIdeaLink(input: {
  workspaceId: string;
  projectId: string;
  creativeId: string;
  taskId: string | null;
}): Promise<void> {
  try {
    const recorded = await prisma.auditLog.findFirst({
      where: {
        projectId: input.projectId,
        entityType: "Creative",
        entityId: input.creativeId,
        action: PUBLISHED_AUDIT_ACTION,
      },
      select: { id: true },
    });
    if (recorded) return;
    const creative = await prisma.creative.findFirst({
      where: { id: input.creativeId, projectId: input.projectId },
      select: { planId: true, brandId: true },
    });
    const ideaId = await ideaOfPlanPiece(
      input.projectId,
      input.creativeId,
      creative?.planId ?? null,
    );
    if (!ideaId) return;
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: creative?.brandId,
      actorType: "SYSTEM",
      action: PUBLISHED_AUDIT_ACTION,
      entityType: "Creative",
      entityId: input.creativeId,
      metadata: { ideaId, planId: creative?.planId, taskId: input.taskId },
    });
  } catch (error) {
    console.error(
      "[post-results] could not record the published idea link:",
      error instanceof Error ? error.message : error,
    );
  }
}

// --- live numbers --------------------------------------------------------------

async function readMedia(projectId: string): Promise<MediaRead> {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER.instagram },
    },
  });
  const metadata = (credential?.metadata ??
    null) as Partial<MetaInstagramMetadata> | null;
  const target = resolveInstagramTarget(metadata);
  if (!credential || credential.status !== "ACTIVE" || !target) {
    return { ok: false, note: "not_connected" };
  }
  if (instagramLoginExpired(metadata, Date.now())) {
    return { ok: false, note: "expired" };
  }
  try {
    const access = await instagramAccessFor(
      target,
      decryptSecret(credential.encryptedSecret),
    );
    const media = await fetchInstagramPostStats({
      igUserId: target.igUserId,
      accessToken: access.accessToken,
      api: access.api,
      limit: MEDIA_LIMIT,
    });
    return { ok: true, media };
  } catch (error) {
    if (error instanceof MetaApiError && error.metaErrorCode === 190) {
      return { ok: false, note: "expired" };
    }
    if (isMetaRateLimit(error)) return { ok: false, note: "rate_limited" };
    console.error("[post-results] Instagram read failed:", error);
    return { ok: false, note: "error" };
  }
}

// The account's latest media, read at most once per window for every card and
// the dialog together; concurrent first reads share one request.
export async function recentInstagramMedia(
  projectId: string,
  now: number = Date.now(),
): Promise<MediaRead> {
  const cached = mediaCache.get(projectId);
  if (cached && now - cached.at < MEDIA_FRESH_MS) return cached.read;
  if (now < mediaPausedUntil) return { ok: false, note: "rate_limited" };
  const running = mediaInFlight.get(projectId);
  if (running) return running;
  const read = readMedia(projectId)
    .then((result) => {
      if (result.ok || result.note === "not_connected") {
        mediaCache.set(projectId, { read: result, at: now });
      } else if (result.note === "rate_limited") {
        mediaPausedUntil = now + RATE_LIMIT_PAUSE_MS;
      }
      return result;
    })
    .finally(() => mediaInFlight.delete(projectId));
  mediaInFlight.set(projectId, read);
  return read;
}

// --- the results views -----------------------------------------------------------

// Published posts of the project (the last 30 days, newest first; or one post),
// each with the owner's verdict, the idea it came from and, for a post the
// agency published to Instagram, its live numbers next to the account's recent
// posts. Reads Instagram only when a post needs it.
export async function loadPostResults(
  projectId: string,
  options: { creativeId?: string; now?: Date } = {},
): Promise<PostResultsResponse> {
  const now = options.now ?? new Date();
  const creatives = await prisma.creative.findMany({
    where: options.creativeId
      ? { projectId, status: "PUBLISHED", id: options.creativeId }
      : publishedSelection(projectId, now),
    orderBy: { updatedAt: "desc" },
    take: MAX_RESULTS,
    select: {
      id: true,
      title: true,
      channel: true,
      formatKey: true,
      planId: true,
      updatedAt: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { assetId: true },
      },
    },
  });
  if (creatives.length === 0) return { items: [], statsNote: null };
  const ids = creatives.map((creative) => creative.id);

  const [tasks, verdictRows, linkRows, planRows] = await Promise.all([
    prisma.task.findMany({
      where: {
        projectId,
        status: "COMPLETED",
        capability: { in: PUBLISH_CAPABILITIES },
        OR: ids.map((id) => ({
          payload: { path: ["creativeId"], equals: id },
        })),
      },
      orderBy: { completedAt: "desc" },
      select: { id: true, capability: true, completedAt: true, payload: true },
    }),
    prisma.auditLog.findMany({
      where: {
        projectId,
        entityType: "Creative",
        entityId: { in: ids },
        action: VERDICT_AUDIT_ACTION,
      },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, metadata: true },
    }),
    prisma.auditLog.findMany({
      where: {
        projectId,
        entityType: "Creative",
        entityId: { in: ids },
        action: PUBLISHED_AUDIT_ACTION,
      },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, metadata: true },
    }),
    prisma.command.findMany({
      where: {
        projectId,
        id: {
          in: [
            ...new Set(creatives.flatMap((c) => (c.planId ? [c.planId] : []))),
          ],
        },
      },
      select: { id: true, parsedIntent: true },
    }),
  ]);

  // The newest completed publish task of each post: when it went out and, for
  // Instagram, the media id the post has there.
  const publishOf = new Map<
    string,
    { completedAt: Date | null; capability: CapabilityKey; taskId: string }
  >();
  for (const task of tasks) {
    const creativeId = (task.payload as { creativeId?: unknown } | null)
      ?.creativeId;
    if (typeof creativeId !== "string" || publishOf.has(creativeId)) continue;
    publishOf.set(creativeId, {
      completedAt: task.completedAt,
      capability: task.capability,
      taskId: task.id,
    });
  }
  const igTaskIds = [...publishOf.values()]
    .filter((entry) => entry.capability === "INSTAGRAM_PUBLISH")
    .map((entry) => entry.taskId);
  const jobs = igTaskIds.length
    ? await prisma.executionJob.findMany({
        where: { taskId: { in: igTaskIds }, status: "COMPLETED" },
        select: { taskId: true, rawResult: true },
      })
    : [];
  const mediaIdOfTask = new Map<string, string>();
  for (const job of jobs) {
    const postId = (job.rawResult as { postId?: unknown } | null)?.postId;
    if (typeof postId === "string" && postId)
      mediaIdOfTask.set(job.taskId, postId);
  }

  const verdictOf = new Map<string, PostVerdict>();
  for (const row of verdictRows) {
    if (verdictOf.has(row.entityId)) continue;
    const verdict = (row.metadata as { verdict?: unknown } | null)?.verdict;
    if (isPostVerdict(verdict)) verdictOf.set(row.entityId, verdict);
  }
  const linkOf = new Map<string, string>();
  for (const row of linkRows) {
    if (linkOf.has(row.entityId)) continue;
    const ideaId = (row.metadata as { ideaId?: unknown } | null)?.ideaId;
    if (typeof ideaId === "string" && ideaId) linkOf.set(row.entityId, ideaId);
  }
  const cardOf = new Map(
    planRows.map((row) => [
      row.id,
      (row.parsedIntent as { card?: unknown } | null)?.card,
    ]),
  );

  const mediaIdOf = (creativeId: string): string | null => {
    const publish = publishOf.get(creativeId);
    if (!publish || publish.capability !== "INSTAGRAM_PUBLISH") return null;
    return mediaIdOfTask.get(publish.taskId) ?? null;
  };
  const needsInstagram = creatives.some((c) => mediaIdOf(c.id) !== null);
  const media = needsInstagram
    ? await recentInstagramMedia(projectId, now.getTime())
    : null;

  const items: PostResultItem[] = creatives.map((creative) => {
    const publish = publishOf.get(creative.id);
    const mediaId = mediaIdOf(creative.id);
    let stats: PostResultItem["stats"] = null;
    if (mediaId && media?.ok) {
      const own = media.media.find((entry) => entry.id === mediaId);
      if (own) {
        stats = {
          likes: own.likes,
          comments: own.comments,
          permalink: own.permalink,
          comparison: compareToRecent(
            own,
            media.media.filter((entry) => entry.id !== mediaId),
          ),
        };
      }
    }
    return {
      creativeId: creative.id,
      title: creative.title ?? "",
      channel: creative.channel,
      formatKey: creative.formatKey,
      publishedAt: (publish?.completedAt ?? creative.updatedAt).toISOString(),
      assetId: creative.versions[0]?.assetId ?? null,
      ideaId:
        (creative.planId
          ? ideaOfCard(cardOf.get(creative.planId), creative.id)
          : null) ??
        linkOf.get(creative.id) ??
        null,
      verdict: verdictOf.get(creative.id) ?? null,
      stats,
    };
  });

  // The posts still waiting for a verdict first, then the judged ones.
  const ordered = [
    ...items.filter((item) => item.verdict === null),
    ...items.filter((item) => item.verdict !== null),
  ];
  return {
    items: ordered,
    statsNote: media && !media.ok ? media.note : null,
  };
}

// Which of these published posts still wait for the owner's verdict.
export async function postsAwaitingVerdict(
  projectId: string,
  creativeIds: readonly string[],
): Promise<string[]> {
  if (creativeIds.length === 0) return [];
  const judged = await prisma.auditLog.findMany({
    where: {
      projectId,
      entityType: "Creative",
      entityId: { in: [...creativeIds] },
      action: VERDICT_AUDIT_ACTION,
    },
    select: { entityId: true },
  });
  const done = new Set(judged.map((row) => row.entityId));
  return creativeIds.filter((id) => !done.has(id));
}

// --- the verdict -----------------------------------------------------------------------

export type RecordVerdictResult =
  | { ok: true; ideaLearned: boolean }
  | { ok: false; reason: "NOT_FOUND" | "NOT_PUBLISHED" };

// The owner's verdict on a published post: a lesson in Brand Memory (no
// numbers), the pool idea it came from moved to LEARNED with the verdict in its
// results, and an audit row that marks the post judged. A second verdict
// replaces the first everywhere.
export async function recordPostVerdict(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  creativeId: string;
  verdict: PostVerdict;
  note?: string | null;
  now?: Date;
}): Promise<RecordVerdictResult> {
  const creative = await prisma.creative.findFirst({
    where: { id: input.creativeId, projectId: input.projectId },
    select: { status: true, planId: true },
  });
  if (!creative) return { ok: false, reason: "NOT_FOUND" };
  if (creative.status !== "PUBLISHED")
    return { ok: false, reason: "NOT_PUBLISHED" };
  const at = (input.now ?? new Date()).toISOString();

  await MemoryService.rememberPostResult({
    scope: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
    },
    creativeId: input.creativeId,
    verdict: input.verdict,
    note: input.note,
  });

  const ideaId =
    (await ideaOfPlanPiece(
      input.projectId,
      input.creativeId,
      creative.planId,
    )) ?? (await publishedIdeaLink(input.projectId, input.creativeId));
  const ideaLearned = ideaId
    ? await learnIdea(
        input.projectId,
        ideaId,
        input.creativeId,
        input.verdict,
        at,
      )
    : false;

  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    brandId: input.brandId,
    actorType: "USER",
    actorId: input.userId,
    action: VERDICT_AUDIT_ACTION,
    entityType: "Creative",
    entityId: input.creativeId,
    metadata: { verdict: input.verdict, ideaId, ideaLearned },
  });
  return { ok: true, ideaLearned };
}

// The idea moves to LEARNED with the verdict merged into its results. An idea
// still in the pool or planned is first walked to MEASURING through the state
// machine; an archived or rejected one is left alone. Never throws: the lesson
// in memory stands either way.
async function learnIdea(
  projectId: string,
  ideaId: string,
  creativeId: string,
  verdict: PostVerdict,
  at: string,
): Promise<boolean> {
  try {
    const status = await IdeaRepository.advanceForScheduling(ideaId, projectId);
    if (status !== "MEASURING" && status !== "LEARNED") return false;
    return await prisma.$transaction(async (tx) => {
      // Two verdicts on two posts of one idea must not lose each other's merge.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`idea-result:${ideaId}`}))`;
      const idea = await tx.idea.findFirst({
        where: { id: ideaId, projectId },
        select: { status: true, scores: true },
      });
      if (!idea || (idea.status !== "MEASURING" && idea.status !== "LEARNED")) {
        return false;
      }
      StateMachine.assertIdeaTransition(idea.status, "LEARNED");
      await tx.idea.update({
        where: { id: ideaId },
        data: {
          status: "LEARNED",
          scores: mergeIdeaResult(
            idea.scores,
            creativeId,
            verdict,
            at,
          ) as never,
        },
      });
      return true;
    });
  } catch (error) {
    console.error(
      `[post-results] could not move idea ${ideaId} to LEARNED:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
