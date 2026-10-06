import { cache } from "react";
import { cookies } from "next/headers";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/security/tenant-context";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { SetupProgressWidget } from "@/components/layout/setup-progress-widget";
import {
  MobileSidebar,
  SidebarBottom,
  SidebarTop,
} from "@/components/layout/workspace-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-collapse";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/components/layout/sidebar-item";
import { toolBadgesFrom } from "@/components/hub-core/tool-badges";
import { getAgencyStatusSnapshot } from "@/server/agency/agency-status-snapshot";
import { WorkspacePanelToggleProvider } from "@/components/workspace/workspace-panel-toggle";
import { SETUP_STAGE, SETUP_STAGE_ORDER_UI } from "@/lib/labels";
import type { ModuleKey } from "@/lib/modules/catalog";
import { loadSidebarWorks } from "@/server/works/sidebar-works";
import { WorkerStrip } from "@/components/layout/worker-strip";
import { Heartbeat } from "@/server/observability/heartbeat";
import {
  HEARTBEAT_KEYS,
  heartbeatLevel,
  lastSignOfLife,
} from "@/lib/heartbeat";
import { getProjectTimezone } from "@/server/chat/content-plan";

export type ProjectNavBadges = {
  setupPercent: number | null; // null = activated / no setup
  // The stage currently WAITING_CLIENT/RUNNING/FAILED, or the next PENDING
  // one if none of those — so there's always something to show while setup
  // is running, even in the brief lull between one stage completing and the
  // next tick picking up the following one. Null alongside setupPercent.
  setupStageLabel: string | null;
  setupWaitingClient: number;
  proposedGoals: number;
};

async function getSidebarData(userId: string) {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    select: {
      workspace: {
        select: {
          name: true,
          projects: {
            orderBy: { name: "asc" },
            select: { id: true, name: true, status: true },
          },
        },
      },
      user: { select: { name: true, email: true } },
      role: true,
    },
  });
  return {
    workspace: membership?.workspace ?? null,
    displayName: membership?.user.name ?? membership?.user.email ?? null,
    role: membership?.role ?? null,
  };
}

// İşçi nabzı yalnız OWNER/ADMIN'e gösterilir; okuma başarısızsa şerit çıkmaz.
async function getWorkerHeartbeat() {
  return Heartbeat.read(HEARTBEAT_KEYS.WORKER_TICK).catch(() => undefined);
}

// Everything the shell shows, read in one batch (the sidebar, the project's
// badges, its agency status and its Recents do not depend on each other).
// Request-scoped: the project chat page starts it before its own reads
// (preloadAppShell) so the two overlap. AppShell renders only once the page's
// data is in and would otherwise only then begin these round trips.
const loadShellData = cache(async (projectId: string | null) => {
  const { userId, email } = await requireUser();
  const [
    sidebar,
    projectBadges,
    agencyStatus,
    sidebarWorks,
    workerHeartbeat,
    timeZone,
  ] = await Promise.all([
    getSidebarData(userId),
    projectId ? getProjectBadges(projectId) : EMPTY_PROJECT_BADGES,
    projectId ? getAgencyStatusSnapshot(projectId) : null,
    // The sidebar's Recents (docs/works.md); undefined with Works off, or
    // when the read fails: the nav is then as before.
    projectId ? loadSidebarWorks(projectId) : undefined,
    getWorkerHeartbeat(),
    projectId
      ? getProjectTimezone(projectId).catch(() => "UTC")
      : Promise.resolve("UTC"),
  ]);
  return {
    email,
    ...sidebar,
    // No workspace: no badges either, as before.
    projectBadges: sidebar.workspace ? projectBadges : null,
    agencyStatus,
    sidebarWorks,
    workerHeartbeat,
    timeZone,
  };
});

// Starts the shell's reads ahead of AppShell (see loadShellData). A failure
// surfaces where AppShell awaits the same promise.
export function preloadAppShell(projectId?: string): void {
  loadShellData(projectId ?? null).catch(() => undefined);
}

const EMPTY_PROJECT_BADGES: ProjectNavBadges = {
  setupPercent: null,
  setupStageLabel: null,
  setupWaitingClient: 0,
  proposedGoals: 0,
};

// Project-context sidebar badge data: setup progress and goals waiting for
// the client — one Promise.all. (Pending decisions are cards in the chat, so
// they have no badge here.)
async function getProjectBadges(projectId: string): Promise<ProjectNavBadges> {
  const [setupState, proposedGoals] = await Promise.all([
    prisma.projectSetupState.findUnique({
      where: { projectId },
      include: { stageRecords: { select: { stage: true, status: true } } },
    }),
    prisma.projectGoal.count({ where: { projectId, status: "PROPOSED" } }),
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
    proposedGoals,
  };
}

export async function AppShell({
  children,
  projectId,
  rightPanel,
  openWorkUntouched,
  openWorkModule,
}: {
  children: React.ReactNode;
  projectId?: string;
  // Works: the chat on screen is still the new chat (untouched). The sidebar
  // then marks New Chat, not clickable, instead of guessing from Recents (an
  // archived or old chat is not in Recents either, and is no new chat).
  openWorkUntouched?: boolean;
  // Modules: that new chat's module (null: a general chat). The sidebar then
  // marks the module's line, and New Chat stays clickable to go back to a
  // general chat.
  openWorkModule?: ModuleKey | null;
  // Brand Workspace shell (docs/brand-workspace-migration.md §7) — the
  // right panel's data (Brand/Files/Outputs/Calendar) lives outside what
  // this shell already fetches, so it's the caller's job. undefined at
  // every existing call site, so this renders byte-for-byte like before it
  // — only the project root's plain-chat view passes it.
  rightPanel?: React.ReactNode;
}) {
  const {
    email,
    workspace,
    displayName,
    role,
    projectBadges,
    agencyStatus,
    sidebarWorks,
    workerHeartbeat,
    timeZone,
  } = await loadShellData(projectId ?? null);

  // İşçi şeridi (docs/meta-ads-plan.md F0b): yalnız OWNER/ADMIN, yalnız
  // nabız eskiyse. Okuma başarısızsa (undefined) şerit çıkmaz.
  const now = new Date();
  const workerLevel =
    workerHeartbeat === undefined
      ? "ok"
      : heartbeatLevel(workerHeartbeat, now);
  const workerStrip =
    (role === "OWNER" || role === "ADMIN") && workerLevel !== "ok" ? (
      <WorkerStrip
        level={workerLevel}
        since={workerHeartbeat ? lastSignOfLife(workerHeartbeat) : null}
        timeZone={timeZone}
        now={now}
      />
    ) : null;

  // Only the project chat root passes a right panel (pixel spec §15) — it
  // alone gets the panel-toggle context (the panel's own edge toggle, and the
  // phone bar's).
  const isWorkspaceRoot = Boolean(rightPanel);

  // No top bar: the sidebar (workspace-sidebar.tsx) is on every signed-in
  // page, so the content gets the full height.
  // Collapsed to the icon rail (sidebar-collapse.tsx) — read here so the
  // first paint already has the right width.
  const sidebarCollapsed =
    (await cookies()).get(SIDEBAR_COLLAPSED_COOKIE)?.value === "collapsed";
  const sidebar = (
    <>
      <SidebarTop
        projectId={projectId}
        projects={workspace?.projects ?? []}
        setupPercent={projectBadges?.setupPercent ?? null}
        setupStageLabel={projectBadges?.setupStageLabel ?? null}
        agencyStatus={agencyStatus}
      />
      <SidebarNav
        activeProjectId={projectId}
        toolBadges={toolBadgesFrom(projectBadges)}
        works={sidebarWorks}
        openWorkUntouched={openWorkUntouched}
        openWorkModule={openWorkModule}
      />
      <SidebarBottom
        displayName={displayName}
        workspaceName={workspace?.name ?? null}
        email={email}
      />
    </>
  );

  const shell = (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <SidebarShell defaultCollapsed={sidebarCollapsed}>{sidebar}</SidebarShell>
      <MobileSidebar hasRightPanel={isWorkspaceRoot}>{sidebar}</MobileSidebar>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* FAB stack anchors to this wrapper's corner (relative), not the
            viewport (fixed) — so it tracks <main>'s box when a rightPanel
            pushes it left, with no state shared between the two. */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {workerStrip}
          <main className="min-h-0 flex-1 overflow-y-auto bg-background">
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

  // The provider wraps the sidebar too: its toggle and the panel are
  // siblings that share the open/closed state.
  return isWorkspaceRoot ? (
    <WorkspacePanelToggleProvider>{shell}</WorkspacePanelToggleProvider>
  ) : (
    shell
  );
}
