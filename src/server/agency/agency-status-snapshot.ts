import "server-only";

import type { AgencyLoopStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { INTERNAL_CAPABILITIES } from "@/lib/labels/work";
import { AgencyLoopStateRepository } from "@/server/repositories/agency-loop-state.repository";

export type AgencyStatusSnapshot = {
  status: AgencyLoopStatus | null;
  lastTickAt: string | null;
  lastProgressAt: string | null;
  nextWakeAt: string | null;
  blockedReason: string | null;
  consecutiveNoProgressCycles: number;
  tasksNow: number;
  tasksWaiting: number;
  today: {
    tasksCreated: number;
    signalsIngested: number;
    opportunitiesCreated: number;
    ideasCreated: number;
    reasoningCalls: number;
    reasoningCostUsd: number;
  };
};

const NOW_STATUSES = ["READY", "QUEUED", "RUNNING", "VERIFYING"] as const;
const WAITING_STATUSES = [
  "WAITING_INPUT",
  "WAITING_HUMAN",
  "WAITING_APPROVAL",
  "WAITING_PROVIDER",
] as const;

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

// Backs both AppShell's server-rendered initial snapshot and the
// agency-status polling route (same shape, one query set) — see
// SetupProgressWidget/setup-status route for the established split of
// "SSR the first paint, poll a lightweight JSON endpoint after that."
// Internal/system capabilities (SIGNAL_SCAN, MEASUREMENT_CHECK,
// VERIFY_EXTERNAL_ACTION) are excluded from tasksNow/tasksWaiting — those
// counts are meant to read as "how much client-facing work is in flight,"
// not be dominated by the agency's own housekeeping tasks (the Work panel's
// default view applies the same exclusion, see task-department-board.tsx).
export async function getAgencyStatusSnapshot(
  projectId: string,
): Promise<AgencyStatusSnapshot | null> {
  const loopState = await AgencyLoopStateRepository.getForProject(projectId);
  if (!loopState) return null;

  const [tasksNow, tasksWaiting, dailyStat] = await Promise.all([
    prisma.task.count({
      where: {
        projectId,
        status: { in: [...NOW_STATUSES] },
        capability: { notIn: [...INTERNAL_CAPABILITIES] },
      },
    }),
    prisma.task.count({
      where: {
        projectId,
        status: { in: [...WAITING_STATUSES] },
        capability: { notIn: [...INTERNAL_CAPABILITIES] },
      },
    }),
    prisma.agencyDailyStat.findUnique({
      where: { projectId_date: { projectId, date: todayUtc() } },
    }),
  ]);

  return {
    status: loopState.status,
    lastTickAt: loopState.lastTickAt?.toISOString() ?? null,
    lastProgressAt: loopState.lastProgressAt?.toISOString() ?? null,
    nextWakeAt: loopState.nextWakeAt?.toISOString() ?? null,
    blockedReason: loopState.blockedReason,
    consecutiveNoProgressCycles: loopState.consecutiveNoProgressCycles,
    tasksNow,
    tasksWaiting,
    today: {
      tasksCreated: dailyStat?.tasksCreated ?? 0,
      signalsIngested: dailyStat?.signalsIngested ?? 0,
      opportunitiesCreated: dailyStat?.opportunitiesCreated ?? 0,
      ideasCreated: dailyStat?.ideasCreated ?? 0,
      reasoningCalls: dailyStat?.reasoningCalls ?? 0,
      reasoningCostUsd: dailyStat?.reasoningCostUsd ?? 0,
    },
  };
}
