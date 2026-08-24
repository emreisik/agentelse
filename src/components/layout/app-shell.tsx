import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/security/tenant-context";
import { PipelineRepository } from "@/server/repositories/pipeline.repository";
import { SidebarNav, type SidebarFlow } from "@/components/layout/sidebar-nav";
import { SetupProgressWidget } from "@/components/layout/setup-progress-widget";
import { TopBar } from "@/components/layout/top-bar";
import type { PanelKey } from "@/components/hub-core/hub-core-params";

export type ProjectNavBadges = {
  setupPercent: number | null; // null = activated / no setup
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
      include: { stageRecords: { select: { status: true } } },
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
  }

  return {
    setupPercent,
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
// firing a separate query, we derive from the same data (see the badges
// calculation in getHubSummary in hub-core.repository.ts for the identical
// logic).
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
  if (projectBadges.pendingApprovals > 0) {
    badges.approvals = projectBadges.pendingApprovals;
  }
  if (projectBadges.pendingHumanActions > 0) {
    badges["human-action"] = projectBadges.pendingHumanActions;
  }
  return badges;
}

// The "Chats" list in the sidebar — the flow kanban's old data source
// (PipelineRepository, untouched) turns into clickable "chat" entries
// here. To avoid clutter, ONLY cards that are rooted in an idea are
// listed (the work plan/tasks a given idea produces are already shown
// merged inside the same "chat" in project-flow-view.tsx) — standalone
// tasks/work plans with no idea don't get their own row here, to avoid
// crowding (they're still reachable from Tools → Work). If the same idea
// matches multiple cards (e.g. an idea plus its matched workPlan card),
// they collapse into a single entry.
//
// Sort order is "most recently active on top": the Idea/WorkPlan row's own
// updatedAt (e.g. a status change) alone isn't enough — in the "everything
// in one chat" architecture, the real activity accumulates as Command rows
// (user messages, council/work-plan/task-creative system messages), and
// those don't touch the Idea row. So we also fetch the latest Command time
// for each idea and use whichever of the two is more recent.
async function getSidebarFlows(projectId: string): Promise<SidebarFlow[]> {
  const cards = await PipelineRepository.listCards(projectId);
  const byIdea = new Map<string, { title: string; updatedAt: Date }>();
  for (const card of cards) {
    if (!card.ideaId) continue;
    const existing = byIdea.get(card.ideaId);
    if (!existing || card.updatedAt > existing.updatedAt) {
      byIdea.set(card.ideaId, { title: card.title, updatedAt: card.updatedAt });
    }
  }

  const ideaIds = Array.from(byIdea.keys());
  const lastActivityByIdea = ideaIds.length
    ? await prisma.command.groupBy({
      by: ["ideaId"],
      where: { ideaId: { in: ideaIds } },
      _max: { createdAt: true },
    })
    : [];
  const lastActivityMap = new Map(
    lastActivityByIdea
      .filter((row): row is typeof row & { ideaId: string } =>
        Boolean(row.ideaId),
      )
      .map((row) => [row.ideaId, row._max.createdAt]),
  );

  return Array.from(byIdea.entries())
    .map(([ideaId, { title, updatedAt }]) => {
      const lastCommandAt = lastActivityMap.get(ideaId);
      const lastActivityAt =
        lastCommandAt && lastCommandAt > updatedAt ? lastCommandAt : updatedAt;
      return { ideaId, title, lastActivityAt };
    })
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
    .map(({ ideaId, title }) => ({
      id: ideaId,
      kind: "idea" as const,
      title,
    }));
}

export async function AppShell({
  children,
  projectId,
  showSidebar,
}: {
  children: React.ReactNode;
  projectId?: string;
  // Project route segments render this shell from a loading.tsx boundary,
  // which (per Next.js) never receives params — so it can't pass projectId
  // yet. Those pass showSidebar explicitly instead of relying on the
  // projectId-presence default below.
  showSidebar?: boolean;
}) {
  const { userId, email } = await requireUser();
  const {
    workspace,
    displayName,
    pendingApprovals,
    pendingHumanActions,
    projectBadges,
  } = await getSidebarData(userId, projectId);
  const flows = projectId ? await getSidebarFlows(projectId) : null;
  const sidebarVisible = showSidebar ?? Boolean(projectId);

  return (
    <div className="flex h-screen overflow-hidden">
      {sidebarVisible ? (
        <aside className="flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
          <Link
            href="/dashboard"
            className="flex items-center border-b border-sidebar-border px-4 py-4 transition-opacity hover:opacity-80"
          >
            <img
              src="/logo.png"
              alt="Agentelse"
              className="h-7 object-contain"
            />
          </Link>

          <SidebarNav activeProjectId={projectId} flows={flows} />
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          showLogo={!sidebarVisible}
          projects={workspace?.projects ?? []}
          pendingApprovals={pendingApprovals}
          pendingHumanActions={pendingHumanActions}
          systemErrors={projectBadges?.systemErrors ?? 0}
          toolBadges={toolBadgesFrom(projectBadges)}
          displayName={displayName}
          workspaceName={workspace?.name ?? null}
          email={email}
        />
        <main className="min-w-0 flex-1 overflow-y-auto bg-background">
          {children}
        </main>
        {projectId && projectBadges?.setupPercent != null ? (
          <SetupProgressWidget
            projectId={projectId}
            initialPercent={projectBadges.setupPercent}
          />
        ) : null}
      </div>
    </div>
  );
}
