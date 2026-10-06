"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Globe } from "lucide-react";

import { CardTitle } from "@/components/workspace/card-title";
import { formatCount } from "@/lib/module-flows/analytics/format";
import type {
  WebsiteHealthTone,
  WebsiteOverview,
} from "@/lib/website-analytics/overview";

// Sağ dokun Brand sekmesindeki "Website" kartı (GA-F2 bölüm 2,
// GA_BRAND_CARD): son 28 tam günün oturumları ve key event'leri, oturum
// trendi ve bağın sağlık noktası. Ambardan okunur, sayfa çizildikten sonra
// kendi ucundan; veri yoksa ya da bayrak kapalıysa kart görünmez.

const CARD_CLASS = "rounded-xl border p-3.5";
const CARD_STYLE = {
  borderColor: "var(--ws-border)",
  background: "var(--ws-surface)",
} as const;

const DOT_CLASS: Record<WebsiteHealthTone, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-rose-500",
  unknown: "bg-muted-foreground",
};

export type WebsiteOverviewState =
  { status: "loading" } | { status: "done"; overview: WebsiteOverview };

function useWebsiteOverview(projectId: string): WebsiteOverviewState {
  const [state, setState] = useState<WebsiteOverviewState>({
    status: "loading",
  });
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/website/overview`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setState({
          status: "done",
          overview: (await res.json()) as WebsiteOverview,
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

export function WebsiteOverviewCard({ projectId }: { projectId: string }) {
  return (
    <WebsiteOverviewView
      projectId={projectId}
      state={useWebsiteOverview(projectId)}
    />
  );
}

// "Oct 5" (gün anahtarı mülk saatinde).
function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

function TrendArrow({
  trend,
  change,
}: {
  trend: "up" | "down" | "flat" | null;
  change: number | null;
}) {
  if (trend === null || change === null) return null;
  const percent = `${Math.round(Math.abs(change))}%`;
  const text =
    trend === "flat"
      ? "about the same as the previous 28 days"
      : `${trend} ${percent} vs previous 28 days`;
  return (
    <span
      className={
        trend === "up"
          ? "text-[11px] text-emerald-600 dark:text-emerald-400"
          : trend === "down"
            ? "text-[11px] text-rose-600 dark:text-rose-400"
            : "text-[11px]"
      }
      style={trend === "flat" ? { color: "var(--ws-text-3)" } : undefined}
    >
      <span aria-hidden>
        {trend === "up" ? "▲" : trend === "down" ? "▼" : "–"}
        {trend === "flat" ? "" : ` ${percent}`}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

export function WebsiteOverviewView({
  projectId,
  state,
}: {
  projectId: string;
  state: WebsiteOverviewState;
}) {
  if (state.status === "loading" || !state.overview.ok) return null;
  const overview = state.overview;
  return (
    <section
      aria-label="Website"
      data-card="website-overview"
      className={CARD_CLASS}
      style={CARD_STYLE}
    >
      <CardTitle
        icon={<Globe className="size-4" aria-hidden />}
        aside={
          <Link
            href={`/projects/${projectId}/site`}
            className="text-[11px] underline-offset-2 hover:underline"
            style={{ color: "var(--ws-text-2)" }}
          >
            Open
          </Link>
        }
      >
        Website
      </CardTitle>
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <dd
            className="flex items-baseline gap-1.5 truncate text-sm font-semibold tabular-nums"
            style={{ color: "var(--ws-text)" }}
          >
            {formatCount(overview.sessions, true)}
            <TrendArrow
              trend={overview.trend}
              change={overview.sessionsChange}
            />
          </dd>
          <dt
            className="truncate text-[10px]"
            style={{ color: "var(--ws-text-3)" }}
          >
            Sessions, 28 days
          </dt>
        </div>
        <div className="min-w-0">
          <dd
            className="truncate text-sm font-semibold tabular-nums"
            style={{ color: "var(--ws-text)" }}
          >
            {formatCount(overview.keyEvents, true)}
          </dd>
          <dt
            className="truncate text-[10px]"
            style={{ color: "var(--ws-text-3)" }}
          >
            Key events
          </dt>
        </div>
      </dl>
      <p
        className="mt-2.5 flex items-center gap-1.5 text-[11px] leading-snug"
        style={{ color: "var(--ws-text-2)" }}
      >
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[overview.health]}`}
        />
        <span className="truncate">
          {overview.healthLabel}
          {overview.dataThrough
            ? ` · Data through ${dayLabel(overview.dataThrough)}`
            : ""}
        </span>
      </p>
    </section>
  );
}
