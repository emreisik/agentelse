"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { workHref } from "@/components/layout/work-list";
import { copyText } from "@/lib/works/copy";
import {
  createWorkAction,
  openTodayWorkAction,
} from "@/server/actions/work-actions";

// A project with no Work yet: the first one is opened for the client (one tap
// would only be a detour) and the page moves into it. Guarded so a double
// effect (dev strict mode) cannot open two.

export const OPENER_COPY = {
  opening: "Opening your first Work…",
  today: copyText("today.opening"),
  failed: "Couldn't open a Work.",
  retry: "Try again",
} as const;

export type OpenerMode = "first" | "today";

// The opening line for a mode; "first" (the default) is the slice-1 text.
export function openerCopy(mode: OpenerMode = "first"): string {
  return mode === "today" ? OPENER_COPY.today : OPENER_COPY.opening;
}

export function NewWorkOpenerView({
  error,
  onRetry,
  mode = "first",
}: {
  error: string | null;
  onRetry: () => void;
  mode?: OpenerMode;
}) {
  return (
    <div
      className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-center text-sm"
      style={{ color: "var(--ws-text-2)" }}
    >
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            {OPENER_COPY.retry}
          </Button>
        </>
      ) : (
        <p role="status" className="flex items-center gap-2">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          {openerCopy(mode)}
        </p>
      )}
    </div>
  );
}

export function NewWorkOpener({
  projectId,
  mode = "first",
}: {
  projectId: string;
  mode?: OpenerMode;
}) {
  const router = useRouter();
  const started = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);

  const open = React.useCallback(async () => {
    setError(null);
    try {
      // Today mode: the deterministic id makes a repeated call harmless.
      const result =
        mode === "today"
          ? await openTodayWorkAction(projectId)
          : await createWorkAction(projectId);
      if (!result.ok) {
        started.current = false;
        setError(result.message || OPENER_COPY.failed);
        return;
      }
      router.replace(workHref(projectId, result.workId));
    } catch {
      // A dropped network or a cold database: show the retry button instead
      // of spinning forever.
      started.current = false;
      setError(OPENER_COPY.failed);
    }
  }, [projectId, router, mode]);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open();
  }, [open]);

  return (
    <NewWorkOpenerView
      mode={mode}
      error={error}
      onRetry={() => {
        started.current = true;
        void open();
      }}
    />
  );
}
