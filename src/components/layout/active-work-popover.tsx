"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
import type { AgencyLoopStatus } from "@prisma/client";
import { toast } from "sonner";

import { timeAgo } from "@/lib/dates";
import { AGENCY_LOOP_STATUS } from "@/lib/labels/work";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  approveApprovalAction,
  rejectApprovalAction,
} from "@/server/actions/approval-actions";
import type {
  ActiveJob,
  AgencyStatusSnapshot,
} from "@/server/agency/agency-status-snapshot";

const POLL_MS = 10_000;

// Status dots are the one place color is allowed in the otherwise
// monochrome --ws-* chrome.
const STATUS_DOT: Record<AgencyLoopStatus, string> = {
  RUNNING: "var(--ws-text)",
  WAITING: "var(--ws-pending)",
  BLOCKED: "var(--destructive)",
  PAUSED: "var(--ws-text-3)",
  ERROR: "var(--destructive)",
};

// Nothing is progressing in these, so the loop state matters more than a
// job count on the trigger.
const HALTED: ReadonlySet<AgencyLoopStatus> = new Set([
  "PAUSED",
  "BLOCKED",
  "ERROR",
]);

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// The sidebar's agency readout: loop status, blocked reason, now/waiting
// counts, named active jobs, last progress / next wake and today's totals
// (incl. AI cost) — everything the old header's separate "● Running"
// dropdown showed, folded into this one "N active" pill. Polls the same
// lightweight JSON route instead of a full router.refresh().
export function ActiveWorkPopover({
  projectId,
  initial,
  compact = false,
}: {
  projectId: string;
  initial: AgencyStatusSnapshot | null;
  // Inside the sidebar's brand card: no border, the dot and the count alone
  // ("● 7"); a halted or idle loop still says its word ("Paused").
  compact?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [open, setOpen] = useState(false);

  const poll = useCallback(async () => {
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
  }, [projectId]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
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
  }, [poll]);

  const status = snapshot?.status ?? null;
  const activeCount = snapshot?.tasksNow ?? 0;
  const halted = status !== null && HALTED.has(status);
  const dotColor = status
    ? STATUS_DOT[status]
    : activeCount > 0
      ? "var(--ws-text)"
      : "var(--ws-text-3)";
  // The loop state wins whenever it says more than a job count would: halted,
  // or nothing client-facing in flight (a RUNNING loop busy with internal
  // scans used to read as an idle "0 active" — the retired widget always
  // showed "Running"/"Waiting").
  const statusLabel = status ? AGENCY_LOOP_STATUS[status].label : null;
  const triggerLabel =
    statusLabel && (halted || activeCount === 0)
      ? statusLabel
      : `${activeCount} active`;
  const showsStatus = triggerLabel === statusLabel;
  const pinging = status === "RUNNING" || (status === null && activeCount > 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={
              compact
                ? triggerLabel
                : status
                  ? `Agency: ${AGENCY_LOOP_STATUS[status].label}`
                  : undefined
            }
            aria-label={compact ? `Agency: ${triggerLabel}` : undefined}
            className={
              compact
                ? "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium whitespace-nowrap tabular-nums transition-colors hover:bg-[var(--ws-hover)] data-popup-open:bg-[var(--ws-hover)]"
                : "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[var(--ws-hover)]"
            }
            style={
              compact
                ? { color: "var(--ws-text-2)" }
                : {
                    borderColor: "var(--ws-border)",
                    background: "var(--ws-surface)",
                    color: "var(--ws-text)",
                  }
            }
          />
        }
      >
        <span className="relative flex size-1.5">
          {pinging ? (
            <span
              className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
              style={{ background: dotColor }}
            />
          ) : null}
          <span
            className="relative inline-flex size-1.5 rounded-full"
            style={{ background: dotColor }}
          />
        </span>
        {compact && !showsStatus ? activeCount : triggerLabel}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        // Capped to the space Base UI measures under the trigger, like
        // DropdownMenuContent — this popup now carries the status readout
        // and today's totals too, so it can outgrow a short viewport.
        className="max-h-(--available-height) w-80 max-w-[90vw] gap-0 overflow-x-hidden overflow-y-auto rounded-2xl border p-4 shadow-lg"
        style={{
          borderColor: "var(--ws-border)",
          background: "var(--ws-surface)",
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="text-sm font-semibold"
                style={{ color: "var(--ws-text)" }}
              >
                Active work
              </span>
              {status ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    borderColor: "var(--ws-border)",
                    color: "var(--ws-text-2)",
                  }}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: STATUS_DOT[status] }}
                  />
                  {AGENCY_LOOP_STATUS[status].label}
                </span>
              ) : null}
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

        {snapshot?.blockedReason ? (
          <p className="mb-3 text-xs" style={{ color: "var(--destructive)" }}>
            {snapshot.blockedReason}
          </p>
        ) : null}

        {snapshot ? (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <StatCell label="Now" value={snapshot.tasksNow} />
            <StatCell label="Waiting" value={snapshot.tasksWaiting} />
          </div>
        ) : null}

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
                  title={job.title}
                >
                  {job.title}
                </span>
                {job.approval ? (
                  <ApprovalButtons job={job} onDecided={poll} />
                ) : (
                  <span
                    className="flex shrink-0 items-center gap-1.5 text-[11px]"
                    style={{ color: "var(--ws-text-3)" }}
                  >
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: "var(--ws-text-3)" }}
                    />
                    {job.statusWord}
                  </span>
                )}
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

        {snapshot ? (
          <div
            className="mt-3 space-y-3 border-t pt-3 text-xs"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              <DetailRow
                label="Last progress"
                value={timeAgo(snapshot.lastProgressAt)}
              />
              <DetailRow
                label="Next wake"
                value={snapshot.nextWakeAt ? timeAgo(snapshot.nextWakeAt) : "—"}
              />
            </div>
            <div>
              <p
                className="mb-1 font-medium"
                style={{ color: "var(--ws-text)" }}
              >
                Brand Brain today
              </p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1 tabular-nums">
                <DetailRow
                  label="Signals"
                  value={String(snapshot.today.signalsIngested)}
                />
                <DetailRow
                  label="New ideas"
                  value={String(snapshot.today.ideasCreated)}
                />
                <DetailRow
                  label="AI cost"
                  value={currency.format(snapshot.today.reasoningCostUsd)}
                />
              </div>
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// Approve / Reject for a task waiting on a decision. The server action
// re-checks who may decide (budget-level approvals are OWNER/ADMIN only); a
// refusal comes back as a toast.
function ApprovalButtons({
  job,
  onDecided,
}: {
  job: ActiveJob;
  onDecided: () => void;
}) {
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const approval = job.approval;
  if (!approval) return null;

  const decide = (kind: "approve" | "reject") => {
    startTransition(async () => {
      if (
        kind === "approve" &&
        approval.spend &&
        !(await confirm({
          title: "Approve this budget change?",
          description: job.title,
          confirmLabel: "Approve",
        }))
      ) {
        return;
      }
      const formData = new FormData();
      formData.set("approvalId", approval.id);
      const result =
        kind === "approve"
          ? await approveApprovalAction(formData)
          : await rejectApprovalAction(formData);
      if (result.ok) {
        toast.success(kind === "approve" ? "Approved" : "Rejected");
        onDecided();
      } else {
        toast.error(result.message);
      }
    });
  };

  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => decide("reject")}
        className="rounded-md px-1.5 py-0.5 text-[11px] transition-colors hover:bg-[var(--ws-hover)] disabled:opacity-50"
        style={{ color: "var(--ws-text-3)" }}
      >
        Reject
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => decide("approve")}
        className="rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--ws-hover)] disabled:opacity-50"
        style={{ color: "var(--ws-text)" }}
      >
        Approve
      </button>
    </span>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="rounded-xl px-2.5 py-1.5"
      style={{ background: "var(--ws-surface-2)" }}
    >
      <div
        className="text-[10px] tracking-wide uppercase"
        style={{ color: "var(--ws-text-3)" }}
      >
        {label}
      </div>
      <div
        className="text-base font-semibold tabular-nums"
        style={{ color: "var(--ws-text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span style={{ color: "var(--ws-text-3)" }}>{label}</span>
      <span className="text-right" style={{ color: "var(--ws-text)" }}>
        {value}
      </span>
    </>
  );
}
