import "server-only";

import type { ActorType, Approval, CreativeLens } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AgentelseError } from "@/server/security/errors";
import { missingInputAdvice } from "@/server/execution/capability-input";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { sendPublishPromptToTelegram } from "@/server/notifications/telegram-approval-notifier";
import { publishCreativeCore } from "@/server/commands/publish-creative";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { hasActiveMetaAdsAccount } from "@/server/execution/providers/meta/meta-api-provider";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { MemoryService } from "@/server/memory/memory-service";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { metaCampaignBriefDef } from "@/server/reasoning/prompts/meta-campaign-brief";
import { canPublishNow, type PublishBlock } from "@/lib/works/publish-guard";
import { isWorksEnabled } from "@/server/works/flag";
import { ownedPlanIds, workOwnershipOf } from "@/server/works/work-owned";

// Pseudo-actor for the first genuinely unattended flow in this codebase —
// every prior SYSTEM-created row (e.g. meta-adset-chain-relay.ts) simply
// omits createdByUserId rather than inventing a placeholder. This follows
// the one existing precedent's style (telegram-approval-poller.ts's
// `telegram:<id>`) since publishCreativeCore requires a non-null string
// and nothing downstream validates it against a real User (Command/Task's
// createdByUserId columns are unenforced `String?`, confirmed).
const AUTO_PUBLISH_ACTOR_ID = "system:auto-publish";

// Ideas whose lens inherently suits paid distribution — mirrors
// agency-director.ts's VISUAL_LENSES pattern: a deterministic Prisma enum
// signal, not the LLM's free-text `departmentsInvolved` field (confirmed
// via live production data: zero ideas ever contain the literal string
// "PERFORMANCE_MARKETING" there, since the model writes free-text
// department names instead — relying on it would never fire).
const PAID_MEDIA_LENSES = new Set<CreativeLens>(["GROWTH", "MEDIA"]);

// Finds which idea's chat an approval decision (Task or Creative) belongs
// to and the title to show on the card — directly for a Task
// (resolveIdeaIdForTask), and for a Creative via the task that produced it
// (Creative.createdByTaskId), then the same lookup from there. If neither
// resolves (e.g. a manually created task/creative with no idea), returns
// null and is silently skipped.
async function resolveApprovalChatTarget(
  approval: Approval,
): Promise<{ ideaId: string | null; title: string } | null> {
  if (approval.entityType === "Task" && approval.taskId) {
    // ideaId may be null (a system-generated task with no idea lineage —
    // e.g. PerformanceOptimizer's proposals) — the decision card still
    // posts, into the project's general chat stream. Only `task` missing
    // (the task itself doesn't exist) is a real "nothing to show" case.
    const [ideaId, task] = await Promise.all([
      IdeaChatRepository.resolveIdeaIdForTask(approval.taskId),
      prisma.task.findUnique({
        where: { id: approval.taskId },
        select: { title: true },
      }),
    ]);
    if (!task) return null;
    return { ideaId, title: task.title };
  }

  if (approval.entityType === "Creative") {
    return resolveIdeaAndTitleForCreative(approval.entityId);
  }

  return null;
}

// The Creative half of resolveApprovalChatTarget above, factored out so
// publishNextQueuedInstagramCreative (no Approval row — the scheduler
// triggered this, not a human decision) can post the same "published" chat
// message as the immediate-auto-publish path. Mirrors the Task branch's
// null-safety above it: ideaId may legitimately be null (no idea lineage,
// or no createdByTaskId at all — e.g. a manually created Studio creative)
// and the decision still posts into the project's general chat stream.
// Only a genuinely nonexistent creative is a real "nothing to show" case.
async function resolveIdeaAndTitleForCreative(
  creativeId: string,
): Promise<{ ideaId: string | null; title: string } | null> {
  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { createdByTaskId: true, title: true },
  });
  if (!creative) return null;
  if (!creative.createdByTaskId) {
    return { ideaId: null, title: creative.title ?? "Creative" };
  }
  const [ideaId, task] = await Promise.all([
    IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId),
    prisma.task.findUnique({
      where: { id: creative.createdByTaskId },
      select: { title: true },
    }),
  ]);
  return { ideaId, title: task?.title ?? creative.title ?? "Creative" };
}

export type AutoPublishResult = {
  // PUBLISHED: publishCreativeCore actually submitted the publish command.
  // QUEUED: this project has a Publishing schedule configured (Settings →
  // Publishing) — the creative stays APPROVED and will be picked up by
  // publishNextQueuedInstagramCreative at its next slot, so the caller must
  // NOT fall back to the "want to share it?" ask-flow.
  // SKIPPED: not applicable (not Instagram, no Meta connection) or a real
  // error — the caller's existing ask-flow fallback applies here.
  status: "PUBLISHED" | "QUEUED" | "SKIPPED";
  message: string;
  // QUEUED only, and only for a piece with a planned time still ahead (a
  // content-plan slot): when it is meant to go out. `released` says whether
  // a Publishing schedule exists to release it then.
  plannedFor?: Date;
  released?: boolean;
  // Only meaningful when status is "PUBLISHED" — see
  // PublishQuickActionResult's own comment. Callers use this to skip a
  // redundant "published!" chat message when the creative's own card
  // already shows it.
  cardUpdated?: boolean;
  // Works only: the piece is approved but deliberately NOT released (no usable
  // publish time). It stays APPROVED until the client sets a time or posts it.
  held?: true;
  // Works only: why a Work-owned piece is SKIPPED when the cause is a hand-off
  // (a format or channel posted by hand). The caller must not offer the legacy
  // "share it on social media?" prompt for these.
  reason?: "MANUAL_FORMAT" | "WRONG_PLATFORM";
};

// "Approved — planned for Thu 8 Oct, 10:00" in the project's own timezone, and
// whether anything will release it then.
async function plannedApprovalText(
  projectId: string,
  title: string,
  plannedFor: Date,
  released: boolean,
): Promise<string> {
  const when = plannedFor.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: await getProjectTimezone(projectId),
  });
  return released
    ? `✅ ${title} approved — planned for ${when}.`
    : `✅ ${title} approved — planned for ${when}. Turn on scheduled posting so it goes out then.`;
}

// True when this project has at least one enabled Instagram publish
// schedule (created from Settings → Publishing, src/server/actions/
// publish-schedule-actions.ts) — in that case approved creatives queue up
// instead of publishing immediately (see autoPublishCreative below).
async function isInstagramPublishScheduled(
  projectId: string,
): Promise<boolean> {
  const count = await prisma.projectSchedule.count({
    where: { projectId, capability: "INSTAGRAM_PUBLISH", enabled: true },
  });
  return count > 0;
}

// A failed publish keeps its piece out of the Works queue for this long, so one
// bad piece cannot be retried at every slot.
const FAILED_PUBLISH_COOLDOWN_MS = 24 * 3600 * 1000;

const HELD_MESSAGE = "Held: no usable publish time is set";

const SKIP_MESSAGE: Record<
  Exclude<PublishBlock, "NO_TIME" | "PAST_TIME">,
  string
> = {
  NOT_APPROVED: "Not approved yet",
  NOT_CONNECTED: "No connected Meta page/Instagram account",
  NO_ASSET: "This creative has no image to publish",
  MANUAL_FORMAT: "This format is posted by hand",
  WRONG_PLATFORM: "Not an Instagram creative",
};

// Works only: the auto-publish decision for a Work-owned creative. It never
// posts on approval: a piece without a usable time is held (with or without a
// Publishing schedule, so turning scheduled posting on never releases an old
// piece) and the rest waits for its time or for the queue.
async function autoPublishWorkOwned(input: {
  creativeId: string;
  projectId: string;
}): Promise<AutoPublishResult> {
  const [creative, targets] = await Promise.all([
    prisma.creative.findUnique({
      where: { id: input.creativeId },
      select: {
        status: true,
        platform: true,
        formatKey: true,
        scheduledFor: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { assetId: true },
        },
      },
    }),
    getPublishTargets(input.projectId),
  ]);
  if (!creative) return { status: "SKIPPED", message: "Creative not found" };

  const decision = canPublishNow(
    {
      status: creative.status,
      platform: creative.platform,
      formatKey: creative.formatKey,
      hasAsset: Boolean(creative.versions[0]?.assetId),
      scheduledFor: creative.scheduledFor,
      connectedPlatforms: new Set(targets.map((t) => t.platform)),
    },
    "auto",
  );
  if (!decision.ok) {
    if (decision.reason === "NO_TIME" || decision.reason === "PAST_TIME") {
      return { status: "QUEUED", held: true, message: HELD_MESSAGE };
    }
    if (
      decision.reason === "MANUAL_FORMAT" ||
      decision.reason === "WRONG_PLATFORM"
    ) {
      return {
        status: "SKIPPED",
        message: SKIP_MESSAGE[decision.reason],
        reason: decision.reason,
      };
    }
    return { status: "SKIPPED", message: SKIP_MESSAGE[decision.reason] };
  }

  const released = await isInstagramPublishScheduled(input.projectId);
  if (decision.timing === "future" && creative.scheduledFor) {
    return {
      status: "QUEUED",
      message: released
        ? "Waiting for its planned time"
        : "Waiting for its planned time — scheduled posting is off",
      plannedFor: creative.scheduledFor,
      released,
    };
  }
  // Due (planned within the last 24 h): the queue releases it when a schedule
  // exists, otherwise it is held for an explicit Post now.
  if (released) {
    // The queue judges a piece by its planned time at tick time and refuses it
    // once that time is more than the grace old. Daily slots are derived from
    // the plan's own clock times, so for a piece approved after its time the
    // next slot lands just past that limit: it would be promised a slot and
    // then skipped for good. The decision to release is taken now, so the time
    // moves to now and the grace clock starts at approval. Compare-and-set on
    // the time we judged: a concurrent "Change time" is never overwritten.
    if (creative.scheduledFor) {
      await prisma.creative.updateMany({
        where: { id: input.creativeId, scheduledFor: creative.scheduledFor },
        data: { scheduledFor: new Date() },
      });
    }
    return {
      status: "QUEUED",
      message: "Waiting for the next scheduled Instagram slot",
    };
  }
  return { status: "QUEUED", held: true, message: HELD_MESSAGE };
}

// Auto-publish: a Creative reaching APPROVED already passed its own human
// content review — requiring a SEPARATE approval just to actually post it
// re-asks a question already answered, and in practice nobody was
// answering it (13 approved creatives sat unpublished 11+ days in
// production). Deliberately its OWN try/catch, not sharing the outer
// best-effort block below (which only guards chat-CARD writes) —
// publishCreativeCore can genuinely throw, and if that throw were
// swallowed there instead, neither the publish NOR the fallback ask-flow
// would run, reproducing the exact bug this closes.
// Exported (not just used internally by applyApprovalDecision below) so a
// one-off backfill for creatives that were APPROVED before this feature
// existed can reuse the exact same logic instead of duplicating it.
export async function autoPublishCreative(input: {
  creativeId: string;
  workspaceId: string;
  projectId: string;
}): Promise<AutoPublishResult> {
  try {
    const creative = await prisma.creative.findUnique({
      where: { id: input.creativeId },
      select: { platform: true, scheduledFor: true },
    });
    // Only Instagram is autonomously reachable today — TikTok/LinkedIn/X
    // publishing (publishCreativeToSocialCore) stays human-triggered.
    if (creative?.platform !== "INSTAGRAM") {
      // Works only: another channel's Work piece is a hand-off, so the caller
      // must not offer the Instagram share prompt for it.
      if (isWorksEnabled() && (await workOwnershipOf(input.creativeId)).owned) {
        return {
          status: "SKIPPED",
          message: "Not an Instagram creative",
          reason: "WRONG_PLATFORM",
        };
      }
      return { status: "SKIPPED", message: "Not an Instagram creative" };
    }
    // Work-owned pieces follow the hold rule (Works only; flag off never
    // reaches this).
    if (isWorksEnabled() && (await workOwnershipOf(input.creativeId)).owned) {
      return await autoPublishWorkOwned(input);
    }
    const targets = await getPublishTargets(input.projectId);
    if (targets.length === 0) {
      return {
        status: "SKIPPED",
        message: "No connected Meta page/Instagram account",
      };
    }
    const released = await isInstagramPublishScheduled(input.projectId);
    // A piece with a planned time (a content-plan slot) goes out at that
    // time, not the moment it is approved: approving a Thursday post on
    // Monday must not post it on Monday. It stays APPROVED; once a
    // Publishing schedule exists publishNextQueuedInstagramCreative releases
    // it when its time has come (it only takes pieces whose scheduledFor has
    // passed), and the content plan's "next step" offers to turn one on.
    if (creative.scheduledFor && creative.scheduledFor.getTime() > Date.now()) {
      return {
        status: "QUEUED",
        message: released
          ? "Waiting for its planned time"
          : "Waiting for its planned time — scheduled posting is off",
        plannedFor: creative.scheduledFor,
        released,
      };
    }
    if (released) {
      // Leave it APPROVED — publishNextQueuedInstagramCreative finds it via
      // the same query at the next due slot. No task, no side effect yet.
      return {
        status: "QUEUED",
        message: "Waiting for the next scheduled Instagram slot",
      };
    }
    const result = await publishCreativeCore({
      creativeId: input.creativeId,
      format: "FEED",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorUserId: AUTO_PUBLISH_ACTOR_ID,
    });
    return {
      status: result.ok ? "PUBLISHED" : "SKIPPED",
      message: result.message,
      cardUpdated: result.ok ? result.cardUpdated : undefined,
    };
  } catch (error) {
    console.error("[approval-decisions] auto-publish failed:", error);
    return {
      status: "SKIPPED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// Finds the next APPROVED Instagram creative in this project that isn't
// already mid-flight through a publish task — the "queue" a Publishing
// schedule releases from one at a time. No dedicated table: an
// INSTAGRAM_PUBLISH task's payload.creativeId (set by publishCreativeCore)
// is the only bookkeeping needed to avoid double-submitting the same
// creative while its task is still pending/running.
//
// Ordering: a creative the content calendar (takvim) assigned to a
// specific day+time goes out at that instant, in schedule order, ahead of
// everything unscheduled — a creative scheduled for a FUTURE instant is
// excluded entirely (not just deprioritized) so the calendar's placement
// is authoritative rather than advisory. Anything with no time assigned
// falls back to the original oldest-first FIFO, exactly as before the
// calendar existed. scheduledFor is a real UTC instant (see schema
// comment), so "due" is a plain instant comparison — no timezone
// conversion needed here; that only happens where a human enters/reads a
// wall-clock time (src/lib/timezone.ts, used by the takvim UI/action).
async function findNextQueuedInstagramCreativeId(
  projectId: string,
): Promise<QueuedCreative | null> {
  if (isWorksEnabled()) return findNextQueuedForWorks(projectId);
  const now = new Date();
  const [inFlightTasks, candidates] = await Promise.all([
    prisma.task.findMany({
      where: {
        projectId,
        capability: "INSTAGRAM_PUBLISH",
        status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] },
      },
      select: { payload: true },
    }),
    prisma.creative.findMany({
      where: {
        projectId,
        platform: "INSTAGRAM",
        status: "APPROVED",
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      },
      orderBy: [
        { scheduledFor: { sort: "asc", nulls: "last" } },
        { updatedAt: "asc" },
      ],
      select: { id: true },
    }),
  ]);
  const inFlightCreativeIds = new Set(
    inFlightTasks
      .map(
        (task) => (task.payload as { creativeId?: unknown } | null)?.creativeId,
      )
      .filter((id): id is string => typeof id === "string"),
  );
  const next = candidates.find(
    (creative) => !inFlightCreativeIds.has(creative.id),
  );
  return next ? { id: next.id, format: "FEED" } : null;
}

type QueuedCreative = { id: string; format: "FEED" | "STORIES" };

function creativeIdOfTask(payload: unknown): string | null {
  const id = (payload as { creativeId?: unknown } | null)?.creativeId;
  return typeof id === "string" ? id : null;
}

// Works only: the same queue, but a Work-owned candidate that cannot publish
// (manual format, no asset, no time, older than 24 h) or that failed to post in
// the last 24 h is skipped instead of blocking the head of the line. Candidates
// that are not Work-owned keep the legacy rule (null formatKey = FEED, null
// time released oldest-first), except that one which failed in the last 24 h or
// has no image is skipped too, so it cannot starve the pieces behind it.
async function findNextQueuedForWorks(
  projectId: string,
): Promise<QueuedCreative | null> {
  const now = new Date();
  const failedSince = new Date(now.getTime() - FAILED_PUBLISH_COOLDOWN_MS);
  const [tasks, candidates] = await Promise.all([
    prisma.task.findMany({
      where: {
        projectId,
        capability: "INSTAGRAM_PUBLISH",
        OR: [
          { status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } },
          { status: "FAILED", updatedAt: { gte: failedSince } },
        ],
      },
      select: { payload: true, status: true },
    }),
    prisma.creative.findMany({
      where: {
        projectId,
        platform: "INSTAGRAM",
        status: "APPROVED",
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      },
      orderBy: [
        { scheduledFor: { sort: "asc", nulls: "last" } },
        { updatedAt: "asc" },
      ],
      select: {
        id: true,
        planId: true,
        formatKey: true,
        scheduledFor: true,
        status: true,
        platform: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { assetId: true },
        },
      },
    }),
  ]);
  const inFlight = new Set<string>();
  const recentlyFailed = new Set<string>();
  for (const task of tasks) {
    const id = creativeIdOfTask(task.payload);
    if (!id) continue;
    (task.status === "FAILED" ? recentlyFailed : inFlight).add(id);
  }

  const planIds = candidates
    .map((c) => c.planId)
    .filter((id): id is string => id !== null);
  const owned = await ownedPlanIds(planIds);
  const hasOwned = candidates.some((c) => c.planId && owned.has(c.planId));
  const connected = hasOwned
    ? new Set((await getPublishTargets(projectId)).map((t) => t.platform))
    : new Set<string>();

  for (const creative of candidates) {
    if (inFlight.has(creative.id)) continue;
    if (!creative.planId || !owned.has(creative.planId)) {
      // A legacy candidate that already failed in the last 24 h, or that has
      // no image to post, must not sit at the head of the line and starve the
      // Work-owned pieces behind it (a failed core call just ends the tick).
      if (recentlyFailed.has(creative.id)) continue;
      if (!creative.versions[0]?.assetId) continue;
      return {
        id: creative.id,
        format: creative.formatKey === "instagram.story" ? "STORIES" : "FEED",
      };
    }
    if (recentlyFailed.has(creative.id)) continue;
    const decision = canPublishNow(
      {
        status: creative.status,
        platform: creative.platform,
        formatKey: creative.formatKey,
        hasAsset: Boolean(creative.versions[0]?.assetId),
        scheduledFor: creative.scheduledFor,
        connectedPlatforms: connected,
      },
      "auto",
      now,
    );
    if (decision.ok) return { id: creative.id, format: decision.format };
  }
  return null;
}

// Called by SchedulerService.runDueSchedules when a Publishing-tab schedule
// (capability INSTAGRAM_PUBLISH, configuration.mode "PUBLISH_NEXT_READY")
// comes due — mirrors applyApprovalDecision's immediate-publish sequence
// (publish, then propose a Meta campaign, then post the same confirmation
// to chat) but for whichever creative is next in the queue rather than the
// one that was just approved. An empty queue is a normal no-op.
export async function publishNextQueuedInstagramCreative(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
}): Promise<void> {
  try {
    const next = await findNextQueuedInstagramCreativeId(input.projectId);
    if (!next) return;
    const creativeId = next.id;

    const result = await publishCreativeCore({
      creativeId,
      format: next.format,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorUserId: AUTO_PUBLISH_ACTOR_ID,
    });
    if (!result.ok) return;

    await maybeProposeMetaCampaign({
      creativeId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
    });

    // The creative's own card already shows "Published" via
    // markCreativePublishState (see publishCreativeCore) when it found a
    // matching row — only fall back to a plain chat message when it didn't.
    if (result.cardUpdated) return;

    const target = await resolveIdeaAndTitleForCreative(creativeId);
    if (target?.ideaId) {
      await IdeaChatRepository.postSystemMessage({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ideaId: target.ideaId,
        text: `✅ ${target.title} published to Instagram (scheduled slot).`,
      });
    }
  } catch (error) {
    console.error("[approval-decisions] scheduled publish failed:", error);
  }
}

// Proposes a new Meta ad campaign for the idea behind a just-auto-published
// creative, when the idea's lens fits paid media and a Meta ads account is
// connected. Never throws — this runs on applyApprovalDecision's critical
// path, and every gate below is a legitimate "not applicable, skip
// quietly" case, not an error.
export async function maybeProposeMetaCampaign(input: {
  creativeId: string;
  workspaceId: string;
  projectId: string;
  brandId: string;
}): Promise<void> {
  try {
    const creative = await prisma.creative.findUnique({
      where: { id: input.creativeId },
      select: { createdByTaskId: true, currentVersionId: true },
    });
    if (!creative?.createdByTaskId) return;

    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(
      creative.createdByTaskId,
    );
    if (!ideaId) return;

    const idea = await IdeaRepository.findByIdInProject(
      ideaId,
      input.projectId,
    );
    if (!idea || !idea.lens || !PAID_MEDIA_LENSES.has(idea.lens)) return;

    const hasAdsAccount = await hasActiveMetaAdsAccount(input.projectId);
    if (!hasAdsAccount) return;

    const version = creative.currentVersionId
      ? await prisma.creativeVersion.findUnique({
          where: { id: creative.currentVersionId },
          select: { assetId: true, caption: true, copy: true },
        })
      : null;
    // No image asset -> no ad creative possible. Shouldn't happen right
    // after a successful auto-publish (which itself required an asset),
    // but this function can in principle be reached independently later.
    if (!version?.assetId) return;

    const fingerprint = taskFingerprint({
      capability: "META_CAMPAIGN_CREATE",
      department: "PERFORMANCE_MARKETING",
      subject: idea.id,
    });
    const policy = await AutonomyPolicyRepository.getOrCreate({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
    });
    const since = new Date(Date.now() - policy.taskCooldownHours * 3600_000);
    const duplicate = await TaskRepository.findRecentByFingerprint(
      input.projectId,
      fingerprint,
      since,
    );
    if (duplicate) return;

    try {
      await AutonomyPolicyRepository.checkAndIncrement(
        {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
        },
        "tasksCreated",
      );
    } catch {
      return; // Daily task cap reached — skip, same as agency-director.ts.
    }

    const [brand, project, opportunityGoalIds] = await Promise.all([
      prisma.brand.findUnique({
        where: { id: input.brandId },
        select: { name: true },
      }),
      prisma.project.findUnique({
        where: { id: input.projectId },
        select: { domain: true, country: true },
      }),
      idea.opportunityId
        ? prisma.opportunity
            .findUnique({
              where: { id: idea.opportunityId },
              select: { goalIds: true },
            })
            .then((o) => o?.goalIds ?? [])
        : Promise.resolve([] as string[]),
    ]);

    const { output: brief } = await ReasoningService.run(metaCampaignBriefDef, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      context: {
        idea: {
          title: idea.title,
          description: idea.description,
          lens: idea.lens,
        },
        brand: {
          name: brand?.name,
          domain: project?.domain,
          country: project?.country,
        },
        creative: { caption: version.caption, copy: version.copy },
        maxDailyBudgetUsd: policy.maxCampaignDailyBudgetUsd,
      },
    });

    // The LLM's proposal is a suggestion, not the real ceiling — always
    // clamp to the project's own configured cap before anything reaches a
    // Task an approver will see.
    const clampedBudgetCents = Math.min(
      brief.dailyBudgetCents,
      Math.round(policy.maxCampaignDailyBudgetUsd * 100),
    );
    const budgetUsd = (clampedBudgetCents / 100).toFixed(2);

    await TaskPlanner.planForCapability({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      capability: "META_CAMPAIGN_CREATE",
      request: `Meta kampanyası: ${brief.campaignName} ($${budgetUsd}/gün)`,
      createdByType: "SYSTEM",
      departmentKey: "PERFORMANCE_MARKETING",
      fingerprint,
      goalIds: opportunityGoalIds,
      payloadExtra: {
        name: brief.campaignName,
        objective: brief.objective,
        dailyBudgetCents: clampedBudgetCents,
        // Approval already IS the spend-authorization step (LEVEL_4) — a
        // campaign left PAUSED after approval would just recreate the same
        // "approved but nobody flips the last switch" bug this whole
        // feature exists to close.
        status: "ACTIVE",
        __pendingAdSet: {
          name: `${brief.campaignName} — Ad Set`.slice(0, 120),
          dailyBudgetCents: clampedBudgetCents,
          billingEvent: "IMPRESSIONS",
          optimizationGoal: brief.optimizationGoal,
          targeting: { countries: brief.targetCountries },
          pendingAd: {
            name: brief.adName,
            message: brief.adMessage,
            link: brief.adLink,
            imageAssetId: version.assetId,
          },
        },
      },
    });
  } catch (error) {
    console.error("[approval-decisions] meta campaign proposal failed:", error);
  }
}

// Both approveApprovalAction/rejectApprovalAction (web, src/server/actions/
// approval-actions.ts) AND the Telegram approval poller
// (src/server/integrations/telegram-approval-poller.ts) share this function.
// Session/tenant checks and revalidatePath are deliberately left OUT — the
// poller has neither a session nor a request context whose Next.js page
// cache needs revalidating.
export async function applyApprovalDecision(input: {
  approval: Approval;
  to: "APPROVED" | "REJECTED";
  reviewedByUserId: string;
  actorType: ActorType;
}): Promise<void> {
  const { approval, to, reviewedByUserId, actorType } = input;

  // A task that can never run is not approved into a failure. Approving is
  // terminal (the approval cannot be decided again), and the dispatch that
  // follows would fail for good, leaving a dead task and buttons that no longer
  // work. So the task is checked first: on a miss the approval stays PENDING and
  // the client can still reject it. This also covers approvals created before
  // the platform check existed.
  if (to === "APPROVED" && approval.entityType === "Task" && approval.taskId) {
    const missing = await TaskPlanner.missingInputFor(
      approval.taskId,
      approval.projectId,
    );
    if (missing) {
      throw new AgentelseError("INVALID_INPUT", missingInputAdvice(missing));
    }
  }

  await ApprovalRepository.decide(
    approval.id,
    approval.projectId,
    to,
    reviewedByUserId,
  );

  if (approval.entityType === "Task" && approval.taskId) {
    if (to === "APPROVED") {
      await TaskPlanner.dispatchApprovedTask(
        approval.taskId,
        approval.projectId,
      );
    } else {
      await TaskRepository.transition(
        approval.taskId,
        approval.projectId,
        "CANCELLED",
        { failureReason: "Rejected by approver" },
      );
    }
  }
  // Deliberately OUTSIDE the `if (target)` block below — auto-publish
  // (and, transitively, the campaign proposal) must run for every approved
  // Creative, including ones with no resolvable idea (resolveApprovalChatTarget's
  // Creative branch returns null there, but that's a chat-thread lookup
  // concern, not a reason to skip the actual publish).
  let autoPublishResult: AutoPublishResult | null = null;
  if (approval.entityType === "Creative") {
    await CreativeRepository.transition(
      approval.entityId,
      approval.projectId,
      to === "APPROVED" ? "APPROVED" : "REJECTED",
    );
    // What the client just decided about a finished piece is a signal about
    // their taste. Kept as a tentative memory, never a rule after one decision
    // (MemoryService.rememberCreativeReaction never throws).
    await MemoryService.rememberCreativeReaction({
      scope: {
        workspaceId: approval.workspaceId,
        projectId: approval.projectId,
        brandId: approval.brandId,
      },
      creativeId: approval.entityId,
      outcome: to,
    });

    if (to === "APPROVED") {
      autoPublishResult = await autoPublishCreative({
        creativeId: approval.entityId,
        workspaceId: approval.workspaceId,
        projectId: approval.projectId,
      });
      if (autoPublishResult.status === "PUBLISHED") {
        await maybeProposeMetaCampaign({
          creativeId: approval.entityId,
          workspaceId: approval.workspaceId,
          projectId: approval.projectId,
          brandId: approval.brandId,
        });
      }
    }
  }

  // Approval decisions are also subject to the "golden rule": who
  // approved/rejected what should show up here, in the idea's own chat,
  // without going to a separate panel. Best-effort — if it can't be linked
  // to an idea (a task/creative with no idea), it's silently skipped.
  try {
    const target = await resolveApprovalChatTarget(approval);
    if (target) {
      if (approval.entityType === "Creative") {
        // Unlike Task, we do NOT convert the card into a generic
        // "approval-decision" card — the creative-ready card already
        // carries the image/title, so only the status field is updated to
        // avoid losing it (see resolveCreativeApprovalDecision). ideaId may
        // be null (no idea lineage) — resolveCreativeApprovalDecision and
        // postSystemMessage below are both null-safe on it.
        await IdeaChatRepository.resolveCreativeApprovalDecision({
          ideaId: target.ideaId,
          creativeId: approval.entityId,
          status: to,
        });

        // If approved, drop a SEPARATE turn into the chat instead of
        // updating the same row — the creative-ready card already carries
        // the image/title, this is a distinct follow-up event.
        if (to === "APPROVED") {
          if (autoPublishResult?.status === "PUBLISHED") {
            // Auto-published above — no question needed, just confirm it
            // happened (this is what used to be a silent "sat there for 11
            // days" gap). Skipped when the creative's own card already
            // mirrors the publish state (markCreativePublishState) — no
            // separate row needed on top of it.
            if (!autoPublishResult.cardUpdated) {
              await IdeaChatRepository.postSystemMessage({
                workspaceId: approval.workspaceId,
                projectId: approval.projectId,
                ideaId: target.ideaId,
                text: `✅ ${target.title} approved and published to Instagram automatically.`,
              });
            }
          } else if (autoPublishResult?.status === "QUEUED") {
            // A Publishing schedule is active for this project — the
            // creative stays APPROVED and publishNextQueuedInstagramCreative
            // will pick it up at the next slot. Deliberately NOT the
            // ask-flow below: prompting "want to share it?" here would
            // invite a manual publish that skips the queue entirely.
            const planned = autoPublishResult.plannedFor;
            await IdeaChatRepository.postSystemMessage({
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              ideaId: target.ideaId,
              text: autoPublishResult.held
                ? `✅ ${target.title} approved — on hold until you set a time or post it now.`
                : planned
                  ? await plannedApprovalText(
                      approval.projectId,
                      target.title,
                      planned,
                      autoPublishResult.released === true,
                    )
                  : `✅ ${target.title} approved — queued for the next scheduled Instagram slot.`,
            });
          } else if (
            autoPublishResult?.status === "SKIPPED" &&
            autoPublishResult.reason
          ) {
            // Works: a hand-posted format or another channel's piece. Nothing
            // here can post it, so no share prompt (web or Telegram) is
            // offered: its Post / Story buttons would send the cover image to
            // Instagram as a single feed photo.
            await IdeaChatRepository.postSystemMessage({
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              ideaId: target.ideaId,
              text: `✅ ${target.title} approved — you post this one yourself.`,
            });
          } else {
            // Auto-publish didn't apply or failed (not an Instagram
            // creative, no Meta connection, a real error) — fall back to
            // the original ask-flow so a human can still act on it, same
            // as before this feature existed.
            await IdeaChatRepository.postSystemMessage({
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              ideaId: target.ideaId,
              text: `📤 ${target.title} approved — want to share it on social media?`,
              card: {
                kind: "publish-prompt",
                creativeId: approval.entityId,
                title: target.title,
              },
            });
            // Send the same question to Telegram too — so the user can pick
            // "Post"/"Story"/"No" directly from Telegram without opening the
            // web app (see telegram-approval-poller.ts pubfeed/pubstory/pubskip).
            await sendPublishPromptToTelegram({
              projectId: approval.projectId,
              creativeId: approval.entityId,
              title: target.title,
            });
          }
        }
      } else {
        // If the chat already has an OPEN "approval-request" card for the
        // task (see TaskPlanner.planForCapability -> postApprovalRequestCard)
        // that SAME row is updated with the result — the Approve/Reject
        // buttons disappear along with the decision, no second card appears.
        await IdeaChatRepository.resolveApprovalDecisionCard({
          workspaceId: approval.workspaceId,
          projectId: approval.projectId,
          ideaId: target.ideaId,
          approvalId: approval.id,
          text:
            to === "APPROVED"
              ? `✅ Approved: ${target.title}`
              : `❌ Rejected: ${target.title}`,
          card: {
            kind: "approval-decision",
            title: target.title,
            entityType: approval.entityType as "Task" | "Creative",
            decision: to,
          },
        });
      }
    }
  } catch (error) {
    console.error(
      "[approval-decisions] failed to write approval-decision card:",
      error,
    );
  }

  await AuditLogRepository.record({
    workspaceId: approval.workspaceId,
    projectId: approval.projectId,
    brandId: approval.brandId,
    actorType,
    actorId: reviewedByUserId,
    action: to === "APPROVED" ? "approval.approved" : "approval.rejected",
    entityType: "Approval",
    entityId: approval.id,
  });
}
