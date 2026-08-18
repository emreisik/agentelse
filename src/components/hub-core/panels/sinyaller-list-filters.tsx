"use client";

// Sinyaller paneli için client-side liste+filtre bileşenleri. HUB CORE'un
// tek query-param sözleşmesinde (`hub-core-params.ts`) bu panel için bir
// `sub` alt-sekmesi tanımlı değil — yani kategori/durum/sınıflandırma
// filtreleri URL üzerinden değil, burada lokal state ile çalışır. Liste
// zaten sunucu tarafında (createdAt'e göre, sınırlı sayıda) çekiliyor; bu
// bileşenler sadece o listeyi filtreleyip render ediyor.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Library, RadioTower } from "lucide-react";
import type {
  FactClassification,
  FindingSourceType,
  SignalCategory,
  SignalStatus,
} from "@prisma/client";

import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import {
  FACT_CLASSIFICATION,
  FINDING_SOURCE_TYPE,
  SIGNAL_CATEGORY,
  SIGNAL_STATUS,
} from "@/lib/labels";
import { EmptyState } from "@/components/shared/empty-state";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { entityHref } from "../hub-core-params";

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1 rounded-4xl px-2.5 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

export type SignalListItem = {
  id: string;
  title: string;
  summary: string | null;
  category: SignalCategory;
  status: SignalStatus;
  source: string;
  relevanceScore: number | null;
  createdAt: Date;
};

export function SignalList({
  projectId,
  signals,
}: {
  projectId: string;
  signals: SignalListItem[];
}) {
  const [status, setStatus] = useState<SignalStatus | null>(null);
  const [category, setCategory] = useState<SignalCategory | null>(null);

  const statusCounts = useMemo(() => {
    const map = new Map<SignalStatus, number>();
    for (const s of signals) map.set(s.status, (map.get(s.status) ?? 0) + 1);
    return map;
  }, [signals]);

  const filtered = signals.filter(
    (s) =>
      (!status || s.status === status) &&
      (!category || s.category === category),
  );

  if (signals.length === 0) {
    return (
      <EmptyState
        icon={RadioTower}
        title="Sinyal yok"
        hint="Proje aktive olduktan sonra sinyal profili taramaları dış dünyadan sinyal toplamaya başlar."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={!status} onClick={() => setStatus(null)}>
          Tümü
        </FilterChip>
        {(Object.keys(SIGNAL_STATUS) as SignalStatus[]).map((s) => (
          <FilterChip
            key={s}
            active={status === s}
            onClick={() => setStatus((prev) => (prev === s ? null : s))}
          >
            {SIGNAL_STATUS[s].label}
            <span className="tabular-nums opacity-70">
              {statusCounts.get(s) ?? 0}
            </span>
          </FilterChip>
        ))}
        <span className="mx-1 h-4 w-px bg-foreground/10" />
        {category ? (
          <FilterChip active onClick={() => setCategory(null)}>
            {SIGNAL_CATEGORY[category].label} ×
          </FilterChip>
        ) : (
          <span className="text-xs text-muted-foreground">
            Kategoriye göre filtrelemek için karttaki kategoriye tıklayın
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Bu filtreyle eşleşen sinyal yok.
        </p>
      ) : (
        <Card>
          <CardContent className="divide-y divide-foreground/5">
            {filtered.map((signal) => {
              const categoryMeta = SIGNAL_CATEGORY[signal.category];
              const CategoryIcon = categoryMeta.icon;
              return (
                <div key={signal.id} className="flex items-start gap-3 py-2.5">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                    {CategoryIcon ? (
                      <CategoryIcon className="size-4" />
                    ) : (
                      <RadioTower className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={entityHref(
                        projectId,
                        { kind: "signal", id: signal.id },
                        undefined,
                      )}
                      className="text-sm font-medium underline-offset-2 hover:underline"
                    >
                      {signal.title}
                    </Link>
                    {signal.summary ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {signal.summary}
                      </p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <button
                        type="button"
                        onClick={() =>
                          setCategory((prev) =>
                            prev === signal.category ? null : signal.category,
                          )
                        }
                      >
                        <StatusBadge
                          meta={categoryMeta}
                          className="h-4 px-1.5 text-[10px]"
                        />
                      </button>
                      <StatusBadge
                        meta={SIGNAL_STATUS[signal.status]}
                        className="h-4 px-1.5 text-[10px]"
                      />
                      <span>{signal.source}</span>
                      <span>{timeAgo(signal.createdAt)}</span>
                    </div>
                  </div>
                  {signal.relevanceScore !== null ? (
                    <div className="w-20 shrink-0">
                      <ScoreBar value={signal.relevanceScore} label="ilgi" />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export type FindingListItem = {
  id: string;
  statement: string;
  classification: FactClassification;
  sourceType: FindingSourceType;
  category: string | null;
  confidence: number | null;
  evidenceId: string | null;
  createdAt: Date;
};

export function FindingList({
  projectId,
  findings,
}: {
  projectId: string;
  findings: FindingListItem[];
}) {
  const [classification, setClassification] =
    useState<FactClassification | null>(null);

  const counts = useMemo(() => {
    const map = new Map<FactClassification, number>();
    for (const f of findings)
      map.set(f.classification, (map.get(f.classification) ?? 0) + 1);
    return map;
  }, [findings]);

  const filtered = findings.filter(
    (f) => !classification || f.classification === classification,
  );

  if (findings.length === 0) {
    return (
      <EmptyState
        icon={Library}
        title="Bulgu yok"
        hint="Araştırma görevleri tamamlandıkça bulgular burada birikir."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <FilterChip
          active={!classification}
          onClick={() => setClassification(null)}
        >
          Tümü
        </FilterChip>
        {(Object.keys(FACT_CLASSIFICATION) as FactClassification[]).map(
          (cls) => (
            <FilterChip
              key={cls}
              active={classification === cls}
              onClick={() =>
                setClassification((prev) => (prev === cls ? null : cls))
              }
            >
              {FACT_CLASSIFICATION[cls].label}
              <span className="tabular-nums opacity-70">
                {counts.get(cls) ?? 0}
              </span>
            </FilterChip>
          ),
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Bu filtreyle eşleşen bulgu yok.
        </p>
      ) : (
        <Card>
          <CardContent className="divide-y divide-foreground/5">
            {filtered.map((finding) => (
              <Link
                key={finding.id}
                href={entityHref(
                  projectId,
                  { kind: "finding", id: finding.id },
                  undefined,
                )}
                className="flex items-start gap-3 py-2.5 transition-colors hover:bg-accent/30"
              >
                <StatusBadge
                  meta={FACT_CLASSIFICATION[finding.classification]}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm">{finding.statement}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <StatusBadge
                      meta={FINDING_SOURCE_TYPE[finding.sourceType]}
                      className="h-4 px-1.5 text-[10px]"
                    />
                    {finding.category ? <span>{finding.category}</span> : null}
                    {finding.evidenceId ? (
                      <span className="text-success">kanıtlı</span>
                    ) : null}
                    <span>{timeAgo(finding.createdAt)}</span>
                  </div>
                </div>
                {finding.confidence !== null ? (
                  <div className="w-20 shrink-0">
                    <ScoreBar value={finding.confidence} label="güven" />
                  </div>
                ) : null}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
