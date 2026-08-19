import "server-only";

import type { SetupStage, SetupStageStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export const SETUP_STAGE_ORDER: SetupStage[] = [
  "INTAKE",
  "DEEP_DISCOVERY",
  "BRAND_CONSTITUTION",
  "SIGNAL_PROFILE",
  "BASELINE_AUDITS",
  "GOAL_GENERATION",
  "AGENCY_CONFIGURATION",
  "AUTONOMY_CONFIGURATION",
  "INITIAL_OPPORTUNITIES",
  "INITIAL_IDEA_PORTFOLIO",
  "INITIAL_WORK_PLAN",
  "PROJECT_ACTIVATION",
];

export function nextStage(stage: SetupStage): SetupStage | null {
  const idx = SETUP_STAGE_ORDER.indexOf(stage);
  if (idx < 0 || idx === SETUP_STAGE_ORDER.length - 1) return null;
  return SETUP_STAGE_ORDER[idx + 1] ?? null;
}

export type CreateSetupStateInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  intake: {
    brandName: string;
    domain?: string;
    description?: string;
    assetIds?: string[];
    autoApprove?: boolean;
  };
};

export const SetupStateRepository = {
  // Creates the setup aggregate plus all 12 stage records in one transaction,
  // so a crash can never leave a project with a partial stage list.
  create(input: CreateSetupStateInput) {
    return prisma.projectSetupState.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        intake: input.intake,
        stageRecords: {
          create: SETUP_STAGE_ORDER.map((stage) => ({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            brandId: input.brandId,
            stage,
          })),
        },
      },
      include: { stageRecords: true },
    });
  },

  findByProject(projectId: string) {
    return prisma.projectSetupState.findUnique({
      where: { projectId },
      include: { stageRecords: true },
    });
  },

  // Projects whose setup is not finished — the worker advances these.
  listUnfinished(limit: number) {
    return prisma.projectSetupState.findMany({
      where: { activatedAt: null },
      take: limit,
      orderBy: { updatedAt: "asc" },
      include: { stageRecords: true },
    });
  },

  setCurrentStage(projectId: string, stage: SetupStage) {
    return prisma.projectSetupState.update({
      where: { projectId },
      data: { currentStage: stage },
    });
  },

  markActivated(projectId: string) {
    return prisma.projectSetupState.update({
      where: { projectId },
      data: { activatedAt: new Date() },
    });
  },

  async transitionStage(
    projectId: string,
    stage: SetupStage,
    to: SetupStageStatus,
    extra?: { output?: unknown; error?: string },
  ) {
    const record = await prisma.projectSetupStageRecord.findUnique({
      where: { projectId_stage: { projectId, stage } },
    });
    if (!record)
      throw new AgentelseError(
        "NOT_FOUND",
        `Setup stage ${stage} not found for project ${projectId}`,
      );

    StateMachine.assertSetupStageTransition(record.status, to);

    // Compare-and-swap on the status read above: if two advance() calls for
    // the same project ever overlap (e.g. two worker processes briefly
    // alive at once), a plain update-by-id would let both "win" — the
    // second write completing a stage whose runStage() is, from its own
    // point of view, still mid-flight (this produced a real incident: a
    // stage got marked COMPLETED and the state machine moved on to the next
    // stage before the first stage's own reasoning call had actually
    // returned, so a later stage read empty data a still-running earlier
    // stage hadn't written yet). Requiring the row to still be at the
    // status we read makes only one writer succeed; the loser gets a clear
    // error instead of silently corrupting state.
    const result = await prisma.projectSetupStageRecord.updateMany({
      where: { id: record.id, status: record.status },
      data: {
        status: to,
        startedAt:
          to === "RUNNING" && !record.startedAt ? new Date() : record.startedAt,
        completedAt:
          to === "COMPLETED" || to === "SKIPPED"
            ? new Date()
            : record.completedAt,
        output:
          extra?.output === undefined
            ? (record.output as never)
            : (extra.output as never),
        error: extra?.error ?? record.error,
        attemptCount:
          to === "RUNNING" ? record.attemptCount + 1 : record.attemptCount,
      },
    });

    if (result.count !== 1) {
      throw new AgentelseError(
        "INVALID_STATE_TRANSITION",
        `Setup stage ${stage} for project ${projectId} was already moved out of ${record.status} by a concurrent transition`,
      );
    }
  },
};
