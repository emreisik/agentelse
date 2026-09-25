import "server-only";

import type { AgencyLoopStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { stripCapabilityPrefix } from "@/lib/labels/core";
import { INTERNAL_CAPABILITIES } from "@/lib/labels/work";
import { AgencyLoopStateRepository } from "@/server/repositories/agency-loop-state.repository";

// Plain-language status word for the Brand Workspace header's active-work
// popover — deliberately separate from labels/core.ts's TASK_STATUS (which
// stays technical, e.g. "Waiting for Approval", for the Work board and other
// existing screens). This mirrors the product spec's suggested mapping
// (READY->Preparing, RUNNING->Creating, WAITING_APPROVAL->Needs your
// approval) without touching the shared label map every other screen reads.
const ACTIVE_JOB_STATUS_WORD: Record<string, string> = {
  DRAFT: "Preparing",
  READY: "Preparing",
  QUEUED: "Starting",
  RUNNING: "Creating",
  VERIFYING: "Final checks",
  WAITING_INPUT: "Needs info",
  WAITING_HUMAN: "Needs you",
  WAITING_APPROVAL: "Needs approval",
  WAITING_PROVIDER: "Creating",
};

export type ActiveJob = {
  id: string;
  title: string;
  statusWord: string;
};

export type AgencyStatusSnapshot = {
  status: AgencyLoopStatus | null;
  lastTickAt: string | null;
  lastProgressAt: string | null;
  nextWakeAt: string | null;
  blockedReason: string | null;
  consecutiveNoProgressCycles: number;
  tasksNow: number;
  tasksWaiting: number;
  // Named jobs behind tasksNow/tasksWaiting's counts — for the header's
  // active-work popover (spec: "October Campaign — Creating" style rows),
  // not just an aggregate count.
  activeJobs: ActiveJob[];
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

  const [tasksNow, tasksWaiting, activeJobRows, dailyStat] = await Promise.all([
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
    // Named rows behind the two counts above, capped for a popover (not a
    // full list view) — most-recently-updated first, so a long-idle waiting
    // task doesn't crowd out what's actually moving right now.
    prisma.task.findMany({
      where: {
        projectId,
        status: { in: [...NOW_STATUSES, ...WAITING_STATUSES] },
        capability: { notIn: [...INTERNAL_CAPABILITIES] },
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, title: true, status: true },
    }),
    prisma.agencyDailyStat.findUnique({
      where: { projectId_date: { projectId, date: todayUtc() } },
    }),
  ]);

  const activeJobs: ActiveJob[] = activeJobRows.map((task) => ({
    id: task.id,
    title: stripCapabilityPrefix(task.title),
    statusWord: ACTIVE_JOB_STATUS_WORD[task.status] ?? "In progress",
  }));

  return {
    status: loopState.status,
    lastTickAt: loopState.lastTickAt?.toISOString() ?? null,
    lastProgressAt: loopState.lastProgressAt?.toISOString() ?? null,
    nextWakeAt: loopState.nextWakeAt?.toISOString() ?? null,
    blockedReason: loopState.blockedReason,
    consecutiveNoProgressCycles: loopState.consecutiveNoProgressCycles,
    tasksNow,
    tasksWaiting,
    activeJobs,
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
