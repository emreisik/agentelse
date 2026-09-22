"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";

import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import { AGENCY_LOOP_STATUS } from "@/lib/labels/work";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgencyStatusSnapshot } from "@/server/agency/agency-status-snapshot";

const POLL_MS = 10_000;

const DOT_TONE: Record<string, string> = {
  RUNNING: "bg-primary",
  WAITING: "bg-warning",
  BLOCKED: "bg-destructive",
  PAUSED: "bg-muted-foreground",
  ERROR: "bg-destructive",
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// The always-visible "is the agency alive" readout, mounted next to
// ProjectToolsMenu in the TopBar — same DropdownMenu shell so it matches the
// rest of the header, same polling pattern as SetupProgressWidget (a
// dedicated JSON route instead of a full router.refresh()). Renders nothing
// until AgencyLoopState has a row for this project — a brand-new project
// with no heartbeat contact yet has nothing truthful to show.
export function AgencyStatusWidget({
  projectId,
  initial,
}: {
  projectId: string;
  initial: AgencyStatusSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/agency-status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          snapshot: AgencyStatusSnapshot | null;
        };
        setSnapshot(data.snapshot);
      } catch {
        // Transient network hiccup — next poll retries, current value stays.
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(poll, POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId]);

  if (!snapshot || !snapshot.status) return null;

  const meta = AGENCY_LOOP_STATUS[snapshot.status];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
          />
        }
      >
        <span className="relative flex size-2">
          {snapshot.status === "RUNNING" ? (
            <span
              className={cn(
                "absolute inline-flex size-full animate-ping rounded-full opacity-60",
                DOT_TONE[snapshot.status],
              )}
            />
          ) : null}
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              DOT_TONE[snapshot.status] ?? "bg-muted-foreground",
            )}
          />
        </span>
        {meta.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          Agency
          <StatusBadge meta={meta} className="ml-auto" />
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="space-y-2.5 px-2 py-2 text-xs">
          {snapshot.blockedReason ? (
            <p className="text-destructive">{snapshot.blockedReason}</p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <StatCell label="Now" value={snapshot.tasksNow} />
            <StatCell label="Waiting" value={snapshot.tasksWaiting} />
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-muted-foreground">
            <span>Last progress</span>
            <span className="text-right text-foreground">
              {timeAgo(snapshot.lastProgressAt)}
            </span>
            <span>Next wake</span>
            <span className="text-right text-foreground">
              {snapshot.nextWakeAt ? timeAgo(snapshot.nextWakeAt) : "—"}
            </span>
          </div>
          <DropdownMenuSeparator />
          <p className="font-medium text-foreground">Today</p>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-muted-foreground">
            <span>Signals</span>
            <span className="text-right text-foreground tabular-nums">
              {snapshot.today.signalsIngested}
            </span>
            <span>Opportunities</span>
            <span className="text-right text-foreground tabular-nums">
              {snapshot.today.opportunitiesCreated}
            </span>
            <span>Ideas</span>
            <span className="text-right text-foreground tabular-nums">
              {snapshot.today.ideasCreated}
            </span>
            <span>Tasks</span>
            <span className="text-right text-foreground tabular-nums">
              {snapshot.today.tasksCreated}
            </span>
            <span>AI cost</span>
            <span className="text-right text-foreground tabular-nums">
              {currency.format(snapshot.today.reasoningCostUsd)}
            </span>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
