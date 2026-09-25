"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AgencyStatusSnapshot } from "@/server/agency/agency-status-snapshot";

const POLL_MS = 10_000;

// Brand Workspace header's "N active" pill + popover — a named-jobs view
// of the same AgencyStatusSnapshot AgencyStatusWidget already polls (that
// widget stays untouched, used on every OTHER screen); this is the
// workspace-root-only presentation, with real per-job rows instead of
// just aggregate counts (see agency-status-snapshot.ts's `activeJobs`
// field). Chrome uses the monochrome --ws-* tokens; the status dots stay
// semantic color (emerald/blue) per the design direction — small status
// indicators are the one place color is allowed in an otherwise
// monochrome UI.
export function ActiveWorkPopover({
  projectId,
  initial,
}: {
  projectId: string;
  initial: AgencyStatusSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [open, setOpen] = useState(false);

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
    const onVisibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId]);

  const activeCount = snapshot?.tasksNow ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[var(--ws-hover)]"
            style={{
              borderColor: "var(--ws-border)",
              background: "var(--ws-surface)",
              color: "var(--ws-text)",
            }}
          />
        }
      >
        <span className="relative flex size-1.5">
          {activeCount > 0 ? (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          ) : null}
          <span
            className="relative inline-flex size-1.5 rounded-full"
            style={{
              background: activeCount > 0 ? "#10b981" : "var(--ws-text-3)",
            }}
          />
        </span>
        {activeCount} active
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 max-w-[90vw] gap-0 rounded-2xl border p-4 shadow-lg"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <div
              className="text-sm font-semibold"
              style={{ color: "var(--ws-text)" }}
            >
              Active work
            </div>
            <div
              className="mt-0.5 text-xs"
              style={{ color: "var(--ws-text-3)" }}
            >
              Agentelse keeps working in the background.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="rounded-md p-1 transition-colors hover:bg-[var(--ws-hover)]"
            style={{ color: "var(--ws-text-3)" }}
          >
            <X className="size-3.5" />
          </button>
        </div>

        {snapshot && snapshot.activeJobs.length > 0 ? (
          <div
            className="flex flex-col divide-y"
            style={{ borderColor: "var(--ws-border)" }}
          >
            {snapshot.activeJobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                style={{ borderColor: "var(--ws-border)" }}
              >
                <span
                  className="min-w-0 truncate text-xs"
                  style={{ color: "var(--ws-text-body)" }}
                >
                  {job.title}
                </span>
                <span
                  className="flex shrink-0 items-center gap-1.5 text-[11px]"
                  style={{ color: "var(--ws-text-3)" }}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: "#3b82f6" }}
                  />
                  {job.statusWord}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="rounded-xl px-3 py-3 text-xs"
            style={{
              background: "var(--ws-surface-2)",
              color: "var(--ws-text-3)",
            }}
          >
            Nothing in progress right now — you&apos;ll see it here the moment
            Agentelse starts something.
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
