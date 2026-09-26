import Link from "next/link";
import {
  ArrowLeft,
  ClipboardList,
  Lightbulb,
  ListChecks,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import type { DepartmentKey } from "@prisma/client";

import { timeAgo } from "@/lib/dates";
import {
  COUNCIL_RECOMMENDATION,
  COUNCIL_TYPE,
  IDEA_STATUS,
  TASK_STATUS,
  WORK_PLAN_STATUS,
  stripCapabilityPrefix,
} from "@/lib/labels";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { WorkPlanRepository } from "@/server/repositories/work-plan.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { DepartmentBadge } from "@/components/shared/department-badge";
import type { EntityRef } from "./hub-core-params";

type FlowEvent = {
  id: string;
  at: Date;
  icon: LucideIcon;
  title: string;
  detail?: string | null;
  badge?: React.ReactNode;
};

// Shows the full story of an idea/work item from its creation up to today
// as a chronological chat-like feed — an isolated, read-only detail view
// reached on demand (sidebar-nav.tsx's Initiatives list and thread.tsx's
// idea-title pill both offer it via &thread=1) alongside the single
// day-grouped chat, which stays the default way of browsing. Read-only: no
// sending new messages, just a narrative of the history.
export async function ProjectFlowView({
  projectId,
  entity,
}: {
  projectId: string;
  entity: EntityRef;
}) {
  if (entity.kind === "idea") {
    return <IdeaFlow projectId={projectId} ideaId={entity.id} />;
  }
  if (entity.kind === "workPlan") {
    return <WorkPlanFlow projectId={projectId} workPlanId={entity.id} />;
  }
  if (entity.kind === "task") {
    return <TaskFlow projectId={projectId} taskId={entity.id} />;
  }
  return null;
}

// ---------------------------------------------------------------------------

async function IdeaFlow({
  projectId,
  ideaId,
}: {
  projectId: string;
  ideaId: string;
}) {
  const idea = await IdeaRepository.findByIdInProject(ideaId, projectId);
  if (!idea) {
    return (
      <FlowShell
        projectId={projectId}
        title="Chat not found"
        backHref={`/projects/${projectId}`}
      >
        <EmptyState
          icon={Lightbulb}
          title="This idea was not found"
          hint="The record may have been deleted."
        />
      </FlowShell>
    );
  }

  const workPlan = idea.workPlanId
    ? await WorkPlanRepository.findByIdInProject(idea.workPlanId, projectId)
    : null;

  const events: FlowEvent[] = [
    {
      id: "created",
      at: idea.createdAt,
      icon: Lightbulb,
      title: "Idea created",
      detail: idea.description,
    },
    ...idea.councilEvaluations
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((evaluation) => ({
        id: evaluation.id,
        at: evaluation.createdAt,
        icon: Sparkles,
        title: `${COUNCIL_TYPE[evaluation.councilType].label} evaluated`,
        detail: evaluation.rationale,
        badge: (
          <StatusBadge
            meta={COUNCIL_RECOMMENDATION[evaluation.recommendation]}
          />
        ),
      })),
  ];

  if (workPlan) {
    events.push({
      id: workPlan.id,
      at: workPlan.createdAt,
      icon: ClipboardList,
      title: "Converted to work plan",
      detail: workPlan.title,
    });
    events.push(...taskEvents(workPlan.tasks));
  }

  return (
    <FlowShell
      projectId={projectId}
      title={idea.title}
      statusBadge={<StatusBadge meta={IDEA_STATUS[idea.status]} />}
      backHref={`/projects/${projectId}#idea-${ideaId}`}
    >
      <FlowTimeline events={events} />
    </FlowShell>
  );
}

// ---------------------------------------------------------------------------

async function WorkPlanFlow({
  projectId,
  workPlanId,
}: {
  projectId: string;
  workPlanId: string;
}) {
  const workPlan = await WorkPlanRepository.findByIdInProject(
    workPlanId,
    projectId,
  );
  if (!workPlan) {
    return (
      <FlowShell projectId={projectId} title="Chat not found">
        <EmptyState
          icon={ClipboardList}
          title="This work plan was not found"
          hint="The record may have been deleted."
        />
      </FlowShell>
    );
  }

  const events: FlowEvent[] = [
    {
      id: workPlan.id,
      at: workPlan.createdAt,
      icon: ClipboardList,
      title: "Work plan created",
      detail: workPlan.title,
    },
    ...taskEvents(workPlan.tasks),
  ];

  return (
    <FlowShell
      projectId={projectId}
      title={workPlan.title}
      statusBadge={<StatusBadge meta={WORK_PLAN_STATUS[workPlan.status]} />}
    >
      <FlowTimeline events={events} />
    </FlowShell>
  );
}

// ---------------------------------------------------------------------------

async function TaskFlow({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const task = await TaskRepository.findByIdInProject(taskId, projectId);
  return (
    <FlowShell projectId={projectId} title="Task">
      {task ? (
        <FlowTimeline events={taskEvents([task])} />
      ) : (
        <EmptyState
          icon={ListChecks}
          title="This task was not found"
          hint="The record may have been deleted."
        />
      )}
    </FlowShell>
  );
}

// ---------------------------------------------------------------------------

function taskEvents(
  tasks: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    departmentKey: DepartmentKey | null;
  }[],
): FlowEvent[] {
  const events: FlowEvent[] = [];
  for (const task of tasks
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const taskTitle = stripCapabilityPrefix(task.title);
    events.push({
      id: `${task.id}-created`,
      at: task.createdAt,
      icon: ListChecks,
      title: `Task created: ${taskTitle}`,
      detail: task.description,
      badge: task.departmentKey ? (
        <DepartmentBadge department={task.departmentKey} size="xs" />
      ) : undefined,
    });
    if (task.completedAt) {
      events.push({
        id: `${task.id}-completed`,
        at: task.completedAt,
        icon: ListChecks,
        title: `Task completed: ${taskTitle}`,
        badge: (
          <StatusBadge
            meta={TASK_STATUS[task.status as keyof typeof TASK_STATUS]}
          />
        ),
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------

function FlowShell({
  projectId,
  title,
  statusBadge,
  children,
  // Defaults to the general chat root — IdeaFlow overrides this to the
  // idea's own #idea-<id> anchor (see sidebar-nav.tsx/thread.tsx's opt-in
  // &thread=1 links into this view) so "back" returns to where the user
  // actually was, not the top of the timeline.
  backHref,
  backLabel = "Back to chat",
}: {
  projectId: string;
  title: string;
  statusBadge?: React.ReactNode;
  children: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div className="h-[calc(100vh-4rem)] overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 pt-8 pb-16">
        <Link
          href={backHref ?? `/projects/${projectId}`}
          scroll={false}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {backLabel}
        </Link>
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          {statusBadge}
        </div>
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

function FlowTimeline({ events }: { events: FlowEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  }
  return (
    <div className="space-y-6">
      {events
        .slice()
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map((event) => {
          const Icon = event.icon;
          return (
            <div key={event.id} className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1 space-y-1 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {event.title}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(event.at)}
                  </span>
                </div>
                {event.detail ? (
                  <p className="text-sm text-muted-foreground">
                    {event.detail}
                  </p>
                ) : null}
                {event.badge}
              </div>
            </div>
          );
        })}
    </div>
  );
}
