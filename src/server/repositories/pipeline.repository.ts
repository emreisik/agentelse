import "server-only";

import type {
  CreativeLens,
  DepartmentKey,
  IdeaStatus,
  WorkPlanStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  derivePipelineStage,
  type PipelineStageKey,
} from "@/lib/pipeline/derive-stage";

export type PipelineCard = {
  id: string;
  kind: "idea" | "workPlan" | "task";
  title: string;
  stage: PipelineStageKey;
  createdAt: Date;
  updatedAt: Date;
  departmentKey: DepartmentKey | null;
  lens: CreativeLens | null;
  ideaId: string | null;
  ideaStatus: IdeaStatus | null;
  workPlanId: string | null;
  workPlanStatus: WorkPlanStatus | null;
  taskCount: number;
  creativeCount: number;
  openApprovalCount: number;
  // First real (non-mock, image/*) generated asset among this card's
  // creatives — lets the board show an actual thumbnail instead of just a
  // "N kreatif" count, so a produced visual is obvious at a glance.
  previewAssetId: string | null;
};

const CARD_CREATIVE_SELECT = {
  id: true,
  status: true,
  versions: {
    orderBy: { version: "desc" as const },
    take: 1,
    select: {
      asset: { select: { id: true, mimeType: true, storageKey: true } },
    },
  },
};

type CardCreative = {
  id: string;
  versions: {
    asset: { id: string; mimeType: string; storageKey: string } | null;
  }[];
};

function findPreviewAssetId(creatives: CardCreative[]): string | null {
  for (const creative of creatives) {
    const asset = creative.versions[0]?.asset;
    if (
      asset &&
      asset.mimeType.startsWith("image/") &&
      !asset.storageKey.startsWith("mock://")
    ) {
      return asset.id;
    }
  }
  return null;
}

// Assembles one "card" per initiative by walking the only Prisma-enforced
// chain available (WorkPlan -> Task -> {ExecutionJob, Creative, Approval})
// and stitching in the originating Idea via the plain (non-relation)
// workPlanId/ideaId fields the app already writes together at creation time
// (see work-plan-builder.ts). No schema change — same app-level join
// pattern already used elsewhere, just read back out.
export const PipelineRepository = {
  async listCards(projectId: string): Promise<PipelineCard[]> {
    const [ideas, workPlans, orphanTasks, openApprovals] = await Promise.all([
      prisma.idea.findMany({
        where: { projectId },
        select: {
          id: true,
          title: true,
          status: true,
          lens: true,
          workPlanId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.workPlan.findMany({
        where: { projectId },
        select: {
          id: true,
          title: true,
          status: true,
          ideaId: true,
          createdAt: true,
          updatedAt: true,
          tasks: {
            select: {
              id: true,
              status: true,
              departmentKey: true,
              executionJobs: { select: { status: true } },
              creatives: { select: CARD_CREATIVE_SELECT },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.task.findMany({
        where: { projectId, workPlanId: null },
        select: {
          id: true,
          title: true,
          capability: true,
          status: true,
          departmentKey: true,
          createdAt: true,
          updatedAt: true,
          executionJobs: { select: { status: true } },
          creatives: { select: CARD_CREATIVE_SELECT },
        },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.approval.findMany({
        where: {
          projectId,
          status: { in: ["PENDING", "REVISION_REQUESTED"] },
        },
        select: {
          status: true,
          taskId: true,
          entityType: true,
          entityId: true,
        },
      }),
    ]);

    const workPlanIds = new Set(workPlans.map((wp) => wp.id));
    const ideaByWorkPlanId = new Map<string, (typeof ideas)[number]>();
    for (const idea of ideas) {
      if (idea.workPlanId && workPlanIds.has(idea.workPlanId)) {
        ideaByWorkPlanId.set(idea.workPlanId, idea);
      }
    }
    for (const wp of workPlans) {
      if (wp.ideaId && !ideaByWorkPlanId.has(wp.id)) {
        const idea = ideas.find((i) => i.id === wp.ideaId);
        if (idea) ideaByWorkPlanId.set(wp.id, idea);
      }
    }
    const matchedIdeaIds = new Set(
      [...ideaByWorkPlanId.values()].map((idea) => idea.id),
    );

    const cards: PipelineCard[] = [];

    for (const wp of workPlans) {
      const idea = ideaByWorkPlanId.get(wp.id) ?? null;
      const taskIds = new Set(wp.tasks.map((t) => t.id));
      const creativeIds = new Set(
        wp.tasks.flatMap((t) => t.creatives.map((c) => c.id)),
      );
      const approvals = openApprovals.filter(
        (a) =>
          (a.taskId && taskIds.has(a.taskId)) ||
          (a.entityType === "WorkPlan" && a.entityId === wp.id) ||
          (a.entityType === "Creative" && creativeIds.has(a.entityId)),
      );
      const departmentKey =
        wp.tasks.length === 1 ? (wp.tasks[0]?.departmentKey ?? null) : null;

      cards.push({
        id: wp.id,
        kind: "workPlan",
        title: idea?.title ?? wp.title,
        stage: derivePipelineStage({
          ideaStatus: idea?.status ?? null,
          workPlanStatus: wp.status,
          taskStatuses: wp.tasks.map((t) => t.status),
          executionJobStatuses: wp.tasks.flatMap((t) =>
            t.executionJobs.map((j) => j.status),
          ),
          creativeStatuses: wp.tasks.flatMap((t) =>
            t.creatives.map((c) => c.status),
          ),
          approvalStatuses: approvals.map((a) => a.status),
        }),
        createdAt: idea
          ? idea.createdAt < wp.createdAt
            ? idea.createdAt
            : wp.createdAt
          : wp.createdAt,
        updatedAt: wp.updatedAt,
        departmentKey,
        lens: idea?.lens ?? null,
        ideaId: idea?.id ?? null,
        ideaStatus: idea?.status ?? null,
        workPlanId: wp.id,
        workPlanStatus: wp.status,
        taskCount: wp.tasks.length,
        creativeCount: creativeIds.size,
        openApprovalCount: approvals.length,
        previewAssetId: findPreviewAssetId(
          wp.tasks.flatMap((t) => t.creatives),
        ),
      });
    }

    for (const idea of ideas) {
      if (matchedIdeaIds.has(idea.id)) continue;
      cards.push({
        id: idea.id,
        kind: "idea",
        title: idea.title,
        stage: derivePipelineStage({
          ideaStatus: idea.status,
          workPlanStatus: null,
          taskStatuses: [],
          executionJobStatuses: [],
          creativeStatuses: [],
          approvalStatuses: [],
        }),
        createdAt: idea.createdAt,
        updatedAt: idea.updatedAt,
        departmentKey: null,
        lens: idea.lens,
        ideaId: idea.id,
        ideaStatus: idea.status,
        workPlanId: null,
        workPlanStatus: null,
        taskCount: 0,
        creativeCount: 0,
        openApprovalCount: 0,
        previewAssetId: null,
      });
    }

    for (const task of orphanTasks) {
      const creativeIds = new Set(task.creatives.map((c) => c.id));
      const approvals = openApprovals.filter(
        (a) =>
          a.taskId === task.id ||
          (a.entityType === "Creative" && creativeIds.has(a.entityId)),
      );
      cards.push({
        id: task.id,
        kind: "task",
        title: task.title,
        stage: derivePipelineStage({
          ideaStatus: null,
          workPlanStatus: null,
          taskStatuses: [task.status],
          executionJobStatuses: task.executionJobs.map((j) => j.status),
          creativeStatuses: task.creatives.map((c) => c.status),
          approvalStatuses: approvals.map((a) => a.status),
        }),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        departmentKey: task.departmentKey,
        lens: null,
        ideaId: null,
        ideaStatus: null,
        workPlanId: null,
        workPlanStatus: null,
        taskCount: 1,
        creativeCount: creativeIds.size,
        openApprovalCount: approvals.length,
        previewAssetId: findPreviewAssetId(task.creatives),
      });
    }

    return cards.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  },
};
