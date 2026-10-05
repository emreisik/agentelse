"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { buildHubHref } from "@/components/hub-core/hub-core-params";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const POLL_MS = 7000;
const RADIUS = 25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// A small floating action button that stays visible while the user browses
// any panel of a project whose setup hasn't activated yet — so they don't
// have to sit on the setup screen to know it's still working. Polls a
// lightweight JSON endpoint (not LiveRefresh's router.refresh(), which would
// re-fetch the whole page just to show a percentage) and quietly unmounts
// itself the moment setup activates.
export function SetupProgressWidget({
  projectId,
  initialPercent,
}: {
  projectId: string;
  initialPercent: number;
}) {
  const [percent, setPercent] = useState<number | null>(initialPercent);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    // Once setup has activated there is nothing left to show: polling stops
    // for good (until the next server render drops the widget), and a slow
    // answer never overlaps the next tick.
    let done = false;
    let inFlight = false;

    const poll = async () => {
      if (inFlight || done) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/projects/${projectId}/setup-status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          percent: number | null;
          activated: boolean;
        };
        setPercent(data.activated ? null : data.percent);
        if (data.activated) {
          done = true;
          stop();
        }
      } catch {
        // Transient network hiccup — next poll retries, nothing to show here.
      } finally {
        inFlight = false;
      }
    };

    const start = () => {
      if (timer || done) return;
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

  if (percent === null) return null;

  const offset = CIRCUMFERENCE * (1 - percent / 100);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={buildHubHref(projectId, { panel: "setup" })}
            scroll={false}
            className={cn(
              "group flex size-14 items-center justify-center rounded-full",
              "bg-gradient-to-br from-neutral-800 via-neutral-950 to-black shadow-lg shadow-black/30",
              "ring-1 ring-white/10 transition-transform hover:scale-105 active:scale-95",
            )}
          />
        }
      >
        <svg
          className="absolute inset-0 size-full -rotate-90"
          viewBox="0 0 56 56"
        >
          <circle
            cx={28}
            cy={28}
            r={RADIUS}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={2}
          />
          <circle
            cx={28}
            cy={28}
            r={RADIUS}
            fill="none"
            stroke="var(--special)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            className="transition-[stroke-dashoffset] duration-700 ease-out"
          />
        </svg>
        <Sparkles className="size-5 animate-pulse text-white" />
      </TooltipTrigger>
      <TooltipContent side="left">
        Agentelse kuruluyor · %{percent}
      </TooltipContent>
    </Tooltip>
  );
}
