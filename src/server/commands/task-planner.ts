import "server-only";

import type {
  ActorType,
  ApprovalLevel,
  CapabilityKey,
  DepartmentKey,
  RiskLevel,
  SocialPlatform,
} from "@prisma/client";

import { isMetaSpendWrite } from "@/lib/execution-backlog";
import { TaskRepository } from "@/server/repositories/task.repository";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { ContextSnapshotService } from "@/server/context/context-snapshot.service";
import {
  ApprovalPolicy,
  isAutoExecutable,
  maxLevel,
} from "@/server/execution/approval-policy";
import {
  approvalCategory,
  buildApprovalDetails,
} from "@/server/execution/approval-details";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { missingCapabilityInput } from "@/server/execution/capability-input";
import { ExecutionService } from "@/server/execution/execution-service";

export type PlanCapabilityInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  commandId?: string;
  capability: CapabilityKey;
  targetPlatform?: SocialPlatform;
  request: string;
  // Short display title (chat cards, task lists). Defaults to the first 80
  // characters of `request`, which reads badly when the request is a long
  // structured brief.
  title?: string;
  createdByType: ActorType;
  createdByUserId?: string;
  // Agency OS optional fields — legacy callers omit all of these and get
  // byte-for-byte the old behavior.
  departmentKey?: DepartmentKey;
  workPlanId?: string;
  goalIds?: string[];
  fingerprint?: string;
  sourceDecisionId?: string;
  approvalLevel?: ApprovalLevel;
  approvalOverrides?: Partial<Record<string, ApprovalLevel>> | null;
  // When true the task is created (READY, or BLOCKED behind dependencies)
  // but NOT dispatched — WorkPlanProgressor dispatches it when its
  // dependencies complete.
  deferDispatch?: boolean;
  payloadExtra?: Record<string, unknown>;
  // The content this publish carries was already approved by a person
  // (its Creative is APPROVED — see publish-creative.ts). Approving the
  // creative IS the publish decision in the calendar model, so a
  // *_PUBLISH task built from it must not park for a second approval.
  // Only lowers the plain L3 publish floor; spend (L4) and any explicit
  // per-project override still apply.
  contentApproved?: boolean;
  // Meta Ads otomatik pilotu (F7): yalnız AdsAutopilot doldurur; seviye
  // istisnası approval-policy.ts'te (autopilotLowers).
  adsAutonomy?: "SUGGEST" | "GUARDED" | "FULL";
  riskReducing?: boolean;
  autoBudgetRaise?: boolean;
};

// Turns a single resolved capability into a Task, and either dispatches it
// immediately (low-risk, no approval needed) or parks it behind an Approval
// (spec section 28: publish/account-setup/campaign-write actions never run
// unattended). Multi-task plans (dependent chains) build on top of this by
// calling planForCapability per step and wiring TaskRepository.addDependency.
// Meta harcama onaylarının geçerlilik süresi (docs/meta-ads-plan.md F0b).
export const META_APPROVAL_TTL_MS = 72 * 60 * 60_000;

export const TaskPlanner = {
  async planForCapability(input: PlanCapabilityInput) {
    const riskLevel = ExecutionPolicy.defaultRiskLevel(input.capability);
    // Approval level: explicit caller level wins (it may only be stricter —
    // ApprovalPolicy floors are re-applied via maxLevel semantics below),
    // otherwise resolve from policy. Legacy callers land on exactly the old
    // requiresApproval boundary because the legacy capability set IS the L3
    // floor inside ApprovalPolicy.
    const resolvedLevel = ApprovalPolicy.resolveLevel(input.capability, {
      createdByType: input.createdByType,
      riskLevel,
      approvalOverrides: input.approvalOverrides,
      adsAutonomy: input.adsAutonomy,
      riskReducing: input.riskReducing,
      autoBudgetRaise: input.autoBudgetRaise,
    });
    // Caller-supplied level may only RAISE strictness, never lower it.
    const requestedLevel = input.approvalLevel
      ? maxLevel(resolvedLevel, input.approvalLevel)
      : resolvedLevel;
    const level =
      input.contentApproved &&
      input.capability.endsWith("_PUBLISH") &&
      requestedLevel === "LEVEL_3_CLIENT" &&
      !input.approvalOverrides?.[input.capability]
        ? "LEVEL_2_AGENCY_DIRECTOR"
        : requestedLevel;
    const requiresApproval = !isAutoExecutable(level);
    const requiresVerification = ExecutionPolicy.requiresVerification(
      input.capability,
    );

    const task = await TaskRepository.create({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      commandId: input.commandId,
      title: (input.title ?? input.request).slice(0, 80),
      description: input.request,
      payload: {
        request: input.request,
        platform: input.targetPlatform,
        ...(input.payloadExtra ?? {}),
      },
      capability: input.capability,
      riskLevel,
      createdByType: input.createdByType,
      createdByUserId: input.createdByUserId,
      requiresApproval,
      requiresVerification,
      departmentKey: input.departmentKey,
      workPlanId: input.workPlanId,
      goalIds: input.goalIds,
      fingerprint: input.fingerprint,
      sourceDecisionId: input.sourceDecisionId,
    });

    const snapshot = await ContextSnapshotService.create({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      capability: input.capability,
    });

    const payload = {
      request: input.request,
      platform: input.targetPlatform,
      ...(input.payloadExtra ?? {}),
    };

    if (input.deferDispatch) {
      // Plan-node task: stays READY regardless of requiresApproval —
      // WorkPlanProgressor.dispatchReadyTasks only acts on it once its
      // dependencies are COMPLETED, and decides then whether to park it for
      // approval (via requestApproval) or dispatch it straight to
      // execution. Parking it here, before its dependencies have run, would
      // let a human approve a task built on data that doesn't exist yet.
      return {
        task,
        dispatched: false as const,
        level,
        deferred: true as const,
      };
    }

    if (requiresApproval) {
      return TaskPlanner.requestApproval(task, level);
    }

    await TaskRepository.transition(task.id, input.projectId, "QUEUED");
    const job = await ExecutionService.dispatch({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      taskId: task.id,
      capability: input.capability,
      riskLevel,
      contextSnapshotId: snapshot.id,
      payload,
    });

    return { task, dispatched: true as const, job, level };
  },

  // What a task waiting for approval still lacks to be runnable (see
  // capability-input.ts), or null. Asked BEFORE an approval is consumed:
  // approving is terminal, so a task that can never run must not be approved
  // into a failure the client can neither retry nor reject.
  async missingInputFor(taskId: string, projectId: string) {
    const task = await TaskRepository.findByIdInProject(taskId, projectId);
    if (!task) return null;
    const payload = (task.payload ?? {}) as { platform?: unknown };
    return missingCapabilityInput(task.capability, {
      platform: payload.platform,
    });
  },

  // Called once an Approval tied to a WAITING_APPROVAL task is APPROVED —
  // this is what actually queues the execution that was held back.
  async dispatchApprovedTask(taskId: string, projectId: string) {
    const task = await TaskRepository.findByIdInProject(taskId, projectId);
    if (!task) return null;

    const snapshot = await ContextSnapshotService.create({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
      capability: task.capability,
    });

    await TaskRepository.transition(task.id, projectId, "QUEUED");

    try {
      return await ExecutionService.dispatch({
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        brandId: task.brandId,
        taskId: task.id,
        capability: task.capability,
        riskLevel: task.riskLevel,
        contextSnapshotId: snapshot.id,
        payload: task.payload ?? { request: task.description ?? "" },
      });
    } catch (error) {
      // No ExecutionJob was created, so nothing would ever move this task
      // out of QUEUED again — fail it so its work plan can cascade/resolve.
      await TaskRepository.transition(task.id, projectId, "FAILED", {
        failureReason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
  },

  // Parks a task behind an Approval and posts the chat card. Shared by the
  // immediate path (planForCapability, level already resolved) and
  // WorkPlanProgressor.dispatchReadyTasks (deferred node becomes ready,
  // level re-resolved from the persisted task — the callers that use
  // deferDispatch never pass approvalOverrides, so this matches the
  // original resolution exactly).
  async requestApproval(
    task: {
      id: string;
      workspaceId: string;
      projectId: string;
      brandId: string;
      title: string;
      capability: CapabilityKey;
      riskLevel: RiskLevel;
      createdByType: ActorType;
      createdByUserId: string | null;
      departmentKey: DepartmentKey | null;
      payload?: unknown;
    },
    level?: ApprovalLevel,
  ) {
    const resolvedLevel =
      level ??
      ApprovalPolicy.resolveLevel(task.capability, {
        createdByType: task.createdByType,
        riskLevel: task.riskLevel,
      });

    await TaskRepository.transition(
      task.id,
      task.projectId,
      "WAITING_APPROVAL",
    );
    const approval = await ApprovalRepository.create({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
      taskId: task.id,
      entityType: "Task",
      entityId: task.id,
      type: publishApprovalType(task.capability),
      level: resolvedLevel,
      requestedByType: task.createdByType,
      requestedById: task.createdByUserId ?? undefined,
      // Meta harcama onayları 72 saat geçerlidir: daha eski bir onay bugünkü
      // bütçe ve hesap bağlamıyla çalışmaz (docs/meta-ads-plan.md F0b).
      expiresAt: isMetaSpendWrite(task.capability)
        ? new Date(Date.now() + META_APPROVAL_TTL_MS)
        : undefined,
    });

    // "Golden rule": the moment a task is parked for approval, it should
    // show up in the chat AT THE SAME TIME — the Approve/Reject card can
    // be handled right here, with no need to search a separate Approvals
    // panel (see idea-event-card.tsx ApprovalRequestCard). Best-effort,
    // skipped if it can't be linked to an idea.
    await IdeaChatRepository.postApprovalRequestCard({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      approvalId: approval.id,
      title: task.title,
      riskLevel: task.riskLevel,
      departmentKey: task.departmentKey ?? undefined,
      details: buildApprovalDetails(task.capability, task.payload),
      category: approvalCategory(approval.type, approval.level),
    }).catch((error) => {
      console.error("[task-planner] postApprovalRequestCard failed:", error);
    });

    return { task, dispatched: false as const, level: resolvedLevel };
  },
};

function publishApprovalType(capability: CapabilityKey) {
  if (capability === "SOCIAL_ACCOUNT_SETUP")
    return "ACCOUNT_ACTION_APPROVAL" as const;
  if (capability.endsWith("_PUBLISH")) return "PUBLISH_APPROVAL" as const;
  if (
    capability.startsWith("META_CAMPAIGN") ||
    capability === "META_ADSET_CREATE" ||
    capability === "META_ADSET_UPDATE" ||
    capability === "META_AD_CREATE" ||
    capability === "META_AD_UPDATE" ||
    capability === "META_SAFETY_ACTION" ||
    capability === "META_LAUNCH" ||
    capability.startsWith("GOOGLE_ADS_CAMPAIGN")
  ) {
    return "CAMPAIGN_APPROVAL" as const;
  }
  return "GENERIC" as const;
}
