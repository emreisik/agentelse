import Link from "next/link";
import { ArrowRight, ClipboardList, Ruler, Send } from "lucide-react";
import type { DepartmentKey, TaskStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { shortDate, timeAgo } from "@/lib/dates";
import { extractResultText } from "@/lib/execution-result-text";
import {
  APPROVAL_LEVEL,
  APPROVAL_STATUS,
  APPROVAL_TYPE,
  CREATIVE_STATUS,
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  EXECUTION_JOB_STATUS,
  MEASUREMENT_CHECK_STATUS,
  MEASUREMENT_PLAN_STATUS,
  RISK_LEVEL,
  TASK_PRIORITY,
  TASK_STATUS,
  WORK_HANDOFF_STATUS,
  WORK_PLAN_STATUS,
  WORK_PLAN_TYPE,
  capabilityLabel,
  stripCapabilityPrefix,
} from "@/lib/labels";
import {
  acceptHandoffAction,
  approveWorkPlanAction,
  cancelWorkPlanAction,
  rejectHandoffAction,
} from "@/server/actions/agency-work-actions";
import { taskFingerprint } from "@/server/agency/fingerprint";
import { cn } from "@/lib/utils";
import { ActionForm } from "@/components/shared/action-form";
import {
  DependencyGraph,
  type GraphNode,
} from "@/components/shared/dependency-graph";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent } from "@/components/ui/card";
import {
  buildHubHref,
  ISLER_SUB_KEYS,
  type IslerSubKey,
} from "../hub-core-params";
import { AssetPreview } from "../primitives/asset-preview";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { EntityDetailSheet } from "../primitives/entity-detail-sheet";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import {
  TaskDepartmentBoard,
  type TaskBoardItem,
} from "./task-department-board";
import { WorkPlanBoard, type WorkPlanBoardItem } from "./work-plan-board";
import {
  WorkHandoffBoard,
  type WorkHandoffBoardItem,
} from "./work-handoff-board";
import {
  MeasurementPlanBoard,
  type MeasurementPlanBoardItem,
} from "./measurement-plan-board";
import type { PanelProps } from "./panel-props";

const DONE_TASK_STATUSES: TaskStatus[] = ["COMPLETED"];

const TAB_LABEL: Record<IslerSubKey, string> = {
  planlar: "Planlar",
  gorevler: "Görevler",
  devirler: "Devirler",
  olcumler: "Ölçümler",
};

function isIslerSub(value: string | null): value is IslerSubKey {
  return !!value && (ISLER_SUB_KEYS as readonly string[]).includes(value);
}

// Referanslar: src/app/projects/[projectId]/isler/page.tsx (shell) +
// src/components/work/{plans-tab,tasks-tab,handoffs-tab,measurements-tab,
// plan-sheet,task-sheet}.tsx. HUB CORE'da 4 alt-sekme `sub` param'ıyla
// (planlar|gorevler|devirler|olcumler) kendi iç tab-bar'ıyla yönetiliyor;
// entity bu panelin sahip olduğu 4 türden biriyse (workPlan/task/handoff/
// measurementPlan — bkz. ENTITY_PANEL) liste yerine tam detay render edilir.
export async function IslerPanel({ projectId, entity, sub }: PanelProps) {
  const activeSub: IslerSubKey = isIslerSub(sub) ? sub : "planlar";

  const [planCount, taskCount, handoffCount, measurementCount] =
    await Promise.all([
      prisma.workPlan.count({ where: { projectId } }),
      prisma.task.count({ where: { projectId } }),
      prisma.workHandoff.count({ where: { projectId } }),
      prisma.measurementPlan.count({ where: { projectId } }),
    ]);
  const tabCount: Record<IslerSubKey, number> = {
    planlar: planCount,
    gorevler: taskCount,
    devirler: handoffCount,
    olcumler: measurementCount,
  };

  const ownedEntity =
    entity &&
    (entity.kind === "workPlan" ||
      entity.kind === "task" ||
      entity.kind === "handoff" ||
      entity.kind === "measurementPlan")
      ? entity
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 pt-6">
      <div className="flex shrink-0 items-center gap-1 border-b border-border">
        {ISLER_SUB_KEYS.map((key) => {
          const isActive = key === activeSub && !ownedEntity;
          return (
            <Link
              key={key}
              href={buildHubHref(projectId, {
                panel: "isler",
                sub: key,
                entity: null,
              })}
              scroll={false}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                isActive
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {TAB_LABEL[key]}
              <span
                className={cn(
                  "flex h-4 min-w-4 items-center justify-center rounded-4xl px-1 text-[10px] font-medium tabular-nums",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {tabCount[key]}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 pb-6">
        {activeSub === "gorevler" ? (
          <TasksBoard projectId={projectId} />
        ) : activeSub === "devirler" ? (
          <HandoffsBoard projectId={projectId} />
        ) : activeSub === "olcumler" ? (
          <MeasurementsBoard projectId={projectId} />
        ) : (
          <PlansBoard projectId={projectId} />
        )}
      </div>

      {ownedEntity ? (
        <EntityDetailSheet
          title={
            ownedEntity.kind === "workPlan"
              ? "İş planı detayı"
              : ownedEntity.kind === "task"
                ? "Görev detayı"
                : ownedEntity.kind === "handoff"
                  ? "Devir detayı"
                  : "Ölçüm planı detayı"
          }
          closeHref={buildHubHref(projectId, {
            panel: "isler",
            sub: activeSub,
            entity: null,
          })}
        >
          {ownedEntity.kind === "workPlan" ? (
            <WorkPlanDetail projectId={projectId} planId={ownedEntity.id} />
          ) : ownedEntity.kind === "task" ? (
            <TaskDetail projectId={projectId} taskId={ownedEntity.id} />
          ) : ownedEntity.kind === "handoff" ? (
            <HandoffDetail projectId={projectId} handoffId={ownedEntity.id} />
          ) : (
            <MeasurementPlanDetail
              projectId={projectId}
              measurementPlanId={ownedEntity.id}
            />
          )}
        </EntityDetailSheet>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PLANLAR
// ---------------------------------------------------------------------------

// Fikirler/Görevler ile birebir aynı sistem: tam listeyi çek, tip
// dağılımını groupBy ile hesapla, kanbanı (WorkPlanBoard) besle. Onayla/
// İptal Et aksiyonları artık kart üstünde değil — WorkPlanDetail'de zaten
// aynı aksiyonlar var, karta tıklayınca oraya gidiliyor (diğer kanban
// kartlarıyla tutarlı: kart = navigasyon, aksiyon = detay sayfası).
async function PlansBoard({ projectId }: { projectId: string }) {
  const plans = await prisma.workPlan.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      planType: true,
      status: true,
      isMock: true,
      goalIds: true,
      ideaId: true,
      createdAt: true,
      tasks: { select: { status: true } },
    },
  });

  if (plans.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="İş planı yok"
        hint="Onaylanan fikirler görev grafiği içeren iş planlarına dönüştürülür."
      />
    );
  }

  const goalIds = [...new Set(plans.flatMap((plan) => plan.goalIds))];
  const goals = goalIds.length
    ? await prisma.projectGoal.findMany({
        where: { projectId, id: { in: goalIds } },
        select: { id: true, title: true },
      })
    : [];
  const goalTitle = new Map(goals.map((goal) => [goal.id, goal.title]));

  const typeCounts = await prisma.workPlan.groupBy({
    by: ["planType"],
    where: { projectId },
    _count: { id: true },
  });
  const usedTypes = typeCounts.map((t) => ({
    planType: t.planType,
    count: t._count.id,
  }));

  const boardItems: WorkPlanBoardItem[] = plans.map((plan) => ({
    id: plan.id,
    title: plan.title,
    planType: plan.planType,
    status: plan.status,
    isMock: plan.isMock,
    doneTasks: plan.tasks.filter((task) =>
      DONE_TASK_STATUSES.includes(task.status),
    ).length,
    totalTasks: plan.tasks.length,
    goals: plan.goalIds.map((id) => ({
      id,
      title: goalTitle.get(id) ?? "Hedef",
    })),
    ideaId: plan.ideaId,
    createdAt: plan.createdAt.toISOString(),
  }));

  return (
    <WorkPlanBoard
      projectId={projectId}
      plans={boardItems}
      usedTypes={usedTypes}
    />
  );
}

function parseGraphNodes(graph: unknown): GraphNode[] {
  if (!Array.isArray(graph)) return [];
  return graph
    .filter(
      (node): node is Record<string, unknown> =>
        typeof node === "object" && node !== null,
    )
    .map((node) => ({
      key: String(node.key ?? ""),
      capability: String(node.capability ?? ""),
      department: String(node.department ?? ""),
      dependsOnKeys: Array.isArray(node.dependsOnKeys)
        ? node.dependsOnKeys.map(String)
        : [],
    }))
    .filter((node) => node.key);
}

async function WorkPlanDetail({
  projectId,
  planId,
}: {
  projectId: string;
  planId: string;
}) {
  const plan = await prisma.workPlan.findFirst({
    where: { id: planId, projectId },
    include: {
      tasks: {
        select: {
          id: true,
          title: true,
          status: true,
          departmentKey: true,
          fingerprint: true,
        },
        orderBy: { createdAt: "asc" },
      },
      handoffs: true,
    },
  });

  if (!plan) {
    return (
      <div className="space-y-4">
        <EmptyState icon={ClipboardList} title="İş planı bulunamadı" />
      </div>
    );
  }

  const nodes = parseGraphNodes(plan.graph);
  const taskByFingerprint = new Map(
    plan.tasks
      .filter((task) => task.fingerprint)
      .map((task) => [task.fingerprint as string, task]),
  );
  const taskStatusByKey: Record<string, TaskStatus> = {};
  for (const node of nodes) {
    const task = taskByFingerprint.get(
      taskFingerprint({
        capability: node.capability,
        department: node.department,
        subject: `${plan.id}:${node.key}`,
      }),
    );
    if (task) taskStatusByKey[node.key] = task.status;
  }

  const goals = plan.goalIds.length
    ? await prisma.projectGoal.findMany({
        where: { projectId, id: { in: plan.goalIds } },
        select: { id: true, title: true },
      })
    : [];
  const goalTitle = new Map(goals.map((goal) => [goal.id, goal.title]));

  const fields: FieldSpec[] = [
    { type: "badge", label: "Tür", meta: WORK_PLAN_TYPE[plan.planType] },
    { type: "badge", label: "Durum", meta: WORK_PLAN_STATUS[plan.status] },
    { type: "boolean", label: "Demo (isMock)", value: plan.isMock },
    {
      type: "node",
      label: "Kaynak fikir",
      node: plan.ideaId ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "idea", id: plan.ideaId }}
          text="Fikre git"
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Kaynak fırsat",
      node: plan.opportunityId ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "opportunity", id: plan.opportunityId }}
          text="Fırsata git"
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Karar",
      node: plan.decisionId ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "decision", id: plan.decisionId }}
          text="Karar günlüğü"
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Hedefler (goalIds)",
      node:
        plan.goalIds.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1">
            {plan.goalIds.map((goalId) => (
              <CrossLinkChip
                key={goalId}
                projectId={projectId}
                entity={{ kind: "goal", id: goalId }}
                text={goalTitle.get(goalId) ?? "Hedef"}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    {
      type: "date",
      label: "Oluşturulma",
      value: plan.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Güncellenme",
      value: plan.updatedAt,
      relative: true,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-heading text-xl font-semibold text-foreground">
          {plan.title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {WORK_PLAN_TYPE[plan.planType].label} · {nodes.length} adım
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <StatusBadge meta={WORK_PLAN_STATUS[plan.status]} />
        <StatusBadge meta={WORK_PLAN_TYPE[plan.planType]} />
        {plan.isMock ? (
          <StatusBadge meta={{ label: "Demo", tone: "special" }} />
        ) : null}
      </div>

      {nodes.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Bağımlılık grafiği
          </p>
          <DependencyGraph nodes={nodes} taskStatusByKey={taskStatusByKey} />
        </div>
      ) : null}

      <FieldGrid fields={fields} />

      {plan.tasks.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Görevler</p>
          {plan.tasks.map((task) => (
            <Link
              key={task.id}
              href={buildHubHref(projectId, {
                panel: "isler",
                sub: "gorevler",
                entity: { kind: "task", id: task.id },
              })}
              scroll={false}
              className="flex items-center justify-between gap-2 rounded-lg bg-accent/50 px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate">
                {stripCapabilityPrefix(task.title)}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {task.departmentKey ? (
                  <StatusBadge
                    meta={DEPARTMENT_KEY[task.departmentKey]}
                    accentColor={DEPARTMENT_COLOR[task.departmentKey]}
                    className="h-4 px-1.5 text-[10px]"
                    showIcon
                  />
                ) : null}
                <StatusBadge
                  meta={TASK_STATUS[task.status]}
                  className="h-4 px-1.5 text-[10px]"
                />
              </div>
            </Link>
          ))}
        </div>
      ) : null}

      {plan.handoffs.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Devirler</p>
          {plan.handoffs.map((handoff) => (
            <Link
              key={handoff.id}
              href={buildHubHref(projectId, {
                panel: "isler",
                sub: "devirler",
                entity: { kind: "handoff", id: handoff.id },
              })}
              scroll={false}
              className="flex items-center justify-between gap-2 rounded-lg bg-accent/50 px-3 py-2 text-xs transition-colors hover:bg-accent"
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: DEPARTMENT_COLOR[handoff.fromDepartment],
                  }}
                />
                {DEPARTMENT_KEY[handoff.fromDepartment].label}
                <ArrowRight className="size-3" />
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: DEPARTMENT_COLOR[handoff.toDepartment],
                  }}
                />
                {DEPARTMENT_KEY[handoff.toDepartment].label}
              </span>
              <StatusBadge
                meta={WORK_HANDOFF_STATUS[handoff.status]}
                className="h-4 px-1.5 text-[10px]"
              />
            </Link>
          ))}
        </div>
      ) : null}

      {plan.status === "AWAITING_APPROVAL" ? (
        <div className="flex items-center justify-end gap-1.5 border-t border-border pt-3">
          <ActionForm
            action={cancelWorkPlanAction}
            successMessage="Plan iptal edildi"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="workPlanId" value={plan.id} />
            <SubmitButton variant="outline" size="xs">
              İptal Et
            </SubmitButton>
          </ActionForm>
          <ActionForm
            action={approveWorkPlanAction}
            successMessage="Plan onaylandı — görevler başlatılıyor"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="workPlanId" value={plan.id} />
            <SubmitButton size="xs">Onayla</SubmitButton>
          </ActionForm>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GÖREVLER
// ---------------------------------------------------------------------------

// Fikirler panosunun (fikirler-panel.tsx IdeaListView) birebir aynı sistemi:
// tam listeyi çek, departman dağılımını groupBy ile hesapla, kanbanı
// (TaskDepartmentBoard) besle. departmentKey Task'ta doğrudan bir kolon
// olduğundan (Idea'daki concept.departmentsInvolved JSON'unun aksine) ekstra
// bir "primaryDepartment" çıkarımına gerek yok.
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
        title="Görev yok"
        hint="Ajans karar verdikçe veya siz komut verdikçe görevler burada listelenir."
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
      workPlan: { select: { id: true, title: true } },
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
        <EmptyState icon={ClipboardList} title="Görev bulunamadı" />
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
    { type: "badge", label: "Durum", meta: TASK_STATUS[task.status] },
    { type: "badge", label: "Öncelik", meta: TASK_PRIORITY[task.priority] },
    { type: "badge", label: "Risk", meta: RISK_LEVEL[task.riskLevel] },
    {
      type: "badge",
      label: "Departman",
      meta: task.departmentKey ? DEPARTMENT_KEY[task.departmentKey] : undefined,
      accentColor: task.departmentKey
        ? DEPARTMENT_COLOR[task.departmentKey]
        : undefined,
    },
    {
      type: "text",
      label: "Yetenek (capability)",
      value: capabilityLabel(task.capability),
    },
    { type: "text", label: "Oluşturan tipi", value: task.createdByType },
    { type: "boolean", label: "Onay gerektirir", value: task.requiresApproval },
    {
      type: "boolean",
      label: "Doğrulama gerektirir",
      value: task.requiresVerification,
    },
    {
      type: "node",
      label: "Üst görev",
      node: task.parentTask ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "task", id: task.parentTask.id }}
          text={stripCapabilityPrefix(task.parentTask.title)}
          sub="gorevler"
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "İş planı",
      node: task.workPlanId ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "workPlan", id: task.workPlanId }}
          text={task.workPlan?.title ?? "Plana git"}
          sub="planlar"
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Kaynak karar",
      node: task.sourceDecisionId ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "decision", id: task.sourceDecisionId }}
          text="Karar günlüğü"
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Hedefler (goalIds)",
      node:
        task.goalIds.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1">
            {task.goalIds.map((goalId) => (
              <CrossLinkChip
                key={goalId}
                projectId={projectId}
                entity={{ kind: "goal", id: goalId }}
                text={goalTitle.get(goalId) ?? "Hedef"}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    { type: "date", label: "Son tarih (dueAt)", value: task.dueAt },
    { type: "date", label: "Başlama", value: task.startedAt, relative: true },
    {
      type: "date",
      label: "Tamamlanma",
      value: task.completedAt,
      relative: true,
    },
    {
      type: "date",
      label: "Oluşturulma",
      value: task.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Güncellenme",
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

      <div className="flex flex-wrap gap-1.5">
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
      </div>

      <FieldGrid fields={fields} />

      {task.childTasks.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Alt görevler</p>
          {task.childTasks.map((child) => (
            <Link
              key={child.id}
              href={buildHubHref(projectId, {
                panel: "isler",
                sub: "gorevler",
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
            Bağımlılıklar{" "}
            <span className="text-muted-foreground">(dependsOn)</span>
          </p>
          {task.dependsOn.map((dependency) => (
            <Link
              key={dependency.dependsOnTask.id}
              href={buildHubHref(projectId, {
                panel: "isler",
                sub: "gorevler",
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
            Bu göreve bağımlı olanlar{" "}
            <span className="text-muted-foreground">(dependedOnBy)</span>
          </p>
          {task.dependedOnBy.map((dependency) => (
            <Link
              key={dependency.task.id}
              href={buildHubHref(projectId, {
                panel: "isler",
                sub: "gorevler",
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
          <p className="text-sm font-medium text-foreground">Onaylar</p>
          {task.approvals.map((approval) => (
            <Card key={approval.id} size="sm">
              <CardContent>
                <FieldGrid
                  fields={[
                    {
                      type: "badge",
                      label: "Tür",
                      meta: APPROVAL_TYPE[approval.type],
                    },
                    {
                      type: "badge",
                      label: "Durum",
                      meta: APPROVAL_STATUS[approval.status],
                    },
                    {
                      type: "badge",
                      label: "Seviye",
                      meta: approval.level
                        ? APPROVAL_LEVEL[approval.level]
                        : undefined,
                    },
                    {
                      type: "text",
                      label: "İnceleme notu",
                      value: approval.reviewNote,
                    },
                    {
                      type: "date",
                      label: "Son geçerlilik",
                      value: approval.expiresAt,
                    },
                    {
                      type: "date",
                      label: "Oluşturulma",
                      value: approval.createdAt,
                      relative: true,
                    },
                    {
                      type: "date",
                      label: "İncelenme",
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
            Yürütme işleri{" "}
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
                        label: "Yetenek",
                        value: capabilityLabel(job.capability),
                      },
                      {
                        type: "text",
                        label: "Tahmini maliyet",
                        value: job.estimatedCost,
                      },
                      {
                        type: "text",
                        label: "Gerçek maliyet",
                        value: job.actualCost,
                      },
                      {
                        type: "date",
                        label: "Başlama",
                        value: job.startedAt,
                        relative: true,
                      },
                      {
                        type: "date",
                        label: "Tamamlanma",
                        value: job.completedAt,
                        relative: true,
                      },
                      {
                        type: "date",
                        label: "Oluşturulma",
                        value: job.createdAt,
                        relative: true,
                      },
                      {
                        type: "date",
                        label: "Güncellenme",
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
            Üretilen içerik{" "}
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
                    Kreatifi görüntüle
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
                    { type: "text", label: "Tür", value: creative.type },
                    { type: "text", label: "Brief", value: creative.brief },
                    {
                      type: "date",
                      label: "Oluşturulma",
                      value: creative.createdAt,
                      relative: true,
                    },
                    {
                      type: "date",
                      label: "Güncellenme",
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
                            Sağlayıcı: {version.generationProvider ?? "—"}
                          </span>
                          {version.revisionReason ? (
                            <span>Revizyon: {version.revisionReason}</span>
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

// ---------------------------------------------------------------------------
// DEVİRLER
// ---------------------------------------------------------------------------

type HandoffRow = {
  id: string;
  fromDepartment: keyof typeof DEPARTMENT_KEY;
  toDepartment: keyof typeof DEPARTMENT_KEY;
  fromTaskId: string | null;
  toTaskId: string | null;
  workPlanId: string | null;
  reason: string;
  payload: unknown;
  status: keyof typeof WORK_HANDOFF_STATUS;
  decisionId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  workPlan: { id: string; title: string } | null;
};

function HandoffCard({
  projectId,
  handoff,
  taskById,
}: {
  projectId: string;
  handoff: HandoffRow;
  taskById: Map<string, { id: string; title: string; status: TaskStatus }>;
}) {
  const FromIcon = DEPARTMENT_KEY[handoff.fromDepartment].icon;
  const ToIcon = DEPARTMENT_KEY[handoff.toDepartment].icon;
  const fromTask = handoff.fromTaskId ? taskById.get(handoff.fromTaskId) : null;
  const toTask = handoff.toTaskId ? taskById.get(handoff.toTaskId) : null;

  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span
              className="flex size-6 items-center justify-center rounded-lg"
              style={{
                backgroundColor: `color-mix(in oklch, ${DEPARTMENT_COLOR[handoff.fromDepartment]} 15%, transparent)`,
                color: DEPARTMENT_COLOR[handoff.fromDepartment],
              }}
            >
              {FromIcon ? <FromIcon className="size-3.5" /> : null}
            </span>
            {DEPARTMENT_KEY[handoff.fromDepartment].label}
            <ArrowRight className="size-3.5 text-muted-foreground" />
            <span
              className="flex size-6 items-center justify-center rounded-lg"
              style={{
                backgroundColor: `color-mix(in oklch, ${DEPARTMENT_COLOR[handoff.toDepartment]} 15%, transparent)`,
                color: DEPARTMENT_COLOR[handoff.toDepartment],
              }}
            >
              {ToIcon ? <ToIcon className="size-3.5" /> : null}
            </span>
            {DEPARTMENT_KEY[handoff.toDepartment].label}
          </div>
          <StatusBadge meta={WORK_HANDOFF_STATUS[handoff.status]} />
        </div>
        <p className="text-xs text-muted-foreground">{handoff.reason}</p>
        <div className="flex flex-wrap gap-1.5">
          {handoff.workPlanId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "workPlan", id: handoff.workPlanId }}
              text={handoff.workPlan?.title ?? "İş planı"}
              sub="planlar"
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
          {handoff.fromTaskId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "task", id: handoff.fromTaskId }}
              text={
                fromTask
                  ? stripCapabilityPrefix(fromTask.title)
                  : "Kaynak görev"
              }
              sub="gorevler"
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
          {handoff.toTaskId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "task", id: handoff.toTaskId }}
              text={
                toTask ? stripCapabilityPrefix(toTask.title) : "Hedef görev"
              }
              sub="gorevler"
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
          {handoff.decisionId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "decision", id: handoff.decisionId }}
              text="Karar günlüğü"
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {timeAgo(handoff.createdAt)} · güncelleme{" "}
            {timeAgo(handoff.updatedAt)}
            {handoff.expiresAt
              ? ` · Son geçerlilik: ${shortDate(handoff.expiresAt)}`
              : ""}
          </span>
          {handoff.status === "PROPOSED" ? (
            <div className="flex items-center gap-1.5">
              <ActionForm
                action={rejectHandoffAction}
                successMessage="Devir reddedildi"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="handoffId" value={handoff.id} />
                <SubmitButton variant="outline" size="xs">
                  Reddet
                </SubmitButton>
              </ActionForm>
              <ActionForm
                action={acceptHandoffAction}
                successMessage="Devir kabul edildi — görev oluşturuluyor"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="handoffId" value={handoff.id} />
                <SubmitButton size="xs">Kabul Et</SubmitButton>
              </ActionForm>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// Kart üstü Kabul Et/Reddet aksiyonları kaldırıldı — HandoffDetail zaten
// aynı HandoffCard'ı (aksiyonlarıyla birlikte) render ediyor, kart burada
// da diğer panolar gibi sade bir navigasyon öğesi.
async function HandoffsBoard({ projectId }: { projectId: string }) {
  const handoffs = await prisma.workHandoff.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      fromDepartment: true,
      toDepartment: true,
      status: true,
      reason: true,
      createdAt: true,
    },
  });

  if (handoffs.length === 0) {
    return (
      <EmptyState
        icon={Send}
        title="Devir yok"
        hint="Bir departman işi tamamlayıp diğerine devrettiğinde devirler burada görünür."
      />
    );
  }

  const departmentCounts = await prisma.workHandoff.groupBy({
    by: ["fromDepartment"],
    where: { projectId },
    _count: { id: true },
  });
  const usedDepartments = departmentCounts.map((d) => ({
    department: d.fromDepartment,
    count: d._count.id,
  }));

  const boardItems: WorkHandoffBoardItem[] = handoffs.map((handoff) => ({
    id: handoff.id,
    fromDepartment: handoff.fromDepartment,
    toDepartment: handoff.toDepartment,
    status: handoff.status,
    reason: handoff.reason,
    createdAt: handoff.createdAt.toISOString(),
  }));

  return (
    <WorkHandoffBoard
      projectId={projectId}
      handoffs={boardItems}
      usedDepartments={usedDepartments}
    />
  );
}

async function HandoffDetail({
  projectId,
  handoffId,
}: {
  projectId: string;
  handoffId: string;
}) {
  const handoff = await prisma.workHandoff.findFirst({
    where: { id: handoffId, projectId },
    include: { workPlan: { select: { id: true, title: true } } },
  });

  if (!handoff) {
    return (
      <div className="space-y-4">
        <EmptyState icon={Send} title="Devir bulunamadı" />
      </div>
    );
  }

  const taskIds = [handoff.fromTaskId, handoff.toTaskId].filter(
    (id): id is string => !!id,
  );
  const tasks = taskIds.length
    ? await prisma.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, title: true, status: true },
      })
    : [];
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  return (
    <div className="space-y-4">
      <HandoffCard
        projectId={projectId}
        handoff={handoff}
        taskById={taskById}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ÖLÇÜMLER
// ---------------------------------------------------------------------------

type MeasurementPlanRow = {
  id: string;
  description: string;
  status: keyof typeof MEASUREMENT_PLAN_STATUS;
  taskId: string | null;
  workPlanId: string | null;
  ideaId: string | null;
  createdAt: Date;
  updatedAt: Date;
  checks: Array<{
    id: string;
    label: string;
    capability: string;
    dueAt: Date;
    status: keyof typeof MEASUREMENT_CHECK_STATUS;
    resultTaskId: string | null;
    resultSummary: unknown;
  }>;
};

function MeasurementPlanCard({
  projectId,
  plan,
  taskTitle,
  workPlanTitle,
  ideaTitle,
}: {
  projectId: string;
  plan: MeasurementPlanRow;
  taskTitle: Map<string, string>;
  workPlanTitle: Map<string, string>;
  ideaTitle: Map<string, string>;
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-sm font-medium">{plan.description}</p>
          <StatusBadge
            meta={MEASUREMENT_PLAN_STATUS[plan.status]}
            className="shrink-0"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {plan.taskId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "task", id: plan.taskId }}
              text={taskTitle.get(plan.taskId) ?? "İlgili görev"}
              sub="gorevler"
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
          {plan.workPlanId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "workPlan", id: plan.workPlanId }}
              text={workPlanTitle.get(plan.workPlanId) ?? "İlgili plan"}
              sub="planlar"
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
          {plan.ideaId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "idea", id: plan.ideaId }}
              text={ideaTitle.get(plan.ideaId) ?? "İlgili fikir"}
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
          <span className="text-[10px] text-muted-foreground">
            {timeAgo(plan.createdAt)} · güncelleme {timeAgo(plan.updatedAt)}
          </span>
        </div>
        <div className="space-y-1.5">
          {plan.checks.map((check) => {
            const summary =
              check.resultSummary && typeof check.resultSummary === "object"
                ? (check.resultSummary as Record<string, unknown>)
                : null;
            return (
              <div
                key={check.id}
                className="flex items-start gap-3 rounded-lg bg-accent/40 px-3 py-2"
              >
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    check.status === "COMPLETED"
                      ? "bg-success"
                      : check.status === "FAILED"
                        ? "bg-destructive"
                        : check.status === "RUNNING"
                          ? "bg-primary"
                          : "bg-muted-foreground/40",
                  )}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{check.label}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <StatusBadge
                        meta={MEASUREMENT_CHECK_STATUS[check.status]}
                        className="h-4 px-1.5 text-[10px]"
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {shortDate(check.dueAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{capabilityLabel(check.capability)}</span>
                    {check.resultTaskId ? (
                      <CrossLinkChip
                        projectId={projectId}
                        entity={{ kind: "task", id: check.resultTaskId }}
                        text="Sonuç görevi"
                        sub="gorevler"
                        className="h-4 px-1.5 text-[10px]"
                      />
                    ) : null}
                  </div>
                  {summary ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {Object.entries(summary).map(([key, value]) => (
                        <span key={key}>
                          {key}:{" "}
                          {typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

async function MeasurementsBoard({ projectId }: { projectId: string }) {
  const plans = await prisma.measurementPlan.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      description: true,
      status: true,
      createdAt: true,
      checks: { select: { status: true } },
    },
  });

  if (plans.length === 0) {
    return (
      <EmptyState
        icon={Ruler}
        title="Ölçüm planı yok"
        hint="Yayına alınan işler için ölçüm planları otomatik zamanlanır; sonuçlar öğrenimlere dönüşür."
      />
    );
  }

  const boardItems: MeasurementPlanBoardItem[] = plans.map((plan) => ({
    id: plan.id,
    description: plan.description,
    status: plan.status,
    doneChecks: plan.checks.filter((check) => check.status === "COMPLETED")
      .length,
    totalChecks: plan.checks.length,
    createdAt: plan.createdAt.toISOString(),
  }));

  return <MeasurementPlanBoard projectId={projectId} plans={boardItems} />;
}

async function resolveMeasurementRefs(
  projectId: string,
  plans: MeasurementPlanRow[],
) {
  const taskIds = [
    ...new Set(
      plans
        .flatMap((p) => [p.taskId, ...p.checks.map((c) => c.resultTaskId)])
        .filter((id): id is string => !!id),
    ),
  ];
  const workPlanIds = [
    ...new Set(
      plans.map((p) => p.workPlanId).filter((id): id is string => !!id),
    ),
  ];
  const ideaIds = [
    ...new Set(plans.map((p) => p.ideaId).filter((id): id is string => !!id)),
  ];

  const [tasks, workPlans, ideas] = await Promise.all([
    taskIds.length
      ? prisma.task.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    workPlanIds.length
      ? prisma.workPlan.findMany({
          where: { id: { in: workPlanIds }, projectId },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    ideaIds.length
      ? prisma.idea.findMany({
          where: { id: { in: ideaIds }, projectId },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    taskTitle: new Map(
      tasks.map((t) => [t.id, stripCapabilityPrefix(t.title)]),
    ),
    workPlanTitle: new Map(workPlans.map((w) => [w.id, w.title])),
    ideaTitle: new Map(ideas.map((i) => [i.id, i.title])),
  };
}

async function MeasurementPlanDetail({
  projectId,
  measurementPlanId,
}: {
  projectId: string;
  measurementPlanId: string;
}) {
  const plan = await prisma.measurementPlan.findFirst({
    where: { id: measurementPlanId, projectId },
    include: { checks: { orderBy: { dueAt: "asc" } } },
  });

  if (!plan) {
    return (
      <div className="space-y-4">
        <EmptyState icon={Ruler} title="Ölçüm planı bulunamadı" />
      </div>
    );
  }

  const { taskTitle, workPlanTitle, ideaTitle } = await resolveMeasurementRefs(
    projectId,
    [plan],
  );

  return (
    <div className="space-y-4">
      <MeasurementPlanCard
        projectId={projectId}
        plan={plan}
        taskTitle={taskTitle}
        workPlanTitle={workPlanTitle}
        ideaTitle={ideaTitle}
      />
    </div>
  );
}
