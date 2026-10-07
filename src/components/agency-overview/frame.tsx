import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

// Ajans genel bakış sayfalarının ortak çerçevesi (/search ve /websites):
// başlık, özet kutuları, süzgeç bağlantıları ve içerik. Genel kalır: içinde
// Search Console ya da Analytics'e ait bir söz yok.

export type AgencySummaryTile = { label: string; value: string; hint?: string };

export type AgencyFilterLink = {
  key: string;
  label: string;
  count: number;
  href: string;
  active: boolean;
};

export function AgencyOverviewFrame({
  title,
  subtitle,
  summary,
  filters,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  summary: AgencySummaryTile[];
  filters: AgencyFilterLink[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>

      {summary.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]">
          {summary.map((tile) => (
            <Card key={tile.label} size="sm" data-tile={tile.label}>
              <div className="space-y-0.5 px-(--card-spacing)">
                <p className="text-xs text-muted-foreground">{tile.label}</p>
                <p className="font-heading text-xl font-semibold tabular-nums">
                  {tile.value}
                </p>
                {tile.hint ? (
                  <p className="text-xs text-muted-foreground">{tile.hint}</p>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {filters.length > 0 ? (
        <nav aria-label="Filters" className="flex flex-wrap gap-2">
          {filters.map((filter) => (
            <Link
              key={filter.key}
              href={filter.href}
              aria-current={filter.active ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
                filter.active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground hover:bg-muted/70",
              )}
            >
              {filter.label}
              <span
                className={cn(
                  "text-xs tabular-nums",
                  filter.active
                    ? "text-primary-foreground/80"
                    : "text-muted-foreground",
                )}
              >
                {filter.count}
              </span>
            </Link>
          ))}
        </nav>
      ) : null}

      {children}
    </div>
  );
}

const DOT_TONE = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/40",
} as const;

export function StatusDot({
  tone,
  label,
}: {
  tone: keyof typeof DOT_TONE;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        aria-hidden
        data-tone={tone}
        className={cn("size-2 shrink-0 rounded-full", DOT_TONE[tone])}
      />
      {label}
    </span>
  );
}
