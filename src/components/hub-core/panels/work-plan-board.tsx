"use client";

import { useState } from "react";
import Link from "next/link";
import type { WorkPlanStatus, WorkPlanType } from "@prisma/client";

import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import {
  WORK_PLAN_BOARD_COLUMNS,
  WORK_PLAN_STATUS,
  WORK_PLAN_TYPE,
} from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { Progress } from "@/components/ui/progress";
import { buildHubHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";

// Work → Plans kanban — the exact same system as task-department-board.tsx,
// the filter axis here is plan type (WorkPlanType).
export type WorkPlanBoardItem = {
  id: string;
  title: string;
  planType: WorkPlanType;
  status: WorkPlanStatus;
  isMock: boolean;
  doneTasks: number;
  totalTasks: number;
  goals: Array<{ id: string; title: string }>;
  ideaId: string | null;
  createdAt: string;
};

export function WorkPlanBoard({
  projectId,
  plans,
  usedTypes,
}: {
  projectId: string;
  plans: WorkPlanBoardItem[];
  usedTypes: Array<{ planType: WorkPlanType; count: number }>;
}) {
  const [typeFilter, setTypeFilter] = useState<WorkPlanType | null>(null);
  const filtered = typeFilter
    ? plans.filter((plan) => plan.planType === typeFilter)
    : plans;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {usedTypes.length > 1 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setTypeFilter(null)}
            className={cn(
              "flex h-6 items-center rounded-4xl px-2.5 text-xs font-medium transition-colors",
              !typeFilter
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:bg-accent",
            )}
          >
            All types
          </button>
          {usedTypes.map(({ planType, count }) => {
            const active = typeFilter === planType;
            return (
              <button
                key={planType}
                type="button"
                onClick={() => setTypeFilter(planType)}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-4xl px-2.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:bg-accent",
                )}
              >
                {WORK_PLAN_TYPE[planType].label}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto overflow-y-hidden no-scrollbar">
        {WORK_PLAN_BOARD_COLUMNS.map((column) => {
          const columnPlans = filtered.filter((plan) =>
            column.statuses.includes(plan.status),
          );
          if (columnPlans.length === 0) return null;
          return (
            <div
              key={column.key}
              className="flex h-full min-h-0 min-w-64 flex-1 flex-col overflow-hidden"
            >
              <div className="flex shrink-0 items-baseline gap-1.5 px-1 pb-2.5">
                <h3 className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
                  {column.label}
                </h3>
                <span className="text-[11px] font-normal text-muted-foreground/65 tabular-nums">
                  {columnPlans.length}
                </span>
              </div>
              <div className="flex-1 min-h-0 space-y-2 overflow-y-auto px-3 py-2">
                {columnPlans.map((plan) => {
                  const progress =
                    plan.totalTasks > 0
                      ? (plan.doneTasks / plan.totalTasks) * 100
                      : 0;
                  return (
                    <Link
                      key={plan.id}
                      href={buildHubHref(projectId, {
                        panel: "work",
                        sub: "plans",
                        entity: { kind: "workPlan", id: plan.id },
                      })}
                      scroll={false}
                      className="block rounded-lg bg-card p-3 shadow-xs ring-1 ring-border transition-colors hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="line-clamp-2 min-w-0 text-xs leading-snug font-medium">
                          {plan.title}
                        </p>
                        {plan.isMock ? (
                          <StatusBadge
                            meta={{ label: "Demo", tone: "special" }}
                            className="h-4 shrink-0 px-1.5 text-[10px]"
                          />
                        ) : null}
                      </div>
                      {plan.totalTasks > 0 ? (
                        <div className="mt-2 flex items-center gap-2">
                          <Progress value={progress} className="h-1 flex-1" />
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {plan.doneTasks}/{plan.totalTasks}
                          </span>
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <StatusBadge
                          meta={WORK_PLAN_TYPE[plan.planType]}
                          className="h-4 px-1.5 text-[10px]"
                        />
                        <StatusBadge
                          meta={WORK_PLAN_STATUS[plan.status]}
                          className="h-4 px-1.5 text-[10px]"
                        />
                        {plan.goals.map((goal) => (
                          <CrossLinkChip
                            key={goal.id}
                            projectId={projectId}
                            entity={{ kind: "goal", id: goal.id }}
                            text={goal.title}
                            className="h-4 px-1.5 text-[10px]"
                          />
                        ))}
                        {plan.ideaId ? (
                          <CrossLinkChip
                            projectId={projectId}
                            entity={{ kind: "idea", id: plan.ideaId }}
                            text="Source idea"
                            className="h-4 px-1.5 text-[10px]"
                          />
                        ) : null}
                      </div>
                      <p className="mt-1.5 text-[10px] text-muted-foreground">
                        {timeAgo(plan.createdAt)}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
