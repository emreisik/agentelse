"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  CouncilRecommendation,
  CouncilType,
  CreativeLens,
  DepartmentKey,
  IdeaStatus,
} from "@prisma/client";

import { cn } from "@/lib/utils";
import {
  COUNCIL_RECOMMENDATION,
  COUNCIL_TYPE,
  CREATIVE_LENS,
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  IDEA_BOARD_COLUMNS,
  IDEA_STATUS,
} from "@/lib/labels";
import { StatusBadge } from "@/components/shared/status-badge";
import { NbaScoreChip } from "@/components/shared/nba-score-chip";
import { entityHref } from "../hub-core-params";

// The kanban grid ends up cramped at panel width (min 440px side panel) —
// so within HUB CORE we show status columns as vertical groups instead.
// The lens filter stays client-side: the `sub` schema in hub-core-params.ts
// is only defined for the work/settings panels (DO NOT TOUCH), there's no
// field that round-trips through the URL for the ideas panel — so the
// filter state is kept here.
export type IdeaBoardItem = {
  id: string;
  title: string;
  lens: CreativeLens | null;
  status: IdeaStatus;
  nbaScore: number | null;
  isMock: boolean;
  // The first department in concept.departmentsInvolved — shown as a color
  // stripe on the card edge for quick visual scanning (see
  // DEPARTMENT_COLOR). An idea can span multiple departments; the detail
  // view lists all of them as badges, the card here only carries the
  // primary one.
  department?: DepartmentKey;
  councilDots: Array<{
    id: string;
    councilType: CouncilType;
    recommendation: CouncilRecommendation;
  }>;
};

export function IdeaLensBoard({
  projectId,
  ideas,
  usedLenses,
}: {
  projectId: string;
  ideas: IdeaBoardItem[];
  usedLenses: Array<{ lens: CreativeLens; count: number }>;
}) {
  const [lensFilter, setLensFilter] = useState<CreativeLens | null>(null);
  const filtered = lensFilter
    ? ideas.filter((idea) => idea.lens === lensFilter)
    : ideas;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {usedLenses.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setLensFilter(null)}
            className={cn(
              "flex h-6 items-center rounded-4xl px-2.5 text-xs font-medium transition-colors",
              !lensFilter
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:bg-accent",
            )}
          >
            All lenses
          </button>
          {usedLenses.map(({ lens, count }) => {
            const meta = CREATIVE_LENS[lens];
            const Icon = meta.icon;
            const active = lensFilter === lens;
            return (
              <button
                key={lens}
                type="button"
                onClick={() => setLensFilter(lens)}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-4xl px-2.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:bg-accent",
                )}
              >
                {Icon ? <Icon className="size-3" /> : null}
                {meta.label}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="no-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto pb-2">
        {IDEA_BOARD_COLUMNS.map((column) => {
          const columnIdeas = filtered.filter((idea) =>
            column.statuses.includes(idea.status),
          );
          if (columnIdeas.length === 0) return null;
          return (
            <section key={column.key}>
              <div className="mb-1.5 flex items-baseline gap-1.5 border-b border-border/60 px-1 pb-1.5">
                <h3 className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
                  {column.label}
                </h3>
                <span className="text-[11px] font-normal text-muted-foreground/65 tabular-nums">
                  {columnIdeas.length}
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5">
                {columnIdeas.map((idea) => {
                  const lensMeta = idea.lens ? CREATIVE_LENS[idea.lens] : null;
                  const deptColor = idea.department
                    ? DEPARTMENT_COLOR[idea.department]
                    : undefined;
                  return (
                    <Link
                      key={idea.id}
                      href={entityHref(
                        projectId,
                        { kind: "idea", id: idea.id },
                        undefined,
                      )}
                      scroll={false}
                      title={lensMeta ? `${lensMeta.label} lens` : undefined}
                      className="block h-full rounded-md border-l-[3px] bg-card px-2.5 py-1.5 shadow-xs ring-1 ring-border transition-colors hover:bg-muted/40"
                      style={{ borderLeftColor: deptColor ?? "transparent" }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="line-clamp-2 min-w-0 text-xs leading-snug font-medium">
                          {idea.title}
                        </p>
                        {idea.isMock ? (
                          <StatusBadge
                            meta={{ label: "Demo", tone: "special" }}
                            className="h-4 shrink-0 px-1.5 text-[10px]"
                          />
                        ) : null}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <StatusBadge
                          meta={IDEA_STATUS[idea.status]}
                          className="h-4 shrink-0 px-1.5 text-[10px]"
                        />
                        {idea.department ? (
                          <span
                            className="min-w-0 truncate text-[10px] font-semibold"
                            style={{ color: deptColor }}
                            title={DEPARTMENT_KEY[idea.department].label}
                          >
                            {DEPARTMENT_KEY[idea.department].label.replace(
                              / Team$/,
                              "",
                            )}
                          </span>
                        ) : null}
                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          {idea.councilDots.map((evaluation) => (
                            <span
                              key={evaluation.id}
                              title={`${COUNCIL_TYPE[evaluation.councilType].label}: ${COUNCIL_RECOMMENDATION[evaluation.recommendation].label}`}
                              className={cn(
                                "size-1.5 rounded-full",
                                evaluation.recommendation ===
                                  "STRONG_APPROVE" ||
                                  evaluation.recommendation === "APPROVE"
                                  ? "bg-success"
                                  : evaluation.recommendation === "REVISE"
                                    ? "bg-warning"
                                    : "bg-destructive",
                              )}
                            />
                          ))}
                          <NbaScoreChip
                            value={idea.nbaScore}
                            className="px-1 py-0 text-[10px]"
                          />
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
