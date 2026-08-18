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
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";
import { notifyProjectTelegram } from "@/server/notifications/project-telegram-notifier";
import { extractResultText } from "@/lib/execution-result-text";
import { PLATFORM_LABEL } from "@/lib/labels";

// Bir görev tamamlanınca/başarısız/iptal olunca, o görev bir fikre bağlıysa
// (bir iş planı üzerinden ya da doğrudan o fikrin sohbetinden komutla
// istenmişse — bkz. IdeaChatRepository.resolveIdeaIdForTask) o fikrin
// sohbet iş parçacığına olay mesajı düşer. Sadece başlık değil, görevin
// GERÇEKTEN ürettiği içerik de (son ExecutionJob.rawResult'tan çıkarılır —
// bkz. extractResultText) "task-result" kartının açılır/kapanır gövdesine
// eklenir; böylece "BRAND_STRATEGY: ... — positioning + campaign brief"
// gibi tek satırlık başlığın ARKASINDAKİ gerçek metin de sohbette görünür.
// Kreatif görevler (CREATE_SOCIAL_CREATIVE/CREATE_AD_CREATIVE) hariç: onlar
// zaten kendi zengin kartını execution-service.ts'teki resolveCreativeCard
// üzerinden alıyor — burada da yazarsak aynı görev için sohbette İKİ kart
// belirir. Yayın görevleri (INSTAGRAM_PUBLISH vb.) BURADA, aşağıdaki
// isPublish dalında çözülüyor — execution-service.ts'in kendi
// resolvePublishResultCard çağrısı yalnızca doğrulama GEREKTİRMEYEN
// tamamlanma yolunu kapsıyor; INSTAGRAM_PUBLISH gibi doğrulama gerektiren
// (bkz. execution-policy.ts VERIFICATION_REQUIRED_CAPABILITIES) capability'ler
// completeAfterVerification üzerinden tamamlanıyor ve o yol SADECE burayı
// çağırıyordu — önceden bu dal da erken dönüp hiçbir şey yapmadığı için
// "çalışıyor" kartı hiç sonuca güncellenmiyordu (iki yol da işi diğerinin
// yaptığını varsayıyordu). Şimdi bu fonksiyon kendi başına yeterli;
// execution-service.ts'in çağrısıyla nadiren çakışsa da resolvePublishResultCard
// idempotent (var olan kartı günceller), zararsız.
async function postTaskChatEvent(task: {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  departmentKey: DepartmentKey | null;
  capability: CapabilityKey;
}) {
  if (ExecutionPolicy.isCreative(task.capability)) return;
  try {
    const ideaId = await IdeaChatRepository.resolveIdeaIdForTask(task.id);
    if (!ideaId) return;

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
      await IdeaChatRepository.resolvePublishResultCard({
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId: task.id,
        text:
          publishStatus === "COMPLETED"
            ? `📤 ${platform}'da yayınlandı: ${task.title}`
            : `❌ ${platform} yayını başarısız: ${task.title}`,
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
        ? "✅ Görev tamamlandı"
        : task.status === "CANCELLED"
          ? "🚫 Görev iptal edildi"
          : "❌ Görev başarısız";
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

  async transition(taskId: string, projectId: string, to: TaskStatus) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId },
    });
    if (!task)
      throw new HubConnectError(
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

    if (to === "COMPLETED" || to === "FAILED") {
      const prefix =
        to === "COMPLETED" ? "✅ Görev tamamlandı" : "❌ Görev başarısız";
      try {
        await notifyProjectTelegram(
          task.projectId,
          `${prefix}: ${updated.title}`,
        );
      } catch {
        // Best-effort — bildirim hatası görev geçişini asla bozmamalı.
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
      throw new HubConnectError(
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
