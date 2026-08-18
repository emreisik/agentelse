import { prisma } from "@/lib/prisma";
import type { PanelKey } from "../hub-core-params";

// Sidebar-nav.tsx'teki eski `getProjectBadges()`'in genişletilmiş hali —
// yörünge düğümlerindeki rozet sayıları + çekirdeğin nabız metni. Bilinçli
// olarak hafif tutuluyor (Faz 0 sadece haritayı canlandırır); her panel
// Faz 1'de kendi tam verisini ayrıca çeker.
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
    prisma.deadLetterJob.count({ where: { resolvedAt: null } }),
  ]);

  const setupWaitingClient = setupState
    ? setupState.stageRecords.filter((r) => r.status === "WAITING_CLIENT")
        .length
    : 0;

  const badges: Partial<Record<PanelKey, number>> = {};
  if (setupWaitingClient > 0) badges.kurulum = setupWaitingClient;
  if (proposedGoals > 0) badges.hedefler = proposedGoals;
  const islerBadge = proposedHandoffs + awaitingPlans;
  if (islerBadge > 0) badges.isler = islerBadge;

  return {
    badges,
    coreVitals: `${activeTaskCount} aktif · ${pendingApprovalsProject} onay bekliyor`,
    pendingApprovals: pendingApprovalsWorkspace,
    pendingHumanActions,
    systemErrors,
  };
}
