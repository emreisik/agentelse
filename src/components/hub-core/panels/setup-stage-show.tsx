"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  Loader2,
  MinusCircle,
  RotateCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { SetupStage, SetupStageStatus } from "@prisma/client";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/dates";
import { retrySetupStageAction } from "@/server/actions/agency-setup-actions";
import { LiveRefresh } from "@/components/shared/live-refresh";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type SetupStageEntry = {
  stage: SetupStage;
  index: number;
  status: SetupStageStatus;
  label: string;
  hint: string;
  finding: string | null;
  completedAt: string | null;
  error: string | null;
  attemptCount: number;
  attemptsExhausted: boolean;
  link: { href: string; label: string } | null;
  decision: ReactNode | null;
  projectId: string;
};

// The manual escape hatch for a FAILED stage — shown regardless of whether
// automatic (tick-driven) retries are still running or already capped
// (project-setup-orchestrator.ts's MAX_STAGE_ATTEMPTS), so a user never has
// to just wait and hope. This is the single most direct answer to "if the
// end user hits an error here, they leave without using the app."
function RetryButton({ projectId }: { projectId: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await retrySetupStageAction(projectId);
          if (!result.ok) toast.error(result.message);
        })
      }
    >
      <RotateCw className={cn("size-3", isPending && "animate-spin")} />
      {isPending ? "Retrying…" : "Retry now"}
    </Button>
  );
}

const DOT_TONE: Record<SetupStageStatus, string> = {
  COMPLETED: "border-success bg-success text-success-foreground",
  RUNNING: "border-primary bg-primary/10 text-primary",
  WAITING_CLIENT: "border-warning bg-warning/10 text-warning",
  FAILED: "border-destructive bg-destructive/10 text-destructive",
  SKIPPED: "border-border bg-muted text-muted-foreground",
  PENDING: "border-border text-muted-foreground/40",
};

function StageIcon({
  status,
  className = "size-3.5",
}: {
  status: SetupStageStatus;
  className?: string;
}) {
  switch (status) {
    case "COMPLETED":
      return <CheckCircle2 className={className} />;
    case "RUNNING":
      return <Loader2 className={cn(className, "animate-spin")} />;
    case "WAITING_CLIENT":
      return <CircleAlert className={className} />;
    case "FAILED":
      return <XCircle className={className} />;
    case "SKIPPED":
      return <MinusCircle className={className} />;
    default:
      return <Circle className={className} />;
  }
}

function StepDot({ entry }: { entry: SetupStageEntry }) {
  const [open, setOpen] = useState(false);
  const clickable =
    entry.status === "COMPLETED" ||
    entry.status === "FAILED" ||
    entry.status === "SKIPPED";

  const dot = (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-transform",
        DOT_TONE[entry.status],
        clickable && "hover:scale-110",
      )}
    >
      <StageIcon status={entry.status} />
    </span>
  );

  if (!clickable) {
    return <span title={`${entry.index + 1}. ${entry.label}`}>{dot}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" />}>{dot}</PopoverTrigger>
      <PopoverContent align="center" className="w-72">
        <p className="text-sm font-medium">
          {entry.index + 1}. {entry.label}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {entry.finding ?? entry.hint}
        </p>
        {entry.error ? (
          <div className="mt-2 space-y-1.5">
            <p className="text-xs text-destructive">
              {entry.error}
              {entry.status === "FAILED"
                ? entry.attemptsExhausted
                  ? " — automatic retries stopped after several attempts."
                  : " — the system will keep retrying automatically."
                : null}
            </p>
            {entry.status === "FAILED" ? (
              <RetryButton projectId={entry.projectId} />
            ) : null}
          </div>
        ) : null}
        {entry.completedAt ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Completed {timeAgo(entry.completedAt)}
            {entry.attemptCount > 1 ? ` · attempt ${entry.attemptCount}` : ""}
          </p>
        ) : null}
        {entry.link ? (
          <Link
            href={entry.link.href}
            scroll={false}
            className="mt-2 inline-block text-xs text-primary underline-offset-2 hover:underline"
          >
            {entry.link.label}
          </Link>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SpotlightCard({ entry }: { entry: SetupStageEntry }) {
  const isWaiting = entry.status === "WAITING_CLIENT";
  const isFailed = entry.status === "FAILED";
  return (
    <div
      className={cn(
        "animate-in fade-in slide-in-from-top-2 rounded-xl p-5 ring-1 duration-300",
        isWaiting && "bg-warning/5 ring-warning/30",
        isFailed && "bg-destructive/5 ring-destructive/20",
        !isWaiting && !isFailed && "bg-primary/5 ring-primary/20",
      )}
    >
      <div className="flex items-start gap-3.5">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl",
            isWaiting && "bg-warning/15 text-warning",
            isFailed && "bg-destructive/15 text-destructive",
            !isWaiting && !isFailed && "bg-primary/15 text-primary",
          )}
        >
          <StageIcon status={entry.status} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {entry.index + 1}. {entry.label}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isFailed && entry.error ? entry.error : entry.hint}
          </p>
          {isFailed ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {entry.attemptsExhausted
                ? "Automatic retries stopped after several attempts."
                : "The system will keep retrying automatically."}
            </p>
          ) : null}
          {!isWaiting && !isFailed ? (
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-primary/10">
              <div className="h-full w-1/3 animate-[shimmer_1.6s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
          ) : null}
        </div>
      </div>
      {isFailed ? (
        <div className="mt-4">
          <RetryButton projectId={entry.projectId} />
        </div>
      ) : null}
      {entry.decision ? <div className="mt-4">{entry.decision}</div> : null}
    </div>
  );
}

// The first time this row is mounted (a newly completed stage, or history
// on the page's initial load) it plays a 700ms entrance animation, then
// stops silently. On subsequent polls (LiveRefresh) arriving with the same
// `key`, React does NOT remount the component, so the animation does not
// replay — it is only mounted as a genuinely new row when the `key` changes
// (see SetupStageShow: `${stage}:${status}`).
function FindingRow({
  entry,
  style,
}: {
  entry: SetupStageEntry;
  style?: React.CSSProperties;
}) {
  const [justAppeared, setJustAppeared] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setJustAppeared(false), 700);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      style={style}
      className={cn(
        "flex items-start gap-3 px-4 py-2.5",
        justAppeared &&
          "animate-in fade-in slide-in-from-top-2 fill-mode-backwards duration-500",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          entry.status === "FAILED"
            ? "text-destructive"
            : entry.status === "SKIPPED"
              ? "text-muted-foreground"
              : "text-success",
        )}
      >
        <StageIcon status={entry.status} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{entry.label}</span>
          {entry.finding ? (
            <span className="text-muted-foreground"> — {entry.finding}</span>
          ) : null}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {entry.completedAt ? timeAgo(entry.completedAt) : "—"}
          {entry.link ? (
            <Link
              href={entry.link.href}
              scroll={false}
              className="text-primary underline-offset-2 hover:underline"
            >
              {entry.link.label}
            </Link>
          ) : null}
        </p>
      </div>
    </div>
  );
}

// The view of the 12-stage process after Start Setup: a fixed-height
// (page doesn't stretch downward) horizontal compact stepper + a large
// "spotlight" for the stage currently running/awaiting a decision + a
// "Recent Findings" list showing completed stages chronologically in a
// fixed-height scrollable feed. Between polls (LiveRefresh), newly
// completed stages animate into the top of the feed, while previously seen
// ones stay fixed.
export function SetupStageShow({
  entries,
  percent,
  autoApproveOn,
}: {
  entries: SetupStageEntry[];
  percent?: number;
  autoApproveOn?: boolean;
}) {
  const finished = entries
    .filter((e) => e.status !== "PENDING")
    .filter(
      (e) =>
        e.status === "COMPLETED" ||
        e.status === "SKIPPED" ||
        e.status === "FAILED",
    )
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  const active =
    entries.find((e) => e.status === "WAITING_CLIENT") ??
    entries.find((e) => e.status === "RUNNING") ??
    entries.find((e) => e.status === "FAILED");

  const doneCount = entries.filter(
    (e) => e.status === "COMPLETED" || e.status === "SKIPPED",
  ).length;
  const lastIncompleteIndex = entries.findIndex(
    (e) => e.status !== "COMPLETED" && e.status !== "SKIPPED",
  );

  return (
    <div className="space-y-4">
      {percent !== undefined ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">%{percent}</span> ·{" "}
            {doneCount}/{entries.length} stages ·{" "}
            {autoApproveOn ? "Auto-approve on" : "Waiting for your approval"}
          </p>
          <LiveRefresh intervalMs={4000} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-2 rounded-xl bg-muted/30 p-3">
        {entries.map((entry, i) => (
          <div key={entry.stage} className="flex items-center gap-1.5">
            <StepDot entry={entry} />
            {i < entries.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px w-3 shrink-0 sm:w-4",
                  lastIncompleteIndex === -1 || i < lastIncompleteIndex
                    ? "bg-success/50"
                    : "bg-border",
                )}
              />
            ) : null}
          </div>
        ))}
      </div>

      {active ? <SpotlightCard entry={active} /> : null}

      {finished.length > 0 ? (
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Sparkles className="size-3.5 text-muted-foreground" />
            Recent Findings
            <span className="font-normal text-muted-foreground">
              ({doneCount}/{entries.length})
            </span>
          </p>
          <div className="max-h-72 divide-y divide-border/60 overflow-y-auto rounded-xl ring-1 ring-foreground/10">
            {finished.map((entry, i) => (
              <FindingRow
                key={`${entry.stage}:${entry.status}`}
                entry={entry}
                style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
