"use client";

import Link from "next/link";
import type { MeasurementPlanStatus } from "@prisma/client";

import { timeAgo } from "@/lib/dates";
import {
  MEASUREMENT_PLAN_BOARD_COLUMNS,
  MEASUREMENT_PLAN_STATUS,
} from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { buildHubHref } from "../hub-core-params";

// Work → Measurements kanban — same system, no filter chip (the one meaningful
// axis is already the column: status). The card carries check progress
// (done/total).
export type MeasurementPlanBoardItem = {
  id: string;
  description: string;
  status: MeasurementPlanStatus;
  doneChecks: number;
  totalChecks: number;
  createdAt: string;
};

export function MeasurementPlanBoard({
  projectId,
  plans,
}: {
  projectId: string;
  plans: MeasurementPlanBoardItem[];
}) {
  return (
    <div className="flex h-full min-h-0 gap-4 overflow-x-auto overflow-y-hidden no-scrollbar">
      {MEASUREMENT_PLAN_BOARD_COLUMNS.map((column) => {
        const columnPlans = plans.filter((plan) =>
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
              {columnPlans.map((plan) => (
                <Link
                  key={plan.id}
                  href={buildHubHref(projectId, {
                    panel: "work",
                    sub: "measurements",
                    entity: { kind: "measurementPlan", id: plan.id },
                  })}
                  scroll={false}
                  className="block rounded-lg bg-card p-3 shadow-xs ring-1 ring-border transition-colors hover:bg-muted/40"
                >
                  <p className="line-clamp-2 text-xs leading-snug font-medium">
                    {plan.description}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <StatusBadge
                      meta={MEASUREMENT_PLAN_STATUS[plan.status]}
                      className="h-4 px-1.5 text-[10px]"
                    />
                    {plan.totalChecks > 0 ? (
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {plan.doneChecks}/{plan.totalChecks} checks
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    {timeAgo(plan.createdAt)}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
