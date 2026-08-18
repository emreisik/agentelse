"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { DepartmentKey, WorkHandoffStatus } from "@prisma/client";

import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import {
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  WORK_HANDOFF_BOARD_COLUMNS,
  WORK_HANDOFF_STATUS,
} from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { buildHubHref } from "../hub-core-params";

// İşler → Devirler kanban'ı — aynı sistem, filtre ekseni kaynak departman
// (fromDepartment). Kart, HandoffCard'daki (isler-panel.tsx) departman
// akış ikonlarını kompakt biçimde taşır.
export type WorkHandoffBoardItem = {
  id: string;
  fromDepartment: DepartmentKey;
  toDepartment: DepartmentKey;
  status: WorkHandoffStatus;
  reason: string;
  createdAt: string;
};

function DepartmentChip({ department }: { department: DepartmentKey }) {
  const Icon = DEPARTMENT_KEY[department].icon;
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-md"
      style={{
        backgroundColor: `color-mix(in oklch, ${DEPARTMENT_COLOR[department]} 15%, transparent)`,
        color: DEPARTMENT_COLOR[department],
      }}
      title={DEPARTMENT_KEY[department].label}
    >
      {Icon ? <Icon className="size-3" /> : null}
    </span>
  );
}

export function WorkHandoffBoard({
  projectId,
  handoffs,
  usedDepartments,
}: {
  projectId: string;
  handoffs: WorkHandoffBoardItem[];
  usedDepartments: Array<{ department: DepartmentKey; count: number }>;
}) {
  const [departmentFilter, setDepartmentFilter] =
    useState<DepartmentKey | null>(null);
  const filtered = departmentFilter
    ? handoffs.filter((h) => h.fromDepartment === departmentFilter)
    : handoffs;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {usedDepartments.length > 1 ? (
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
        {WORK_HANDOFF_BOARD_COLUMNS.map((column) => {
          const columnHandoffs = filtered.filter((h) =>
            column.statuses.includes(h.status),
          );
          if (columnHandoffs.length === 0) return null;
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
                  {columnHandoffs.length}
                </span>
              </div>
              <div className="flex-1 min-h-0 space-y-2 overflow-y-auto px-3 py-2">
                {columnHandoffs.map((handoff) => (
                  <Link
                    key={handoff.id}
                    href={buildHubHref(projectId, {
                      panel: "isler",
                      sub: "devirler",
                      entity: { kind: "handoff", id: handoff.id },
                    })}
                    scroll={false}
                    className="block rounded-lg bg-card p-3 shadow-xs ring-1 ring-border transition-colors hover:bg-muted/40"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-medium">
                      <DepartmentChip department={handoff.fromDepartment} />
                      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                      <DepartmentChip department={handoff.toDepartment} />
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs leading-snug text-muted-foreground">
                      {handoff.reason}
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <StatusBadge
                        meta={WORK_HANDOFF_STATUS[handoff.status]}
                        className="h-4 px-1.5 text-[10px]"
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {timeAgo(handoff.createdAt)}
                      </span>
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
