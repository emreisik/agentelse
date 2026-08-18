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

// Kanban ızgarası panel genişliğinde (min 440px yan panel) sıkışık kalıyor —
// bu yüzden HUB CORE içinde durum sütunlarını dikey gruplarla gösteriyoruz.
// Mercek filtresi client-side kalıyor: hub-core-params.ts'in `sub` şeması
// yalnızca isler/ayarlar panelleri için tanımlı (DOKUNMA), fikirler paneli
// için URL'de round-trip eden bir alan yok — bu yüzden filtre state'i burada
// tutuluyor.
export type IdeaBoardItem = {
  id: string;
  title: string;
  lens: CreativeLens | null;
  status: IdeaStatus;
  nbaScore: number | null;
  isMock: boolean;
  // Concept.departmentsInvolved'daki ilk departman — hızlı görsel tarama
  // için kart kenarında bir renk şeridi olarak gösterilir (bkz.
  // DEPARTMENT_COLOR). Fikir birden fazla departmanı kapsayabilir; detay
  // görünümü hepsini badge olarak listeler, kart burada sadece birincili
  // taşır.
  department?: DepartmentKey;
  councilDots: Array<{
    id: string;
    councilType: CouncilType;
    recommendation: CouncilRecommendation;
  }>;
};

// Departman rengi artık kart kenarında şerit değil, başlığın altında dolu
// (solid) bir etiket olarak taşınıyor — Jira panosundaki kategori
// etiketlerine benzer tek güçlü renk vurgusu için.
const departmentPillClasses =
  "inline-flex w-fit items-center rounded-sm px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase text-[var(--dept-badge-foreground)]";

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
    <div className="flex h-full min-h-0 flex-col gap-4">
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
            Tüm mercekler
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

      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto overflow-y-hidden no-scrollbar">
        {IDEA_BOARD_COLUMNS.map((column) => {
          const columnIdeas = filtered.filter((idea) =>
            column.statuses.includes(idea.status),
          );
          if (columnIdeas.length === 0) return null;
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
                  {columnIdeas.length}
                </span>
              </div>
              <div className="flex-1 min-h-0 space-y-2 overflow-y-auto px-3 py-2">
                {columnIdeas.map((idea) => {
                  const lensMeta = idea.lens ? CREATIVE_LENS[idea.lens] : null;
                  return (
                    <Link
                      key={idea.id}
                      href={entityHref(
                        projectId,
                        { kind: "idea", id: idea.id },
                        undefined,
                      )}
                      scroll={false}
                      className="block rounded-lg bg-card p-3 shadow-xs ring-1 ring-border transition-colors hover:bg-muted/40"
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
                      {idea.department ? (
                        <span
                          className={cn(departmentPillClasses, "mt-1.5")}
                          style={{
                            backgroundColor: DEPARTMENT_COLOR[idea.department],
                          }}
                          title={DEPARTMENT_KEY[idea.department].label}
                        >
                          {DEPARTMENT_KEY[idea.department].label.replace(
                            / Team$/,
                            "",
                          )}
                        </span>
                      ) : null}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          {lensMeta ? (
                            <StatusBadge
                              meta={lensMeta}
                              className="h-4 px-1.5 text-[10px]"
                              showIcon
                            />
                          ) : null}
                          <StatusBadge
                            meta={IDEA_STATUS[idea.status]}
                            className="h-4 px-1.5 text-[10px]"
                          />
                        </div>
                        <div className="flex items-center gap-1">
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
