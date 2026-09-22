import "server-only";

import type { AgencyCycleStatus, AgencyTriggerType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type AgencyCycleScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type AgencyCycleCounts = Partial<{
  signalsProcessed: number;
  insightsCreated: number;
  opportunitiesCreated: number;
  ideasCreated: number;
  decisionsCreated: number;
  tasksCreated: number;
  handoffsCreated: number;
  measurementsCreated: number;
  learningsCreated: number;
  errorCount: number;
}>;

// Append-only per-cycle telemetry — see AgencyCycle's schema comment. Every
// call here is best-effort from the caller's perspective (see
// continuous-agency-engine.ts) — recording telemetry must never be able to
// break real trigger/task processing.
export const AgencyCycleRepository = {
  start(
    scope: AgencyCycleScope,
    trigger?: { type: AgencyTriggerType; id: string },
  ) {
    return prisma.agencyCycle.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        triggerType: trigger?.type,
        triggerId: trigger?.id,
      },
    });
  },

  complete(
    cycleId: string,
    status: Exclude<AgencyCycleStatus, "RUNNING">,
    counts?: AgencyCycleCounts,
  ) {
    return prisma.agencyCycle.update({
      where: { id: cycleId },
      data: { status, completedAt: new Date(), ...counts },
    });
  },

  listRecentForProject(projectId: string, limit = 20) {
    return prisma.agencyCycle.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
  },
};
