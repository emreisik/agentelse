"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";

import { CardTitle } from "@/components/workspace/card-title";
import { formatMetric } from "@/lib/module-flows/analytics/format";
import { changePercent } from "@/lib/website-analytics/periods";
import type { SearchOverview } from "@/server/seo/overview";

// Sağ dokun Brand sekmesindeki "Search" kartı (SC-F2): son 28 kesin günün
// (marka dışı) tıklamaları, önceki 28 güne göre değişim, küçük trend ve
// bağlantı sağlığı. Ambardan okunur, sayfa çizildikten sonra kendi ucundan;
// ambar kapalıysa ya da senkron başlamadıysa kart görünmez. Sunucu kartı
// yalnız GSC_SYNC açıkken yerleştirir.

const CARD_CLASS = "rounded-xl border p-3.5";
const CARD_STYLE = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
} as const;

export type SearchOverviewState =
  { status: "loading" } | { status: "done"; overview: SearchOverview };

function useSearchOverview(projectId: string): SearchOverviewState {
  const [state, setState] = useState<SearchOverviewState>({
    status: "loading",
  });
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/search/overview`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState({
          status: "done",
          overview: (await res.json()) as SearchOverview,
        });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: "done", overview: { ok: false, reason: "off" } });
      }
    })();
    return () => controller.abort();
  }, [projectId]);
  return state;
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = (SPARK_WIDTH - 2) / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = 1 + index * step;
      const y = SPARK_HEIGHT - 1 - (value / max) * (SPARK_HEIGHT - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className="h-7 w-24 shrink-0"
      aria-hidden
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--ws-text-2)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function SearchOverviewCard({ projectId }: { projectId: string }) {
  return (
    <SearchOverviewView
      projectId={projectId}
      state={useSearchOverview(projectId)}
    />
  );
}

// projectId imza uyumu için (AdsOverviewView ile aynı); "Open" bağlantısı
// sunucunun verdiği pageHref'ten gelir (GSC_SEARCH_PAGE kapalıyken yok).
export function SearchOverviewView({
  state,
}: {
  projectId: string;
  state: SearchOverviewState;
}) {
  if (state.status === "loading" || !state.overview.ok) return null;
  const overview = state.overview;
  const nonBrand = overview.nonBrandClicks !== null;
  const value = nonBrand ? overview.nonBrandClicks : overview.clicks;
  const previous = nonBrand
    ? overview.previousNonBrandClicks
    : overview.previousClicks;
  const change = changePercent(value, previous);
  const unhealthy = overview.health !== "OK" && overview.health !== "UNKNOWN";
  return (
    <section
      aria-label="Search"
      data-card="search-overview"
      className={CARD_CLASS}
      style={CARD_STYLE}
    >
      <CardTitle
        icon={<Search className="size-4" aria-hidden />}
        aside={
          overview.pageHref ? (
            <Link
              href={overview.pageHref}
              className="text-[11px] underline-offset-2 hover:underline"
              style={{ color: "var(--ws-text-2)" }}
            >
              Open
            </Link>
          ) : null
        }
      >
        <span className="inline-flex items-center gap-1.5">
          Search
          {unhealthy ? (
            <span
              className="inline-block size-1.5 rounded-full bg-amber-500"
              role="img"
              aria-label="Search Console needs attention"
              title="Search Console needs attention"
            />
          ) : null}
        </span>
      </CardTitle>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-semibold tabular-nums"
            style={{ color: "var(--ws-text)" }}
          >
            {formatMetric("count", value ?? 0, null, { compact: true })}
          </p>
          <p
            className="truncate text-[10px]"
            style={{ color: "var(--ws-text-3)" }}
          >
            {nonBrand ? "Non-brand clicks" : "Clicks"}, 28 days
          </p>
          <p
            className="mt-0.5 truncate text-[11px] tabular-nums"
            style={{ color: "var(--ws-text-2)" }}
            data-change={change === null ? "none" : change >= 0 ? "up" : "down"}
          >
            {change === null
              ? "No comparison"
              : `${change >= 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(1)}% vs previous 28 days`}
          </p>
        </div>
        <Sparkline values={overview.trend} />
      </div>
      <p
        className="mt-2.5 text-[11px] leading-snug"
        style={{ color: "var(--ws-text-3)" }}
      >
        Final data through {dayLabel(overview.finalThrough)} · Pacific Time
        {overview.isMock ? " · Sample data" : ""}
      </p>
    </section>
  );
}
