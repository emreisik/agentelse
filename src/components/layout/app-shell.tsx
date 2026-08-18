import Link from "next/link";
import { LogOut } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/security/tenant-context";
import { signOutAction } from "@/server/actions/auth-actions";
import { PipelineRepository } from "@/server/repositories/pipeline.repository";
import { SidebarNav, type SidebarFlow } from "@/components/layout/sidebar-nav";
import { LogoBadge } from "@/components/shared/logo-badge";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { TopBar } from "@/components/layout/top-bar";
import { Button } from "@/components/ui/button";
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
    // Sistem Sağlığı rozeti: çözülmemiş ölü-kuyruk kaydı = ilgilenilmemiş
    // hata. Proje bağlamı olmadan da gösterilmeli, bu yüzden kabuk
    // seviyesinde okunuyor.
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

// projectBadges zaten Araçlar menüsündeki panellerle örtüşen sayaçları
// taşıyor (kurulum/hedefler/isler/onaylar/insan-eylem) — ayrı bir sorgu
// atmak yerine aynı veriden türetiyoruz (bkz. hub-core.repository.ts'teki
// getHubSummary'nin badges hesaplamasıyla birebir aynı mantık).
function toolBadgesFrom(
  projectBadges: ProjectNavBadges | null,
): Partial<Record<PanelKey, number>> {
  if (!projectBadges) return {};
  const badges: Partial<Record<PanelKey, number>> = {};
  if (projectBadges.setupWaitingClient > 0) {
    badges.kurulum = projectBadges.setupWaitingClient;
  }
  if (projectBadges.proposedGoals > 0) {
    badges.hedefler = projectBadges.proposedGoals;
  }
  const islerBadge =
    projectBadges.proposedHandoffs + projectBadges.awaitingPlans;
  if (islerBadge > 0) badges.isler = islerBadge;
  if (projectBadges.pendingApprovals > 0) {
    badges.onaylar = projectBadges.pendingApprovals;
  }
  if (projectBadges.pendingHumanActions > 0) {
    badges["insan-eylem"] = projectBadges.pendingHumanActions;
  }
  return badges;
}

// Sidebar'daki "Sohbetler" listesi — Akış kanban'ının eski veri kaynağı
// (PipelineRepository, dokunulmadı) burada tıklanabilir "sohbet" girişlerine
// dönüşüyor. Dağınıklığı önlemek için SADECE bir fikre kök olan kartlar
// listelenir (bir fikrin ürettiği iş planı/görevler zaten aynı "sohbet"in
// içinde, project-flow-view.tsx'te birleşik gösteriliyor) — fikirsiz
// tekil görevler/iş planları burada ayrı bir satır açmaz, kalabalık
// yaratmasın diye (Araçlar → İşler'den hâlâ erişilebilirler). Aynı fikre
// birden fazla kart denk gelirse (idea + ayrıca eşleşmiş workPlan kartı
// gibi) tek girişe indirgenir.
//
// Sıralama "en son işlem yapılan en üstte": Idea/WorkPlan satırının kendi
// updatedAt'i (durum değişikliği gibi) tek başına yeterli değil — "her şey
// tek sohbette" mimarisinde asıl aktivite Command satırları (kullanıcı
// mesajı, konsey/iş planı/görev-kreatif sistem mesajları) olarak birikiyor
// ve bunlar Idea satırını dokunmuyor. Bu yüzden her fikir için son Command
// zamanı da çekilip ikisinin en yenisi kullanılıyor.
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
}: {
  children: React.ReactNode;
  projectId?: string;
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

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar">
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-4 transition-opacity hover:opacity-80"
        >
          <LogoBadge size="sm" />
          <div className="min-w-0 font-heading text-sm font-semibold tracking-tight text-sidebar-foreground">
            Agentelse
          </div>
        </Link>

        <SidebarNav activeProjectId={projectId} flows={flows} />

        <div className="flex items-center gap-2.5 border-t border-sidebar-border px-3 py-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {(displayName ?? email ?? "?").charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-sidebar-foreground">
              {displayName ?? "Bilinmeyen kullanıcı"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {workspace?.name ?? "—"}
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <ThemeToggle />
            <form action={signOutAction}>
              <Button
                type="submit"
                variant="ghost"
                size="icon-sm"
                title="Çıkış yap"
              >
                <LogOut />
              </Button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          projects={workspace?.projects ?? []}
          pendingApprovals={pendingApprovals}
          pendingHumanActions={pendingHumanActions}
          systemErrors={projectBadges?.systemErrors ?? 0}
          toolBadges={toolBadgesFrom(projectBadges)}
        />
        <main className="min-w-0 flex-1 overflow-y-auto bg-background">
          {children}
        </main>
      </div>
    </div>
  );
}
