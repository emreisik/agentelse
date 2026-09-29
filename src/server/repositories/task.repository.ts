import "server-only";

import type {
  CapabilityKey,
  DepartmentKey,
  RiskLevel,
  TaskStatus,
  ActorType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgencyTriggerRepository } from "@/server/repositories/agency-trigger.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { ExecutionPolicy } from "@/server/execution/execution-policy";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";
import { notifyProjectTelegram } from "@/server/notifications/project-telegram-notifier";
import {
  extractResultText,
  shouldExpandTaskResult,
} from "@/lib/execution-result-text";
import { PLATFORM_LABEL } from "@/lib/labels";

// When a task completes/fails/is cancelled, if that task is linked to an
// idea (via a work plan, or requested directly via a command from that
// idea's chat — see IdeaChatRepository.resolveIdeaIdForTask), an event
// message is posted to that idea's chat thread. Not just the title — the
// content the task ACTUALLY produced (extracted from the latest
// ExecutionJob.rawResult — see extractResultText) is also appended to the
// "task-result" card's expandable body, so the real text BEHIND a
// one-line title like "BRAND_STRATEGY: ... — positioning + campaign
// brief" is also visible in the chat. Creative tasks
// (CREATE_SOCIAL_CREATIVE/CREATE_AD_CREATIVE) are excluded: they already
// get their own rich card via resolveCreativeCard in
// execution-service.ts — writing here too would produce TWO cards in the
// chat for the same task. Publish tasks (INSTAGRAM_PUBLISH etc.) are
// resolved HERE, in the isPublish branch below — execution-service.ts's
// own resolvePublishResultCard call only covers the completion path that
// does NOT require verification; capabilities that require verification
// (see execution-policy.ts VERIFICATION_REQUIRED_CAPABILITIES), like
// INSTAGRAM_PUBLISH, complete via completeAfterVerification, and that path
// used to call ONLY this function — previously this branch also returned
// early and did nothing, so the "running" card was never updated to a
// result (both paths assumed the other one did the work). Now this
// function is self-sufficient; even though it rarely overlaps with
// execution-service.ts's call, resolvePublishResultCard is idempotent
// (updates the existing card), so it's harmless.
async function postTaskChatEvent(task: {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  departmentKey: DepartmentKey | null;
  capability: CapabilityKey;
  payload?: unknown;
  createdByType?: ActorType;
}) {
  if (ExecutionPolicy.isCreative(task.capability)) return;
  try {
    // No `if (!(await resolveIdeaIdForTask(...))) return` here: SYSTEM
    // tasks with no idea lineage (SIGNAL_SCAN, MEASUREMENT_CHECK — created
    // directly by signal-universe.ts/measurement-engine.ts, never through
    // an idea's chat) still got a "running" card posted by
    // postTaskRunningCard above (execution-service.ts:190, which has no
    // such guard) into the project's general chat feed (ideaId: null). An
    // early return here used to leave that card permanently stuck on
    // "Running" forever, no matter how the task actually resolved —
    // resolveTaskResultCard/resolvePublishResultCard below already resolve
    // ideaId themselves and handle null fine (the same general feed the
    // running card went to), so there was nothing this guard protected.
    const latestJob = await prisma.executionJob.findFirst({
      where: { taskId: task.id },
      orderBy: { createdAt: "desc" },
      select: { rawResult: true, errorMessage: true },
    });

    if (ExecutionPolicy.isPublish(task.capability)) {
      const platform = PLATFORM_LABEL[task.capability] ?? task.capability;
      const rawResult = (latestJob?.rawResult ?? {}) as Record<string, unknown>;
      const postId =
        typeof rawResult.postId === "string" ? rawResult.postId : undefined;
      const publishStatus =
        task.status === "COMPLETED" ? "COMPLETED" : "FAILED";

      // Same "mirror onto the creative-ready card instead of a separate
      // row" treatment as execution-service.ts's non-verification
      // completion path (see markCreativePublishState) — INSTAGRAM_PUBLISH
      // completes through THIS function, not that one (see the module
      // comment above).
      const publishCreativeId = (task.payload as Record<string, unknown> | null)
        ?.creativeId as string | undefined;
      const mirroredOntoCard = publishCreativeId
        ? await IdeaChatRepository.markCreativePublishState({
            taskId: task.id,
            creativeId: publishCreativeId,
            publishState:
              publishStatus === "COMPLETED" ? "published" : "failed",
            publishError:
              publishStatus === "FAILED"
                ? (latestJob?.errorMessage ?? undefined)
                : undefined,
            publishedAt: publishStatus === "COMPLETED" ? new Date() : undefined,
          }).catch(() => false)
        : false;
      if (mirroredOntoCard) return;

      await IdeaChatRepository.resolvePublishResultCard({
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId: task.id,
        text:
          publishStatus === "COMPLETED"
            ? `📤 Published on ${platform}: ${task.title}`
            : `❌ ${platform} publish failed: ${task.title}`,
        card: {
          kind: "publish-result",
          taskId: task.id,
          platform,
          title: task.title,
          status: publishStatus,
          postId,
          errorMessage:
            publishStatus === "FAILED"
              ? (latestJob?.errorMessage ?? undefined)
              : undefined,
        },
        departmentKey: task.departmentKey ?? undefined,
      });
      return;
    }

    const prefix =
      task.status === "COMPLETED"
        ? "✅ Task completed"
        : task.status === "CANCELLED"
          ? "🚫 Task cancelled"
          : "❌ Task failed";
    const resultText = latestJob
      ? (extractResultText(latestJob.rawResult) ?? undefined)
      : undefined;

    await IdeaChatRepository.resolveTaskResultCard({
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      text: `${prefix}: ${task.title}`,
      card: {
        kind: "task-result",
        taskId: task.id,
        title: task.title,
        department: task.departmentKey ?? undefined,
        status: task.status,
        resultText,
        expanded: shouldExpandTaskResult(task.capability, task.createdByType),
      },
      departmentKey: task.departmentKey ?? undefined,
    });
  } catch (error) {
    console.error("[task.repository] postTaskChatEvent failed:", error);
  }
}

export type CreateTaskInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  commandId?: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  payload?: unknown;
  capability: CapabilityKey;
  riskLevel?: RiskLevel;
  createdByType: ActorType;
  createdByUserId?: string;
  requiresApproval?: boolean;
  requiresVerification?: boolean;
  departmentKey?: DepartmentKey;
  workPlanId?: string;
  goalIds?: string[];
  fingerprint?: string;
  sourceDecisionId?: string;
};

export const TaskRepository = {
  // projectId is always an explicit, separately-verified filter — never rely
  // on the id alone to prove tenant ownership.
  findByIdInProject(taskId: string, projectId: string) {
    return prisma.task.findFirst({ where: { id: taskId, projectId } });
  },

  listForProject(projectId: string, filter?: { status?: TaskStatus }) {
    return prisma.task.findMany({
      where: {
        projectId,
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  },

  create(input: CreateTaskInput) {
    return prisma.task.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        commandId: input.commandId,
        parentTaskId: input.parentTaskId,
        title: input.title,
        description: input.description,
        payload: input.payload as never,
        capability: input.capability,
        riskLevel: input.riskLevel ?? "LOW",
        createdByType: input.createdByType,
        createdByUserId: input.createdByUserId,
        requiresApproval: input.requiresApproval ?? false,
        requiresVerification: input.requiresVerification ?? false,
        departmentKey: input.departmentKey,
        workPlanId: input.workPlanId,
        goalIds: input.goalIds ?? [],
        fingerprint: input.fingerprint,
        sourceDecisionId: input.sourceDecisionId,
        status: "READY",
      },
    });
  },

  // Recent same-fingerprint task lookup — the cooldown gate the director and
  // planners consult before creating near-duplicate work.
  findRecentByFingerprint(projectId: string, fingerprint: string, since: Date) {
    return prisma.task.findFirst({
      where: {
        projectId,
        fingerprint,
        createdAt: { gte: since },
        status: { notIn: ["CANCELLED", "FAILED"] },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  countActiveSystemTasks(projectId: string) {
    return prisma.task.count({
      where: {
        projectId,
        createdByType: "SYSTEM",
        status: {
          in: [
            "READY",
            "QUEUED",
            "RUNNING",
            "WAITING_INPUT",
            "WAITING_HUMAN",
            "WAITING_APPROVAL",
            "WAITING_PROVIDER",
            "VERIFYING",
          ],
        },
      },
    });
  },

  async transition(
    taskId: string,
    projectId: string,
    to: TaskStatus,
    options?: { failureReason?: string },
  ) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId },
    });
    if (!task)
      throw new AgentelseError(
        "NOT_FOUND",
        `Task ${taskId} not found in project ${projectId}`,
      );

    StateMachine.assertTaskTransition(task.status, to);

    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        status: to,
        startedAt:
          to === "RUNNING" && !task.startedAt ? new Date() : task.startedAt,
        completedAt:
          to === "COMPLETED" || to === "FAILED" || to === "CANCELLED"
            ? new Date()
            : task.completedAt,
      },
    });

    // Single fan-out choke point for the Agency OS loop: every completed task
    // (verification path AND direct-completion path both land here) enqueues
    // a TASK_COMPLETED trigger. Trigger failures never fail the transition.
    if (to === "COMPLETED" && task.status !== "COMPLETED") {
      try {
        await AgencyTriggerRepository.enqueue({
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          brandId: task.brandId,
          type: "TASK_COMPLETED",
          payload: { taskId: task.id, capability: task.capability },
          dedupeKey: `task-completed:${task.id}`,
        });
      } catch {
        // Best-effort — the continuous engine sweeps unmaterialized tasks.
      }
    }

    // Symmetric fan-out for FAILED/CANCELLED — previously only COMPLETED
    // ever reached the loop, so WorkPlanProgressor/MeasurementEngine had no
    // way to react to a failure: a dependent task's dependenciesSatisfied()
    // check requires ALL deps COMPLETED, so a FAILED dependency left it
    // READY forever, and a MEASUREMENT_CHECK's Task failing left the check
    // stuck RUNNING forever (see WorkPlanProgressor.onTaskTerminal /
    // MeasurementEngine.onCheckTaskTerminal, registered against these two
    // trigger types in agency-wiring.ts).
    if ((to === "FAILED" || to === "CANCELLED") && task.status !== to) {
      try {
        await AgencyTriggerRepository.enqueue({
          workspaceId: task.workspaceId,
          projectId: task.projectId,
          brandId: task.brandId,
          type: to === "FAILED" ? "TASK_FAILED" : "TASK_CANCELLED",
          payload: {
            taskId: task.id,
            capability: task.capability,
            terminalStatus: to,
            workPlanId: task.workPlanId ?? undefined,
            departmentKey: task.departmentKey ?? undefined,
            failureReason: options?.failureReason,
          },
          dedupeKey: `task-${to.toLowerCase()}:${task.id}`,
        });
      } catch {
        // Best-effort — the continuous engine sweeps unmaterialized tasks.
      }
    }

    if (to === "COMPLETED" || to === "FAILED") {
      const prefix =
        to === "COMPLETED" ? "✅ Task completed" : "❌ Task failed";
      try {
        await notifyProjectTelegram(
          task.projectId,
          `${prefix}: ${updated.title}`,
        );
      } catch {
        // Best-effort — a notification failure must never break the task transition.
      }
    }

    if (to === "COMPLETED" || to === "FAILED" || to === "CANCELLED") {
      await postTaskChatEvent({
        id: task.id,
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        title: updated.title,
        status: to,
        departmentKey: task.departmentKey,
        capability: task.capability,
        payload: task.payload,
        createdByType: task.createdByType,
      });
    }

    return updated;
  },

  // Idempotent completion path used by verification recovery. The status
  // predicate elects one worker to update and emit TASK_COMPLETED while
  // concurrent recovery ticks become no-ops.
  async completeAfterVerification(
    taskId: string,
    projectId: string,
  ): Promise<boolean> {
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId },
    });
    if (!task) {
      throw new AgentelseError(
        "NOT_FOUND",
        `Task ${taskId} not found in project ${projectId}`,
      );
    }
    if (task.status === "COMPLETED") return false;

    StateMachine.assertTaskTransition(task.status, "COMPLETED");
    const result = await prisma.task.updateMany({
      where: { id: taskId, projectId, status: task.status },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (result.count !== 1) return false;

    try {
      await AgencyTriggerRepository.enqueue({
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        brandId: task.brandId,
        type: "TASK_COMPLETED",
        payload: { taskId: task.id, capability: task.capability },
        dedupeKey: `task-completed:${task.id}`,
      });
    } catch {
      // Best-effort — the continuous engine sweeps unmaterialized tasks.
    }

    await postTaskChatEvent({
      id: task.id,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      title: task.title,
      status: "COMPLETED",
      departmentKey: task.departmentKey,
      capability: task.capability,
      payload: task.payload,
      createdByType: task.createdByType,
    });

    return true;
  },

  addDependency(taskId: string, dependsOnTaskId: string) {
    return prisma.taskDependency.create({ data: { taskId, dependsOnTaskId } });
  },

  async dependenciesSatisfied(taskId: string): Promise<boolean> {
    const deps = await prisma.taskDependency.findMany({
      where: { taskId },
      include: { dependsOnTask: { select: { status: true } } },
    });
    return deps.every((d) => d.dependsOnTask.status === "COMPLETED");
  },
};
