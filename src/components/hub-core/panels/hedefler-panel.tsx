import Link from "next/link";
import { ArrowLeft, Target } from "lucide-react";
import type { ActorType, ProjectGoalStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { PROJECT_GOAL_STATUS } from "@/lib/labels";
import {
  approveGoalAction,
  rejectGoalAction,
  updateGoalAction,
} from "@/server/actions/agency-strategy-actions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { GoalEditDialog } from "@/components/shared/goal-edit-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent } from "@/components/ui/card";
import { buildHubHref, entityHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import type { PanelProps } from "./panel-props";

const GOAL_GROUPS: Array<{ label: string; statuses: ProjectGoalStatus[] }> = [
  { label: "Kararınız bekleniyor", statuses: ["PROPOSED"] },
  { label: "Aktif", statuses: ["APPROVED", "ACTIVE"] },
  { label: "Diğer", statuses: ["PAUSED", "ACHIEVED", "REJECTED", "ARCHIVED"] },
];

const ACTOR_TYPE_LABEL: Record<ActorType, string> = {
  USER: "Kullanıcı",
  SYSTEM: "Sistem",
  AI: "Yapay Zeka",
  OPENCLAW: "OpenClaw",
  API: "API",
  PARTNER: "Partner",
};

// Hedefler paneli — boru hattındaki tek gerçek "karar bekliyor"
// aksiyonlarının (Onayla/Reddet) yaşadığı yer. `entity` bir hedefi işaret
// ediyorsa liste yerine o hedefin tam detayı gösterilir.
export async function HedeflerPanel({ projectId, entity }: PanelProps) {
  if (entity?.kind === "goal") {
    return (
      <div className="space-y-4 py-6">
        <GoalDetail projectId={projectId} goalId={entity.id} />
      </div>
    );
  }

  return (
    <div className="space-y-6 py-6">
      <GoalListSection projectId={projectId} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function BackToList({ projectId }: { projectId: string }) {
  return (
    <Link
      href={buildHubHref(projectId, {
        panel: "hedefler",
        sub: null,
        entity: null,
      })}
      className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
    >
      <ArrowLeft className="size-3" />
      Listeye dön
    </Link>
  );
}

// ---------------------------------------------------------------------------

async function GoalListSection({ projectId }: { projectId: string }) {
  const goals = await prisma.projectGoal.findMany({
    where: { projectId },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  if (goals.length === 0) {
    return (
      <EmptyState
        icon={Target}
        title="Hedef yok"
        hint="Hedefler kurulumun 6. aşamasında araştırma bulgularından önerilir."
      />
    );
  }

  return (
    <div className="space-y-6">
      {GOAL_GROUPS.map((group) => {
        const groupGoals = goals.filter((g) =>
          group.statuses.includes(g.status),
        );
        if (groupGoals.length === 0) return null;
        return (
          <div key={group.label} className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {group.label}
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {groupGoals.map((goal) => (
                <Card key={goal.id} size="sm">
                  <CardContent className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={entityHref(projectId, {
                            kind: "goal",
                            id: goal.id,
                          })}
                          className="text-sm font-medium underline-offset-2 hover:underline"
                        >
                          {goal.title}
                        </Link>
                        {goal.description ? (
                          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                            {goal.description}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span
                          className={cn(
                            "flex h-5 items-center rounded-md px-1.5 text-[10px] font-semibold tabular-nums",
                            goal.priority <= 2
                              ? "bg-primary/15 text-primary"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          P{goal.priority}
                        </span>
                        <StatusBadge meta={PROJECT_GOAL_STATUS[goal.status]} />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {goal.metricKey ? <span>{goal.metricKey}</span> : null}
                      {goal.targetValue !== null ? (
                        <span className="tabular-nums">
                          Hedef: {goal.targetValue}
                          {goal.currentValue !== null
                            ? ` · Mevcut: ${goal.currentValue}`
                            : ""}
                        </span>
                      ) : null}
                      {goal.isMock ? (
                        <StatusBadge
                          meta={{ label: "Demo", tone: "special" }}
                          className="h-4 px-1.5 text-[10px]"
                        />
                      ) : null}
                    </div>

                    <div className="flex items-center justify-end gap-1.5">
                      <GoalEditDialog
                        projectId={projectId}
                        goal={{
                          id: goal.id,
                          title: goal.title,
                          description: goal.description,
                          priority: goal.priority,
                          targetValue: goal.targetValue,
                        }}
                        action={updateGoalAction}
                      />
                      {goal.status === "PROPOSED" ? (
                        <>
                          <ActionForm
                            action={rejectGoalAction}
                            successMessage="Hedef reddedildi"
                          >
                            <input
                              type="hidden"
                              name="projectId"
                              value={projectId}
                            />
                            <input
                              type="hidden"
                              name="goalId"
                              value={goal.id}
                            />
                            <SubmitButton variant="outline" size="xs">
                              Reddet
                            </SubmitButton>
                          </ActionForm>
                          <ActionForm
                            action={approveGoalAction}
                            successMessage="Hedef onaylandı"
                          >
                            <input
                              type="hidden"
                              name="projectId"
                              value={projectId}
                            />
                            <input
                              type="hidden"
                              name="goalId"
                              value={goal.id}
                            />
                            <SubmitButton size="xs">Onayla</SubmitButton>
                          </ActionForm>
                        </>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

async function GoalDetail({
  projectId,
  goalId,
}: {
  projectId: string;
  goalId: string;
}) {
  const goal = await prisma.projectGoal.findFirst({
    where: { id: goalId, projectId },
  });

  if (!goal) {
    return (
      <div className="space-y-4">
        <BackToList projectId={projectId} />
        <EmptyState
          icon={Target}
          title="Hedef bulunamadı"
          hint="Bu kayıt silinmiş olabilir."
        />
      </div>
    );
  }

  const [sourceInsights, approvedByUser] = await Promise.all([
    goal.sourceInsightIds.length
      ? prisma.insight.findMany({
          where: { id: { in: goal.sourceInsightIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    goal.approvedByUserId
      ? prisma.user.findUnique({
          where: { id: goal.approvedByUserId },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve(null),
  ]);

  const fields: FieldSpec[] = [
    { type: "text", label: "Metrik anahtarı", value: goal.metricKey },
    { type: "text", label: "Hedef değer", value: goal.targetValue },
    { type: "text", label: "Mevcut değer", value: goal.currentValue },
    { type: "text", label: "Öncelik", value: goal.priority },
    { type: "boolean", label: "Demo verisi", value: goal.isMock },
    {
      type: "text",
      label: "Onaylayan tipi",
      value: goal.approvedByType ? ACTOR_TYPE_LABEL[goal.approvedByType] : null,
    },
    {
      type: "text",
      label: "Onaylayan kullanıcı",
      value: approvedByUser
        ? (approvedByUser.name ?? approvedByUser.email ?? approvedByUser.id)
        : null,
    },
    {
      type: "date",
      label: "Oluşturulma",
      value: goal.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Güncellenme",
      value: goal.updatedAt,
      relative: true,
    },
    {
      type: "node",
      label: "Kaynak içgörüler",
      node:
        sourceInsights.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {sourceInsights.map((i) => (
              <CrossLinkChip
                key={i.id}
                projectId={projectId}
                entity={{ kind: "insight", id: i.id }}
                text={i.title}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <BackToList projectId={projectId} />
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-heading text-lg font-semibold">{goal.title}</p>
              {goal.description ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {goal.description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span
                className={cn(
                  "flex h-5 items-center rounded-md px-1.5 text-[10px] font-semibold tabular-nums",
                  goal.priority <= 2
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                P{goal.priority}
              </span>
              <StatusBadge meta={PROJECT_GOAL_STATUS[goal.status]} />
            </div>
          </div>

          <FieldGrid fields={fields} />

          <div className="flex items-center justify-end gap-1.5">
            <GoalEditDialog
              projectId={projectId}
              goal={{
                id: goal.id,
                title: goal.title,
                description: goal.description,
                priority: goal.priority,
                targetValue: goal.targetValue,
              }}
              action={updateGoalAction}
            />
            {goal.status === "PROPOSED" ? (
              <>
                <ActionForm
                  action={rejectGoalAction}
                  successMessage="Hedef reddedildi"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="goalId" value={goal.id} />
                  <SubmitButton variant="outline" size="xs">
                    Reddet
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={approveGoalAction}
                  successMessage="Hedef onaylandı"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="goalId" value={goal.id} />
                  <SubmitButton size="xs">Onayla</SubmitButton>
                </ActionForm>
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
