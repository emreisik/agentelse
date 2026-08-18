import "server-only";

import type {
  ActorType,
  ApprovalLevel,
  CapabilityKey,
  DepartmentKey,
  SocialPlatform,
} from "@prisma/client";

import { TaskRepository } from "@/server/repositories/task.repository";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { ContextSnapshotService } from "@/server/context/context-snapshot.service";
import {
  ApprovalPolicy,
  isAutoExecutable,
  maxLevel,
} from "@/server/execution/approval-policy";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { ExecutionService } from "@/server/execution/execution-service";

export type PlanCapabilityInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  commandId?: string;
  capability: CapabilityKey;
  targetPlatform?: SocialPlatform;
  request: string;
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
};

// Turns a single resolved capability into a Task, and either dispatches it
// immediately (low-risk, no approval needed) or parks it behind an Approval
// (spec section 28: publish/account-setup/campaign-write actions never run
// unattended). Multi-task plans (dependent chains) build on top of this by
// calling planForCapability per step and wiring TaskRepository.addDependency.
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
    });
    // Caller-supplied level may only RAISE strictness, never lower it.
    const level = input.approvalLevel
      ? maxLevel(resolvedLevel, input.approvalLevel)
      : resolvedLevel;
    const requiresApproval = !isAutoExecutable(level);
    const requiresVerification = ExecutionPolicy.requiresVerification(
      input.capability,
    );

    const task = await TaskRepository.create({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      commandId: input.commandId,
      title: input.request.slice(0, 80),
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

    if (requiresApproval) {
      await TaskRepository.transition(
        task.id,
        input.projectId,
        "WAITING_APPROVAL",
      );
      const approval = await ApprovalRepository.create({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        taskId: task.id,
        entityType: "Task",
        entityId: task.id,
        type: publishApprovalType(input.capability),
        level,
        requestedByType: input.createdByType,
        requestedById: input.createdByUserId,
      });

      // "Altın kural": görev onaya park edilince sohbette AYNI anda
      // görünür olsun — ayrı bir Onaylar panelinde aramaya gerek kalmadan
      // Onayla/Reddet kartı buradan da işlenebilir (bkz. idea-event-card.tsx
      // ApprovalRequestCard). Best-effort, fikre bağlanamıyorsa atlanır.
      await IdeaChatRepository.postApprovalRequestCard({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        taskId: task.id,
        approvalId: approval.id,
        title: task.title,
        riskLevel,
        departmentKey: input.departmentKey,
      }).catch((error) => {
        console.error("[task-planner] postApprovalRequestCard failed:", error);
      });

      return { task, dispatched: false as const, level };
    }

    if (input.deferDispatch) {
      // Plan-node task: stays READY (or is BLOCKED by the plan builder);
      // WorkPlanProgressor dispatches it when dependencies complete.
      return {
        task,
        dispatched: false as const,
        level,
        deferred: true as const,
      };
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

    return ExecutionService.dispatch({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      brandId: task.brandId,
      taskId: task.id,
      capability: task.capability,
      riskLevel: task.riskLevel,
      contextSnapshotId: snapshot.id,
      payload: task.payload ?? { request: task.description ?? "" },
    });
  },
};

function publishApprovalType(capability: CapabilityKey) {
  if (capability === "SOCIAL_ACCOUNT_SETUP")
    return "ACCOUNT_ACTION_APPROVAL" as const;
  if (capability.endsWith("_PUBLISH")) return "PUBLISH_APPROVAL" as const;
  if (
    capability.startsWith("META_CAMPAIGN") ||
    capability.startsWith("GOOGLE_ADS_CAMPAIGN")
  ) {
    return "CAMPAIGN_APPROVAL" as const;
  }
  return "GENERIC" as const;
}
