import Link from "next/link";
import { startOfMonth, subDays, format } from "date-fns";
import {
  Activity,
  CheckCircle2,
  ClipboardCheck,
  FolderKanban,
  Plus,
  UserRoundCog,
  Wallet,
} from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatCard } from "@/components/dashboard/stat-card";
import { DashboardCommandBar } from "@/components/dashboard/dashboard-command-bar";
import { ProjectOverviewCard } from "@/components/dashboard/project-overview-card";
import { TasksTable } from "@/components/dashboard/tasks-table";
import { ApprovalsPanel } from "@/components/dashboard/approvals-panel";
import { OpsPanel } from "@/components/dashboard/ops-panel";
import { OpportunitiesPanel } from "@/components/dashboard/opportunities-panel";
import { ActivityFeed } from "@/components/dashboard/activity-feed";

function computeHealth(rows: { status: string; completedAt: Date | null }[]) {
  const completed = rows.filter((r) => r.status === "COMPLETED").length;
  const failed = rows.filter((r) => r.status === "FAILED").length;
  const total = completed + failed;
  const healthPercent =
    total === 0 ? null : Math.round((completed / total) * 100);

  const sevenDaysAgo = subDays(new Date(), 7);
  const recent = rows.filter(
    (r) => r.completedAt && r.completedAt >= sevenDaysAgo,
  );
  const byDay = new Map<string, { completed: number; failed: number }>();
  for (const row of recent) {
    const day = format(row.completedAt!, "MM-dd");
    const bucket = byDay.get(day) ?? { completed: 0, failed: 0 };
    if (row.status === "COMPLETED") bucket.completed += 1;
    else bucket.failed += 1;
    byDay.set(day, bucket);
  }
  const sparkline = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, bucket]) => ({
      day,
      rate: Math.round(
        (bucket.completed / (bucket.completed + bucket.failed)) * 100,
      ),
    }));

  return { healthPercent, sparkline };
}

async function getDashboardData(workspaceId: string) {
  const monthStart = startOfMonth(new Date());
  const thirtyDaysAgo = subDays(new Date(), 30);

  const projects = await prisma.project.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
  });
  const projectIds = projects.map((p) => p.id);
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  const [
    runningAgents,
    waitingApprovals,
    humanActionsRequired,
    monthlyJobs,
    tasksCompletedThisMonth,
    recentTasks,
    pendingApprovals,
    browserProfiles,
    pendingHumanActions,
    opportunities,
    auditLogs,
    healthRows,
  ] = await Promise.all([
    prisma.executionJob.count({ where: { workspaceId, status: "RUNNING" } }),
    prisma.approval.count({ where: { workspaceId, status: "PENDING" } }),
    prisma.humanInterventionRequest.count({
      where: { workspaceId, status: "PENDING" },
    }),
    prisma.executionJob.findMany({
      where: { workspaceId, createdAt: { gte: monthStart } },
      select: { actualCost: true, estimatedCost: true },
    }),
    prisma.task.count({
      where: {
        workspaceId,
        status: "COMPLETED",
        completedAt: { gte: monthStart },
      },
    }),
    prisma.task.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
    prisma.approval.findMany({
      where: { workspaceId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 4,
    }),
    prisma.browserProfile.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.humanInterventionRequest.findMany({
      where: { workspaceId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
    prisma.opportunity.findMany({
      where: { workspaceId, status: { in: ["NEW", "REVIEWING"] } },
      orderBy: { createdAt: "desc" },
      take: 4,
    }),
    prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.task.findMany({
      where: {
        workspaceId,
        status: { in: ["COMPLETED", "FAILED"] },
        completedAt: { gte: thirtyDaysAgo },
      },
      select: { projectId: true, status: true, completedAt: true },
    }),
  ]);

  const monthlyCost = monthlyJobs.reduce(
    (sum, job) => sum + (job.actualCost ?? job.estimatedCost ?? 0),
    0,
  );

  const browserProfilesByProject = new Map<string, typeof browserProfiles>();
  for (const profile of browserProfiles) {
    const list = browserProfilesByProject.get(profile.projectId) ?? [];
    list.push(profile);
    browserProfilesByProject.set(profile.projectId, list);
  }

  const healthRowsByProject = new Map<string, typeof healthRows>();
  for (const row of healthRows) {
    const list = healthRowsByProject.get(row.projectId) ?? [];
    list.push(row);
    healthRowsByProject.set(row.projectId, list);
  }

  const actorIds = Array.from(
    new Set(
      auditLogs
        .filter((log) => log.actorType === "USER" && log.actorId)
        .map((log) => log.actorId as string),
    ),
  );
  const users = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  return {
    projects,
    projectNameById,
    projectIds,
    stats: {
      activeProjects: projects.filter((p) => p.status === "ACTIVE").length,
      runningAgents,
      waitingApprovals,
      humanActionsRequired,
      monthlyCost,
      tasksCompletedThisMonth,
    },
    recentTasks,
    pendingApprovals,
    browserProfilesByProject,
    browserProfilesPreview: browserProfiles.slice(0, 5),
    pendingHumanActions,
    opportunities,
    activities: auditLogs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      projectName: log.projectId
        ? (projectNameById.get(log.projectId) ?? null)
        : null,
      createdAt: log.createdAt,
      actorLabel:
        log.actorType === "USER" && log.actorId
          ? (userById.get(log.actorId)?.name ??
            userById.get(log.actorId)?.email ??
            "a user")
          : log.actorType === "SYSTEM"
            ? "system"
            : "agent",
    })),
    healthRowsByProject,
  };
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export default async function DashboardPage() {
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const data = await getDashboardData(workspaceId);

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-6 py-10 md:py-14">
        <div className="mb-10 flex flex-col items-center gap-5 text-center">
          <div>
            <h1 className="font-heading text-3xl font-semibold tracking-tight md:text-4xl">
              What would you like to do today?
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Agency-wide operations overview
            </p>
          </div>
          <div className="w-full max-w-xl">
            <DashboardCommandBar
              projects={data.projects.map((project) => ({
                id: project.id,
                name: project.name,
                status: project.status,
              }))}
            />
          </div>
        </div>

        <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard
            label="Active projects"
            value={data.stats.activeProjects}
            href="#"
            icon={FolderKanban}
          />
          <StatCard
            label="Running agents"
            value={data.stats.runningAgents}
            href="#"
            icon={Activity}
          />
          <StatCard
            label="Pending approvals"
            value={data.stats.waitingApprovals}
            href="/approvals"
            icon={ClipboardCheck}
          />
          <StatCard
            label="Human actions"
            value={data.stats.humanActionsRequired}
            href="/human-actions"
            icon={UserRoundCog}
          />
          <StatCard
            label="Monthly cost"
            value={currencyFormatter.format(data.stats.monthlyCost)}
            href="#"
            icon={Wallet}
          />
          <StatCard
            label="Completed tasks"
            value={data.stats.tasksCompletedThisMonth}
            href="#"
            icon={CheckCircle2}
          />
        </div>

        <Tabs defaultValue="projeler" className="mt-14">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="projeler">Projects</TabsTrigger>
              <TabsTrigger value="gorevler">Tasks</TabsTrigger>
              <TabsTrigger value="onaylar">Approvals &amp; Actions</TabsTrigger>
              <TabsTrigger value="aktivite">Activity</TabsTrigger>
            </TabsList>
            <Button
              render={<Link href="/projects/new" />}
              nativeButton={false}
              variant="ghost"
              size="sm"
            >
              <Plus className="size-4" />
              New Project
            </Button>
          </div>

          <TabsContent value="projeler" className="mt-4">
            {data.projects.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.projects.map((project) => {
                  const purposes = Array.from(
                    new Set(
                      (data.browserProfilesByProject.get(project.id) ?? []).map(
                        (p) => p.purpose,
                      ),
                    ),
                  );
                  const { healthPercent, sparkline } = computeHealth(
                    data.healthRowsByProject.get(project.id) ?? [],
                  );
                  return (
                    <ProjectOverviewCard
                      key={project.id}
                      project={project}
                      purposes={purposes}
                      healthPercent={healthPercent}
                      sparkline={sparkline}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No projects yet.
              </p>
            )}
          </TabsContent>

          <TabsContent value="gorevler" className="mt-4">
            <TasksTable
              tasks={data.recentTasks.map((task) => ({
                id: task.id,
                title: task.title,
                projectId: task.projectId,
                projectName: data.projectNameById.get(task.projectId) ?? "—",
                capability: task.capability,
                status: task.status,
                updatedAt: task.updatedAt,
              }))}
            />
          </TabsContent>

          <TabsContent value="onaylar" className="mt-4">
            <div className="grid gap-4 lg:grid-cols-3">
              <ApprovalsPanel
                approvals={data.pendingApprovals}
                projectNameById={data.projectNameById}
              />
              <OpsPanel
                browserProfiles={data.browserProfilesPreview}
                humanActions={data.pendingHumanActions}
                projectNameById={data.projectNameById}
              />
              <OpportunitiesPanel
                opportunities={data.opportunities}
                projectNameById={data.projectNameById}
              />
            </div>
          </TabsContent>

          <TabsContent value="aktivite" className="mt-4">
            <ActivityFeed activities={data.activities} />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
