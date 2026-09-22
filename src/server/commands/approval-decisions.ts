import "server-only";

import type { ActorType, Approval, CreativeLens } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { sendPublishPromptToTelegram } from "@/server/notifications/telegram-approval-notifier";
import { publishCreativeCore } from "@/server/commands/publish-creative";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { hasActiveMetaAdsAccount } from "@/server/execution/providers/meta/meta-api-provider";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { metaCampaignBriefDef } from "@/server/reasoning/prompts/meta-campaign-brief";

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
    const creative = await prisma.creative.findUnique({
      where: { id: approval.entityId },
      select: { createdByTaskId: true },
    });
    if (!creative?.createdByTaskId) return null;
    const [ideaId, task] = await Promise.all([
      IdeaChatRepository.resolveIdeaIdForTask(creative.createdByTaskId),
      prisma.task.findUnique({
        where: { id: creative.createdByTaskId },
        select: { title: true },
      }),
    ]);
    if (!ideaId) return null;
    return { ideaId, title: task?.title ?? "Creative" };
  }

  return null;
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
}): Promise<{ ok: boolean; message: string }> {
  try {
    const creative = await prisma.creative.findUnique({
      where: { id: input.creativeId },
      select: { platform: true },
    });
    // Only Instagram is autonomously reachable today — TikTok/LinkedIn/X
    // publishing (publishCreativeToSocialCore) stays human-triggered.
    if (creative?.platform !== "INSTAGRAM") {
      return { ok: false, message: "Not an Instagram creative" };
    }
    const targets = await getPublishTargets(input.projectId);
    if (targets.length === 0) {
      return { ok: false, message: "No connected Meta page/Instagram account" };
    }
    return await publishCreativeCore({
      creativeId: input.creativeId,
      format: "FEED",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorUserId: AUTO_PUBLISH_ACTOR_ID,
    });
  } catch (error) {
    console.error("[approval-decisions] auto-publish failed:", error);
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
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
  let autoPublishResult: { ok: boolean; message: string } | null = null;
  if (approval.entityType === "Creative") {
    await CreativeRepository.transition(
      approval.entityId,
      approval.projectId,
      to === "APPROVED" ? "APPROVED" : "REJECTED",
    );

    if (to === "APPROVED") {
      autoPublishResult = await autoPublishCreative({
        creativeId: approval.entityId,
        workspaceId: approval.workspaceId,
        projectId: approval.projectId,
      });
      if (autoPublishResult.ok) {
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
        // Non-null: resolveApprovalChatTarget's Creative branch already
        // returns null (not a target with a null ideaId) when no idea can
        // be resolved — unlike the Task branch, creatives are always
        // idea-scoped (see the function above).
        const creativeIdeaId = target.ideaId!;
        // Unlike Task, we do NOT convert the card into a generic
        // "approval-decision" card — the creative-ready card already
        // carries the image/title, so only the status field is updated to
        // avoid losing it (see resolveCreativeApprovalDecision).
        await IdeaChatRepository.resolveCreativeApprovalDecision({
          ideaId: creativeIdeaId,
          creativeId: approval.entityId,
          status: to,
        });

        // If approved, drop a SEPARATE turn into the chat instead of
        // updating the same row — the creative-ready card already carries
        // the image/title, this is a distinct follow-up event.
        if (to === "APPROVED") {
          if (autoPublishResult?.ok) {
            // Auto-published above — no question needed, just confirm it
            // happened (this is what used to be a silent "sat there for 11
            // days" gap).
            await IdeaChatRepository.postSystemMessage({
              workspaceId: approval.workspaceId,
              projectId: approval.projectId,
              ideaId: target.ideaId,
              text: `✅ ${target.title} approved and published to Instagram automatically.`,
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
