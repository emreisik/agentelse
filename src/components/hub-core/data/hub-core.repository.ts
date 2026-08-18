import { prisma } from "@/lib/prisma";
import type { PanelKey } from "../hub-core-params";

// Expanded version of the old `getProjectBadges()` from sidebar-nav.tsx —
// the badge counts on the orbit nodes plus the core's pulse text.
// Deliberately kept lightweight (Phase 0 only brings the map to life);
// each panel separately fetches its own full data in Phase 1.
const ACTIVE_TASK_STATUSES = [
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_HUMAN",
  "WAITING_APPROVAL",
  "WAITING_PROVIDER",
  "VERIFYING",
] as const;

export type HubSummary = {
  badges: Partial<Record<PanelKey, number>>;
  coreVitals: string;
  pendingApprovals: number;
  pendingHumanActions: number;
  systemErrors: number;
};

export async function getHubSummary(
  workspaceId: string,
  projectId: string,
): Promise<HubSummary> {
  const [
    setupState,
    proposedGoals,
    proposedHandoffs,
    awaitingPlans,
    activeTaskCount,
    pendingApprovalsProject,
    pendingApprovalsWorkspace,
    pendingHumanActions,
    systemErrors,
  ] = await Promise.all([
    prisma.projectSetupState.findUnique({
      where: { projectId },
      include: { stageRecords: { select: { status: true } } },
    }),
    prisma.projectGoal.count({ where: { projectId, status: "PROPOSED" } }),
    prisma.workHandoff.count({ where: { projectId, status: "PROPOSED" } }),
    prisma.workPlan.count({
      where: { projectId, status: "AWAITING_APPROVAL" },
    }),
    prisma.task.count({
      where: { projectId, status: { in: [...ACTIVE_TASK_STATUSES] } },
    }),
    prisma.approval.count({ where: { projectId, status: "PENDING" } }),
    prisma.approval.count({ where: { workspaceId, status: "PENDING" } }),
    prisma.humanInterventionRequest.count({
      where: { workspaceId, status: "PENDING" },
    }),
    prisma.deadLetterJob.count({
      where: {
        resolvedAt: null,
        OR: [{ executionJobId: null }, { executionJob: { workspaceId } }],
      },
    }),
  ]);

  const setupWaitingClient = setupState
    ? setupState.stageRecords.filter((r) => r.status === "WAITING_CLIENT")
        .length
    : 0;

  const badges: Partial<Record<PanelKey, number>> = {};
  if (setupWaitingClient > 0) badges.setup = setupWaitingClient;
  if (proposedGoals > 0) badges.goals = proposedGoals;
  const workBadge = proposedHandoffs + awaitingPlans;
  if (workBadge > 0) badges.work = workBadge;

  return {
    badges,
    coreVitals: `${activeTaskCount} active · ${pendingApprovalsProject} pending approval`,
    pendingApprovals: pendingApprovalsWorkspace,
    pendingHumanActions,
    systemErrors,
  };
}
