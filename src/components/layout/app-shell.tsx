import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { getOpenAiCredit } from "@/server/billing/openai-credit";
import { requireUser } from "@/server/security/tenant-context";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { SetupProgressWidget } from "@/components/layout/setup-progress-widget";
import { WorkspaceTopBar } from "@/components/layout/workspace-top-bar";
import type { PanelKey } from "@/components/hub-core/hub-core-params";
import { getAgencyStatusSnapshot } from "@/server/agency/agency-status-snapshot";
import { WorkspacePanelToggleProvider } from "@/components/workspace/workspace-panel-toggle";
import { SETUP_STAGE, SETUP_STAGE_ORDER_UI } from "@/lib/labels";

export type ProjectNavBadges = {
  setupPercent: number | null; // null = activated / no setup
  // The stage currently WAITING_CLIENT/RUNNING/FAILED, or the next PENDING
  // one if none of those — so there's always something to show while setup
  // is running, even in the brief lull between one stage completing and the
  // next tick picking up the following one. Null alongside setupPercent.
  setupStageLabel: string | null;
  setupWaitingClient: number;
  pendingApprovals: number;
  pendingHumanActions: number;
  proposedGoals: number;
  proposedHandoffs: number;
  awaitingPlans: number;
  systemErrors: number;
};

async function getSidebarData(userId: string, projectId?: string) {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: {
      workspace: { include: { projects: { orderBy: { name: "asc" } } } },
      user: { select: { name: true, email: true } },
    },
  });
  const workspace = membership?.workspace ?? null;
  const displayName = membership?.user.name ?? membership?.user.email ?? null;
  if (!workspace) {
    return {
      workspace: null,
      displayName,
      pendingApprovals: 0,
      pendingHumanActions: 0,
      projectBadges: null as ProjectNavBadges | null,
    };
  }

  const [
    pendingApprovals,
    pendingHumanActions,
    openDeadLetters,
    projectSpecific,
  ] = await Promise.all([
    prisma.approval.count({
      where: { workspaceId: workspace.id, status: "PENDING" },
    }),
    prisma.humanInterventionRequest.count({
      where: { workspaceId: workspace.id, status: "PENDING" },
    }),
    // System Health badge: an unresolved dead-letter record = an
    // unaddressed error. Must be shown even without a project context, so
    // it's read at the shell level.
    prisma.deadLetterJob.count({ where: { resolvedAt: null } }),
    projectId ? getProjectBadges(projectId) : Promise.resolve(null),
  ]);

  const projectBadges: ProjectNavBadges = {
    ...(projectSpecific ?? EMPTY_PROJECT_BADGES),
    systemErrors: openDeadLetters,
  };

  return {
    workspace,
    displayName,
    pendingApprovals,
    pendingHumanActions,
    projectBadges,
  };
}

const EMPTY_PROJECT_BADGES: ProjectNavBadges = {
  setupPercent: null,
  setupStageLabel: null,
  setupWaitingClient: 0,
  pendingApprovals: 0,
  pendingHumanActions: 0,
  proposedGoals: 0,
  proposedHandoffs: 0,
  awaitingPlans: 0,
  systemErrors: 0,
};

// Project-context sidebar badge data: setup progress, waiting decisions,
// pending approvals/human-actions/goals/handoffs/plans — one Promise.all.
async function getProjectBadges(
  projectId: string,
): Promise<Omit<ProjectNavBadges, "systemErrors">> {
  const [
    setupState,
    pendingApprovals,
    pendingHumanActions,
    proposedGoals,
    proposedHandoffs,
    awaitingPlans,
  ] = await Promise.all([
    prisma.projectSetupState.findUnique({
      where: { projectId },
      include: { stageRecords: { select: { stage: true, status: true } } },
    }),
    prisma.approval.count({ where: { projectId, status: "PENDING" } }),
    prisma.humanInterventionRequest.count({
      where: { projectId, status: "PENDING" },
    }),
    prisma.projectGoal.count({ where: { projectId, status: "PROPOSED" } }),
    prisma.workHandoff.count({ where: { projectId, status: "PROPOSED" } }),
    prisma.workPlan.count({
      where: { projectId, status: "AWAITING_APPROVAL" },
    }),
  ]);

  let setupPercent: number | null = null;
  let setupStageLabel: string | null = null;
  let setupWaitingClient = 0;
  if (setupState && !setupState.activatedAt) {
    const total = setupState.stageRecords.length || 12;
    const done = setupState.stageRecords.filter(
      (r) => r.status === "COMPLETED" || r.status === "SKIPPED",
    ).length;
    setupPercent = Math.round((done / total) * 100);
    setupWaitingClient = setupState.stageRecords.filter(
      (r) => r.status === "WAITING_CLIENT",
    ).length;

    const statusByStage = new Map(
      setupState.stageRecords.map((r) => [r.stage, r.status]),
    );
    const ordered = SETUP_STAGE_ORDER_UI.map((stage) => ({
      stage,
      status: statusByStage.get(stage) ?? "PENDING",
    }));
    const current =
      ordered.find((s) => s.status === "WAITING_CLIENT") ??
      ordered.find((s) => s.status === "RUNNING") ??
      ordered.find((s) => s.status === "FAILED") ??
      ordered.find((s) => s.status === "PENDING");
    setupStageLabel = current ? SETUP_STAGE[current.stage].label : null;
  }

  return {
    setupPercent,
    setupStageLabel,
    setupWaitingClient,
    pendingApprovals,
    pendingHumanActions,
    proposedGoals,
    proposedHandoffs,
    awaitingPlans,
  };
}

// projectBadges already carries the counts that overlap with the panels in
// the Tools menu (setup/goals/work/approvals/human-action) — instead of
// firing a separate query, we derive from the same data.
function toolBadgesFrom(
  projectBadges: ProjectNavBadges | null,
): Partial<Record<PanelKey, number>> {
  if (!projectBadges) return {};
  const badges: Partial<Record<PanelKey, number>> = {};
  if (projectBadges.setupWaitingClient > 0) {
    badges.setup = projectBadges.setupWaitingClient;
  }
  if (projectBadges.proposedGoals > 0) {
    badges.goals = projectBadges.proposedGoals;
  }
  const islerBadge =
    projectBadges.proposedHandoffs + projectBadges.awaitingPlans;
  if (islerBadge > 0) badges.work = islerBadge;
  if (projectBadges.pendingHumanActions > 0) {
    badges["human-action"] = projectBadges.pendingHumanActions;
  }
  return badges;
}

export async function AppShell({
  children,
  projectId,
  rightPanel,
}: {
  children: React.ReactNode;
  projectId?: string;
  // Brand Workspace shell (docs/brand-workspace-migration.md §7) — the
  // right panel's data (Brand/Files/Outputs/Calendar) lives outside what
  // this shell already fetches, so it's the caller's job. undefined at
  // every existing call site, so this renders byte-for-byte like before it
  // — only the project root's plain-chat view passes it.
  rightPanel?: React.ReactNode;
}) {
  const { userId, email } = await requireUser();
  const [
    {
      workspace,
      displayName,
      pendingApprovals,
      pendingHumanActions,
      projectBadges,
    },
    agencyStatus,
  ] = await Promise.all([
    getSidebarData(userId, projectId),
    projectId ? getAgencyStatusSnapshot(projectId) : Promise.resolve(null),
  ]);
  const sidebarVisible = Boolean(projectId);

  // Only the project chat root passes a right panel (pixel spec §15) — it
  // alone gets the panel-toggle context and the header's toggle button.
  const isWorkspaceRoot = Boolean(rightPanel);
  const projectName =
    workspace?.projects.find((p) => p.id === projectId)?.name ?? "";

  // One header for every page. Counts are project-scoped inside a project
  // and workspace-wide elsewhere (projectBadges' own approvals/human-action
  // counts are zero without a project, so they can't be used there).
  const openaiCredit = await getOpenAiCredit().catch(() => null);
  const header = (
    <WorkspaceTopBar
      projectId={projectId}
      projectName={projectName}
      projects={workspace?.projects ?? []}
      counts={{
        approvals: projectId
          ? (projectBadges?.pendingApprovals ?? 0)
          : pendingApprovals,
        humanActions: projectId
          ? (projectBadges?.pendingHumanActions ?? 0)
          : pendingHumanActions,
        errors: projectBadges?.systemErrors ?? 0,
      }}
      toolBadges={toolBadgesFrom(projectBadges)}
      setupPercent={projectBadges?.setupPercent ?? null}
      setupStageLabel={projectBadges?.setupStageLabel ?? null}
      agencyStatus={agencyStatus}
      displayName={displayName}
      workspaceName={workspace?.name ?? null}
      email={email}
      showLogo={!sidebarVisible}
      hasRightPanel={isWorkspaceRoot}
      openaiCredit={openaiCredit}
    />
  );

  const body = (
    <div className="flex min-w-0 flex-1 flex-col">
      {header}
      <div className="flex min-w-0 flex-1 overflow-hidden">
        {/* FAB stack anchors to this wrapper's corner (relative), not the
            viewport (fixed) — so it tracks <main>'s box when a rightPanel
            pushes it left, with no state shared between the two. */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <main className="h-full overflow-y-auto bg-background">
            {children}
          </main>
          {projectId && projectBadges?.setupPercent != null ? (
            <div className="absolute right-6 bottom-6 z-50 flex flex-col items-end gap-3">
              <SetupProgressWidget
                projectId={projectId}
                initialPercent={projectBadges.setupPercent}
              />
            </div>
          ) : null}
        </div>
        {rightPanel}
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {sidebarVisible ? (
        <aside className="flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
          {/* Same 72px as WorkspaceTopBar so the two bottom borders form one
              continuous line; 22px = SidebarNav's px-3 + item px-2.5, which
              puts the wordmark on the nav icons' column. */}
          <Link
            href="/dashboard"
            className="flex h-[72px] shrink-0 items-center border-b border-sidebar-border px-[22px] transition-opacity hover:opacity-80"
          >
            <img
              src="/logo.png"
              alt="Agentelse"
              className="h-7 object-contain"
            />
          </Link>

          <SidebarNav
            activeProjectId={projectId}
            toolBadges={toolBadgesFrom(projectBadges)}
          />
        </aside>
      ) : null}

      {isWorkspaceRoot ? (
        <WorkspacePanelToggleProvider>{body}</WorkspacePanelToggleProvider>
      ) : (
        body
      )}
    </div>
  );
}
