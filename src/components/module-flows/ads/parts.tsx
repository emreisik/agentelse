"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useWorkCardHost } from "@/components/works/work-card-host";
import { ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import { cn } from "@/lib/utils";

// Small pieces the Ads Manager card's steps share: a labelled section, a
// choice chip, the field look, a calm loading line and the one write runner
// (busy state, error line, focus and announcement, page refresh).

// Text fields in the Works look; 16px on phones so iOS does not zoom.
export const FIELD_CLASS =
  "w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 sm:text-sm";

export const FIELD_STYLE = {
  borderColor: "var(--ws-border)",
  color: "var(--ws-text)",
} as const;

export function Section({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  // The field the label names, when there is one control.
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const labelClass = "block text-xs font-medium";
  return (
    <div className="space-y-1.5">
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          className={labelClass}
          style={{ color: "var(--ws-text-2)" }}
        >
          {label}
        </label>
      ) : (
        <p className={labelClass} style={{ color: "var(--ws-text-2)" }}>
          {label}
        </p>
      )}
      {children}
      {hint ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 sm:min-h-8"
      style={{
        borderColor: active ? "var(--ws-accent)" : "var(--ws-border)",
        background: active ? "var(--ws-accent)" : "transparent",
        color: active ? "var(--ws-on-accent)" : "var(--ws-text-2)",
      }}
    >
      {children}
    </button>
  );
}

export function LoadingLine({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn("flex items-center gap-2 text-sm", className)}
      style={{ color: "var(--ws-text-2)" }}
    >
      <Loader2
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
      />
      {children}
    </p>
  );
}

export type ActionFail = { ok: false; message: string };

export type StepActions = {
  busyId: string | null;
  error: string | null;
  // Runs one write. `moves`: the card moves to another step, so the new step
  // takes the focus. Answers the action's result, or null when it failed.
  run: <T extends { ok: true }>(
    id: string,
    call: () => Promise<T | ActionFail>,
    options?: { moves?: boolean; announce?: string },
  ) => Promise<T | null>;
  clearError: () => void;
};

export function useStepActions(commandId: string): StepActions {
  const host = useWorkCardHost();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One write at a time, even for two taps inside one render.
  const running = useRef(false);

  const run: StepActions["run"] = async (id, call, options = {}) => {
    if (running.current) return null;
    running.current = true;
    setBusyId(id);
    setError(null);
    if (options.moves) host?.requestFocus(commandId);
    try {
      const result = await call();
      if (!result.ok) {
        if (options.moves) host?.cancelFocus(commandId);
        setError(result.message || ADS_FLOW_COPY.failed);
        return null;
      }
      if (options.announce) host?.announce(options.announce);
      router.refresh();
      return result;
    } catch {
      if (options.moves) host?.cancelFocus(commandId);
      setError(ADS_FLOW_COPY.failed);
      return null;
    } finally {
      running.current = false;
      setBusyId(null);
    }
  };

  return { busyId, error, run, clearError: () => setError(null) };
}
