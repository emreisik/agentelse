import Link from "next/link";
import { ClipboardList } from "lucide-react";
import type { DepartmentKey, TaskStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import { extractResultText } from "@/lib/execution-result-text";
import {
  APPROVAL_LEVEL,
  APPROVAL_STATUS,
  APPROVAL_TYPE,
  CREATIVE_STATUS,
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  EXECUTION_JOB_STATUS,
  INTERNAL_CAPABILITIES,
  RISK_LEVEL,
  TASK_PRIORITY,
  TASK_STATUS,
  capabilityLabel,
  stripCapabilityPrefix,
} from "@/lib/labels";
import {
  cancelTaskAction,
} from "@/server/actions/agency-work-actions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent } from "@/components/ui/card";
import { buildHubHref } from "../hub-core-params";
import { AssetPreview } from "../primitives/asset-preview";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { EntityDetailSheet } from "../primitives/entity-detail-sheet";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import {
  TaskDepartmentBoard,
  type TaskBoardItem,
} from "./task-department-board";
import type { PanelProps } from "./panel-props";

// Every status TASK_TRANSITIONS (transitions.ts) legally allows moving to
// CANCELLED from — DRAFT/COMPLETED/FAILED(handled via its own QUEUED retry,
// not a user cancel)/CANCELLED itself are excluded.
const CANCELLABLE_TASK_STATUSES = new Set<TaskStatus>([
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_HUMAN",
  "WAITING_APPROVAL",
  "WAITING_PROVIDER",
  "BLOCKED",
]);

// The task log: every task the agency ran for the project (from the chat or
// the background loop), with its detail sheet. The old pipeline's work plans,
// handoff cycles and measurements are gone: nothing in the chat-first flow
// creates them any more.
export async function WorkPanel({ projectId, entity }: PanelProps) {
  const task = entity?.kind === "task" ? entity : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 pt-6">
      <div className="min-h-0 flex-1 pb-6">
        <TasksBoard projectId={projectId} />
      </div>

      {task ? (
        <EntityDetailSheet
          title="Task detail"
          closeHref={buildHubHref(projectId, {
            panel: "work",
            sub: "tasks",
            entity: null,
          })}
        >
          <TaskDetail projectId={projectId} taskId={task.id} />
        </EntityDetailSheet>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TASKS
// ---------------------------------------------------------------------------

// The exact same system as the Ideas board (ideas-panel.tsx IdeaListView):
// fetch the full list, compute the department distribution with groupBy,
// feed the kanban (TaskDepartmentBoard). Since departmentKey is directly a
// column on Task (unlike Idea's concept.departmentsInvolved JSON), no extra
// "primaryDepartment" derivation is needed.
async function TasksBoard({ projectId }: { projectId: string }) {
  const tasks = await prisma.task.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      capability: true,
      departmentKey: true,
    },
  });

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="No tasks"
        hint="Tasks are listed here as the agency makes decisions or as you issue commands."
      />
    );
  }

  const departmentCounts = await prisma.task.groupBy({
    by: ["departmentKey"],
    where: { projectId },
    _count: { id: true },
  });
  const usedDepartments = departmentCounts
    .filter((d) => d.departmentKey !== null)
    .map((d) => ({
      department: d.departmentKey as DepartmentKey,
      count: d._count.id,
    }));

  const boardItems: TaskBoardItem[] = tasks.map((task) => ({
    id: task.id,
    title: stripCapabilityPrefix(task.title),
    capability: task.capability,
    status: task.status,
    priority: task.priority,
    department: task.departmentKey,
    isInternal: INTERNAL_CAPABILITIES.has(task.capability),
  }));

  return (
    <TaskDepartmentBoard
      projectId={projectId}
      tasks={boardItems}
      usedDepartments={usedDepartments}
    />
  );
}

async function TaskDetail({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId },
    include: {
      parentTask: { select: { id: true, title: true, status: true } },
      childTasks: {
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: "asc" },
      },
      dependsOn: {
        include: {
          dependsOnTask: { select: { id: true, title: true, status: true } },
        },
      },
      dependedOnBy: {
        include: {
          task: { select: { id: true, title: true, status: true } },
        },
      },
      approvals: { orderBy: { createdAt: "desc" } },
      executionJobs: { orderBy: { createdAt: "desc" }, take: 10 },
      creatives: {
        orderBy: { createdAt: "desc" },
        include: {
          versions: {
            orderBy: { version: "desc" },
            take: 5,
            include: {
              asset: {
                select: {
                  id: true,
                  filename: true,
                  mimeType: true,
                  size: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!task) {
    return (
      <div className="space-y-4">
        <EmptyState icon={ClipboardList} title="Task not found" />
      </div>
    );
  }

  const goals = task.goalIds.length
    ? await prisma.projectGoal.findMany({
        where: { projectId, id: { in: task.goalIds } },
        select: { id: true, title: true },
      })
    : [];
  const goalTitle = new Map(goals.map((goal) => [goal.id, goal.title]));

  const fields: FieldSpec[] = [
    { type: "badge", label: "Status", meta: TASK_STATUS[task.status] },
    { type: "badge", label: "Priority", meta: TASK_PRIORITY[task.priority] },
    { type: "badge", label: "Risk", meta: RISK_LEVEL[task.riskLevel] },
    {
      type: "badge",
      label: "Department",
      meta: task.departmentKey ? DEPARTMENT_KEY[task.departmentKey] : undefined,
      accentColor: task.departmentKey
        ? DEPARTMENT_COLOR[task.departmentKey]
        : undefined,
    },
    {
      type: "text",
      label: "Capability",
      value: capabilityLabel(task.capability),
    },
    { type: "text", label: "Creator type", value: task.createdByType },
    {
      type: "boolean",
      label: "Requires approval",
      value: task.requiresApproval,
    },
    {
      type: "boolean",
      label: "Requires verification",
      value: task.requiresVerification,
    },
    {
      type: "node",
      label: "Parent task",
      node: task.parentTask ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "task", id: task.parentTask.id }}
          text={stripCapabilityPrefix(task.parentTask.title)}
          sub="tasks"
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Goals (goalIds)",
      node:
        task.goalIds.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1">
            {task.goalIds.map((goalId) => (
              <CrossLinkChip
                key={goalId}
                projectId={projectId}
                entity={{ kind: "goal", id: goalId }}
                text={goalTitle.get(goalId) ?? "Goal"}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    { type: "date", label: "Due date (dueAt)", value: task.dueAt },
    { type: "date", label: "Started", value: task.startedAt, relative: true },
    {
      type: "date",
      label: "Completed",
      value: task.completedAt,
      relative: true,
    },
    {
      type: "date",
      label: "Created",
      value: task.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Updated",
      value: task.updatedAt,
      relative: true,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-heading text-xl font-semibold text-foreground">
          {stripCapabilityPrefix(task.title)}
        </h2>
        {task.description ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {task.description}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge meta={TASK_STATUS[task.status]} />
        <StatusBadge meta={TASK_PRIORITY[task.priority]} />
        <StatusBadge meta={RISK_LEVEL[task.riskLevel]} />
        {task.departmentKey ? (
          <StatusBadge
            meta={DEPARTMENT_KEY[task.departmentKey]}
            accentColor={DEPARTMENT_COLOR[task.departmentKey]}
            showIcon
          />
        ) : null}
        {CANCELLABLE_TASK_STATUSES.has(task.status) ? (
          <ActionForm
            action={cancelTaskAction}
            successMessage="Task cancelled"
            className="ml-auto"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="taskId" value={task.id} />
            <SubmitButton variant="outline" size="xs">
              Cancel
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>

      <FieldGrid fields={fields} />

      {task.childTasks.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Subtasks</p>
          {task.childTasks.map((child) => (
            <Link
              key={child.id}
              href={buildHubHref(projectId, {
                panel: "work",
                sub: "tasks",
                entity: { kind: "task", id: child.id },
              })}
              scroll={false}
              className="flex items-center justify-between gap-2 rounded-lg bg-accent/50 px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate">
                {stripCapabilityPrefix(child.title)}
              </span>
              <StatusBadge
                meta={TASK_STATUS[child.status]}
                className="h-4 shrink-0 px-1.5 text-[10px]"
              />
            </Link>
          ))}
        </div>
      ) : null}

      {task.dependsOn.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Dependencies{" "}
            <span className="text-muted-foreground">(dependsOn)</span>
          </p>
          {task.dependsOn.map((dependency) => (
            <Link
              key={dependency.dependsOnTask.id}
              href={buildHubHref(projectId, {
                panel: "work",
                sub: "tasks",
                entity: { kind: "task", id: dependency.dependsOnTask.id },
              })}
              scroll={false}
              className="flex items-center justify-between gap-2 rounded-lg bg-accent/50 px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate">
                {stripCapabilityPrefix(dependency.dependsOnTask.title)}
              </span>
              <StatusBadge
                meta={TASK_STATUS[dependency.dependsOnTask.status]}
                className="h-4 shrink-0 px-1.5 text-[10px]"
              />
            </Link>
          ))}
        </div>
      ) : null}

      {task.dependedOnBy.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Tasks depending on this{" "}
            <span className="text-muted-foreground">(dependedOnBy)</span>
          </p>
          {task.dependedOnBy.map((dependency) => (
            <Link
              key={dependency.task.id}
              href={buildHubHref(projectId, {
                panel: "work",
                sub: "tasks",
                entity: { kind: "task", id: dependency.task.id },
              })}
              scroll={false}
              className="flex items-center justify-between gap-2 rounded-lg bg-accent/50 px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate">
                {stripCapabilityPrefix(dependency.task.title)}
              </span>
              <StatusBadge
                meta={TASK_STATUS[dependency.task.status]}
                className="h-4 shrink-0 px-1.5 text-[10px]"
              />
            </Link>
          ))}
        </div>
      ) : null}

      {task.approvals.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Approvals</p>
          {task.approvals.map((approval) => (
            <Card key={approval.id} size="sm">
              <CardContent>
                <FieldGrid
                  fields={[
                    {
                      type: "badge",
                      label: "Type",
                      meta: APPROVAL_TYPE[approval.type],
                    },
                    {
                      type: "badge",
                      label: "Status",
                      meta: APPROVAL_STATUS[approval.status],
                    },
                    {
                      type: "badge",
                      label: "Level",
                      meta: approval.level
                        ? APPROVAL_LEVEL[approval.level]
                        : undefined,
                    },
                    {
                      type: "text",
                      label: "Review note",
                      value: approval.reviewNote,
                    },
                    {
                      type: "date",
                      label: "Expires",
                      value: approval.expiresAt,
                    },
                    {
                      type: "date",
                      label: "Created",
                      value: approval.createdAt,
                      relative: true,
                    },
                    {
                      type: "date",
                      label: "Reviewed",
                      value: approval.reviewedAt,
                      relative: true,
                    },
                  ]}
                  className="text-xs"
                />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {task.executionJobs.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Execution jobs{" "}
            <span className="text-muted-foreground">(executionJobs)</span>
          </p>
          {task.executionJobs.map((job) => {
            const resultText = extractResultText(job.rawResult);
            return (
              <Card key={job.id} size="sm">
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">
                      {job.providerType}
                    </span>
                    <StatusBadge
                      meta={EXECUTION_JOB_STATUS[job.status]}
                      fallback={job.status}
                    />
                  </div>
                  <FieldGrid
                    fields={[
                      {
                        type: "text",
                        label: "Capability",
                        value: capabilityLabel(job.capability),
                      },
                      {
                        type: "text",
                        label: "Estimated cost",
                        value: job.estimatedCost,
                      },
                      {
                        type: "text",
                        label: "Actual cost",
                        value: job.actualCost,
                      },
                      {
                        type: "date",
                        label: "Started",
                        value: job.startedAt,
                        relative: true,
                      },
                      {
                        type: "date",
                        label: "Completed",
                        value: job.completedAt,
                        relative: true,
                      },
                      {
                        type: "date",
                        label: "Created",
                        value: job.createdAt,
                        relative: true,
                      },
                      {
                        type: "date",
                        label: "Updated",
                        value: job.updatedAt,
                        relative: true,
                      },
                    ]}
                    className="text-xs"
                  />
                  {job.errorMessage ? (
                    <p className="text-xs text-destructive">
                      {job.errorMessage}
                    </p>
                  ) : resultText ? (
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {resultText}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}

      {task.creatives.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Generated content{" "}
            <span className="text-muted-foreground">(creatives)</span>
          </p>
          {task.creatives.map((creative) => (
            <Card key={creative.id} size="sm">
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/creatives/${creative.id}`}
                    className="text-xs text-primary underline-offset-2 hover:underline"
                  >
                    View creative
                  </Link>
                  <div className="flex items-center gap-1.5">
                    {creative.platform ? (
                      <StatusBadge
                        meta={undefined}
                        fallback={creative.platform}
                        className="h-4 px-1.5 text-[10px]"
                      />
                    ) : null}
                    <StatusBadge
                      meta={CREATIVE_STATUS[creative.status]}
                      className="h-4 px-1.5 text-[10px]"
                    />
                  </div>
                </div>
                <FieldGrid
                  fields={[
                    { type: "text", label: "Type", value: creative.type },
                    { type: "text", label: "Brief", value: creative.brief },
                    {
                      type: "date",
                      label: "Created",
                      value: creative.createdAt,
                      relative: true,
                    },
                    {
                      type: "date",
                      label: "Updated",
                      value: creative.updatedAt,
                      relative: true,
                    },
                  ]}
                  className="text-xs"
                />
                {creative.versions.length > 0 ? (
                  <div className="space-y-1.5 border-t border-border/60 pt-2">
                    {creative.versions.map((version) => (
                      <div
                        key={version.id}
                        className="space-y-1 rounded-lg bg-accent/40 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>v{version.version}</span>
                          <span>{timeAgo(version.createdAt)}</span>
                        </div>
                        <AssetPreview asset={version.asset} />
                        {version.caption ? (
                          <p className="text-xs">{version.caption}</p>
                        ) : null}
                        {version.copy ? (
                          <p className="text-xs text-muted-foreground">
                            {version.copy}
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                          <span>
                            Provider: {version.generationProvider ?? "—"}
                          </span>
                          {version.revisionReason ? (
                            <span>Revision: {version.revisionReason}</span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}

