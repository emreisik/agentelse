import Link from "next/link";
import { startOfMonth, subDays } from "date-fns";
import { ChevronRight, Plus } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { PROJECT_STATUS } from "@/lib/labels";
import type { StatusTone } from "@/lib/labels";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardCommandBar } from "@/components/dashboard/dashboard-command-bar";
import { DashboardGreeting } from "@/components/dashboard/dashboard-greeting";

const TONE_DOT: Record<StatusTone, string> = {
  positive: "var(--ws-approved)",
  active: "var(--ws-accent)",
  waiting: "var(--ws-pending)",
  danger: "var(--destructive)",
  neutral: "var(--ws-text-3)",
  special: "var(--ws-text-3)",
};

function countByProject(rows: { projectId: string; _count: number }[]) {
  return new Map(rows.map((row) => [row.projectId, row._count]));
}

async function getDashboardData(workspaceId: string) {
  const monthStart = startOfMonth(new Date());
  const thirtyDaysAgo = subDays(new Date(), 30);

  const [
    projects,
    runningAgents,
    monthlyJobs,
    tasksCompletedThisMonth,
    approvalsByProject,
    humanActionsByProject,
    healthRows,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, status: true, domain: true },
    }),
    prisma.executionJob.count({ where: { workspaceId, status: "RUNNING" } }),
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
    prisma.approval.groupBy({
      by: ["projectId"],
      where: { workspaceId, status: "PENDING" },
      _count: true,
    }),
    prisma.humanInterventionRequest.groupBy({
      by: ["projectId"],
      where: { workspaceId, status: "PENDING" },
      _count: true,
    }),
    prisma.task.groupBy({
      by: ["projectId", "status"],
      where: {
        workspaceId,
        status: { in: ["COMPLETED", "FAILED"] },
        completedAt: { gte: thirtyDaysAgo },
      },
      _count: true,
    }),
  ]);

  const approvalCounts = countByProject(approvalsByProject);
  const humanActionCounts = countByProject(humanActionsByProject);

  // Success rate of finished tasks over the last 30 days; null when the
  // project hasn't finished anything yet (shown as "—", not 0%).
  const healthByProject = new Map<string, number>();
  for (const project of projects) {
    const rows = healthRows.filter((r) => r.projectId === project.id);
    const completed = rows.find((r) => r.status === "COMPLETED")?._count ?? 0;
    const total = rows.reduce((sum, r) => sum + r._count, 0);
    if (total > 0) {
      healthByProject.set(project.id, Math.round((completed / total) * 100));
    }
  }

  const totalApprovals = approvalsByProject.reduce((s, r) => s + r._count, 0);
  const totalHumanActions = humanActionsByProject.reduce(
    (s, r) => s + r._count,
    0,
  );

  return {
    projects: projects.map((project) => ({
      ...project,
      waiting:
        (approvalCounts.get(project.id) ?? 0) +
        (humanActionCounts.get(project.id) ?? 0),
      health: healthByProject.get(project.id) ?? null,
    })),
    stats: {
      activeProjects: projects.filter((p) => p.status === "ACTIVE").length,
      runningAgents,
      waitingOnYou: totalApprovals + totalHumanActions,
      tasksCompletedThisMonth,
      monthlyCost: monthlyJobs.reduce(
        (sum, job) => sum + (job.actualCost ?? job.estimatedCost ?? 0),
        0,
      ),
    },
  };
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export default async function DashboardPage() {
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const [data, currentUser] = await Promise.all([
    getDashboardData(workspaceId),
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    }),
  ]);

  const firstName =
    (currentUser?.name ?? currentUser?.email ?? "").split(/[\s@]/)[0] || null;
  const { stats } = data;

  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-8 px-4 py-10 md:py-14">
        <DashboardGreeting
          firstName={firstName}
          subtitle={
            stats.waitingOnYou > 0
              ? `${stats.waitingOnYou} ${stats.waitingOnYou === 1 ? "thing needs" : "things need"} your attention across your brands.`
              : "Everything is moving. Nothing is waiting on you."
          }
        />

        <div className="flex flex-col gap-3">
          <DashboardCommandBar
            projects={data.projects.map((project) => ({
              id: project.id,
              name: project.name,
              status: project.status,
            }))}
          />

          {/* Same "Where we left off" strip as the project chat, scoped to
              the whole workspace. */}
          <div
            className="rounded-[13px] border px-4 py-3.5 sm:px-[18px]"
            style={{
              borderColor: "var(--ws-border)",
              background: "var(--ws-surface-2)",
            }}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div>
                <div
                  className="text-xs font-medium"
                  style={{ color: "var(--ws-text)" }}
                >
                  Across your agency.
                </div>
                <div
                  className="text-[11px]"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  {currencyFormatter.format(stats.monthlyCost)} spent this month
                </div>
              </div>
              <div className="grid grid-cols-4 items-center gap-2 sm:ml-auto sm:flex sm:gap-0">
                <Stat
                  value={stats.activeProjects}
                  label="active brands"
                  divider={false}
                />
                <Stat value={stats.runningAgents} label="running now" />
                <Stat
                  value={stats.waitingOnYou}
                  label="waiting on you"
                  href="/approvals"
                  highlight={stats.waitingOnYou > 0}
                />
                <Stat
                  value={stats.tasksCompletedThisMonth}
                  label="done this month"
                />
              </div>
            </div>
          </div>
        </div>

        <section className="flex flex-col gap-2.5">
          <SectionHeader title="YOUR BRANDS">
            <Link
              href="/projects/new"
              className="flex items-center gap-1 text-[11px] font-medium transition-opacity hover:opacity-70"
              style={{ color: "var(--ws-text-2)" }}
            >
              <Plus className="size-3.5" />
              New brand
            </Link>
          </SectionHeader>
          <Surface>
            {data.projects.length === 0 ? (
              <EmptyRow text="No brands yet. Create one to get started." />
            ) : (
              data.projects.map((project) => {
                const status = PROJECT_STATUS[project.status];
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--ws-hover)]"
                  >
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold uppercase"
                      style={{
                        background: "var(--ws-soft-green)",
                        color: "var(--ws-accent)",
                      }}
                    >
                      {project.name.charAt(0)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-sm font-medium"
                        style={{ color: "var(--ws-text)" }}
                      >
                        {project.name}
                      </div>
                      <div
                        className="flex items-center gap-1.5 text-[11px]"
                        style={{ color: "var(--ws-text-3)" }}
                      >
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: TONE_DOT[status.tone] }}
                        />
                        {status.label}
                        {project.domain ? (
                          <span className="truncate">· {project.domain}</span>
                        ) : null}
                      </div>
                    </div>
                    {project.waiting > 0 ? (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{
                          background:
                            "color-mix(in oklch, var(--ws-pending) 15%, transparent)",
                          color: "var(--ws-pending)",
                        }}
                      >
                        {project.waiting} waiting
                      </span>
                    ) : null}
                    <div
                      className="hidden w-14 shrink-0 text-right sm:block"
                      title="Task success rate, last 30 days"
                    >
                      <div
                        className="text-sm font-semibold tabular-nums"
                        style={{ color: "var(--ws-text)" }}
                      >
                        {project.health === null ? "—" : `${project.health}%`}
                      </div>
                      <div
                        className="text-[10px]"
                        style={{ color: "var(--ws-text-3)" }}
                      >
                        health
                      </div>
                    </div>
                    <ChevronRight
                      className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                      style={{ color: "var(--ws-text-3)" }}
                    />
                  </Link>
                );
              })
            )}
          </Surface>
        </section>
      </div>
    </AppShell>
  );
}

function SectionHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-1">
      <span
        className="text-[10px] font-semibold tracking-[0.1em]"
        style={{ color: "var(--ws-text-3)" }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="divide-y divide-[var(--ws-border)] overflow-hidden rounded-2xl border"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      {children}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <p className="px-4 py-3.5 text-xs" style={{ color: "var(--ws-text-3)" }}>
      {text}
    </p>
  );
}

// Mirrors ResumeStat in project-chat.tsx — the workspace view links out
// instead of switching a right-panel tab.
function Stat({
  value,
  label,
  href,
  divider = true,
  highlight = false,
}: {
  value: number;
  label: string;
  href?: string;
  divider?: boolean;
  highlight?: boolean;
}) {
  const body = (
    <>
      <div
        className="text-lg font-semibold tabular-nums"
        style={{ color: highlight ? "var(--ws-pending)" : "var(--ws-text)" }}
      >
        {String(value).padStart(2, "0")}
      </div>
      <div
        className="text-[10px] whitespace-nowrap"
        style={{ color: "var(--ws-text-3)" }}
      >
        {label}
      </div>
    </>
  );

  return (
    <div className="flex items-center">
      {divider ? (
        <span
          className="mx-4 hidden h-8 w-px shrink-0 sm:block"
          style={{ background: "var(--ws-border)" }}
        />
      ) : null}
      {href ? (
        <Link
          href={href}
          className="rounded-lg text-center transition-opacity hover:opacity-70"
        >
          {body}
        </Link>
      ) : (
        <div className="text-center">{body}</div>
      )}
    </div>
  );
}
