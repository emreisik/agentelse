"use client";

import { useState } from "react";
import Link from "next/link";
import type { DepartmentKey, TaskPriority, TaskStatus } from "@prisma/client";

import { cn } from "@/lib/utils";
import {
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  TASK_BOARD_COLUMNS,
  TASK_PRIORITY,
  TASK_STATUS,
  capabilityLabel,
} from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { buildHubHref } from "../hub-core-params";

// Fikirler panosunun (idea-lens-board.tsx) İşler karşılığı — bilinçli olarak
// birebir aynı sistem: aynı sütun/kart iskeleti, aynı yatay+dikey kaydırma
// deseni, aynı "filtre çipleri + dolu departman etiketi" görsel dili. Tek
// fark filtre ekseni: fikirlerde mercek (lens), burada departman — Task
// modelinde departmentKey doğrudan bir alan olduğu için bu daha doğal.
export type TaskBoardItem = {
  id: string;
  title: string;
  capability: string;
  status: TaskStatus;
  priority: TaskPriority;
  department: DepartmentKey | null;
};

const departmentPillClasses =
  "inline-flex w-fit items-center rounded-sm px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase text-[var(--dept-badge-foreground)]";

export function TaskDepartmentBoard({
  projectId,
  tasks,
  usedDepartments,
}: {
  projectId: string;
  tasks: TaskBoardItem[];
  usedDepartments: Array<{ department: DepartmentKey; count: number }>;
}) {
  const [departmentFilter, setDepartmentFilter] =
    useState<DepartmentKey | null>(null);
  const filtered = departmentFilter
    ? tasks.filter((task) => task.department === departmentFilter)
    : tasks;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {usedDepartments.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setDepartmentFilter(null)}
            className={cn(
              "flex h-6 items-center rounded-4xl px-2.5 text-xs font-medium transition-colors",
              !departmentFilter
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:bg-accent",
            )}
          >
            Tüm departmanlar
          </button>
          {usedDepartments.map(({ department, count }) => {
            const meta = DEPARTMENT_KEY[department];
            const Icon = meta.icon;
            const active = departmentFilter === department;
            return (
              <button
                key={department}
                type="button"
                onClick={() => setDepartmentFilter(department)}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-4xl px-2.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:bg-accent",
                )}
              >
                {Icon ? <Icon className="size-3" /> : null}
                {meta.label.replace(/ Team$/, "")}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto overflow-y-hidden no-scrollbar">
        {TASK_BOARD_COLUMNS.map((column) => {
          const columnTasks = filtered.filter((task) =>
            column.statuses.includes(task.status),
          );
          if (columnTasks.length === 0) return null;
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
                  {columnTasks.length}
                </span>
              </div>
              <div className="flex-1 min-h-0 space-y-2 overflow-y-auto px-3 py-2">
                {columnTasks.map((task) => (
                  <Link
                    key={task.id}
                    href={buildHubHref(projectId, {
                      panel: "isler",
                      sub: "gorevler",
                      entity: { kind: "task", id: task.id },
                    })}
                    scroll={false}
                    className="block rounded-lg bg-card p-3 shadow-xs ring-1 ring-border transition-colors hover:bg-muted/40"
                  >
                    <p className="line-clamp-2 min-w-0 text-xs leading-snug font-medium">
                      {task.title}
                    </p>
                    <p className="mt-1 truncate text-[10px] text-muted-foreground">
                      {capabilityLabel(task.capability)}
                    </p>
                    {task.department ? (
                      <span
                        className={cn(departmentPillClasses, "mt-1.5")}
                        style={{
                          backgroundColor: DEPARTMENT_COLOR[task.department],
                        }}
                        title={DEPARTMENT_KEY[task.department].label}
                      >
                        {DEPARTMENT_KEY[task.department].label.replace(
                          / Team$/,
                          "",
                        )}
                      </span>
                    ) : null}
                    <div className="mt-2 flex items-center gap-1">
                      <StatusBadge
                        meta={TASK_PRIORITY[task.priority]}
                        className="h-4 px-1.5 text-[10px]"
                      />
                      <StatusBadge
                        meta={TASK_STATUS[task.status]}
                        className="h-4 px-1.5 text-[10px]"
                      />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
