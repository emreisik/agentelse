"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useId, type ReactNode } from "react";

import {
  SOURCE_LABEL,
  type AnalyticsSource,
} from "@/lib/module-flows/analytics/catalog";
import { ANALYTICS_COPY as COPY } from "@/lib/module-flows/analytics/copy";

import { PrimaryButton, QuietButton, SourceMark, StepActions } from "./parts";

// Step 3, Create: the report being built from real data, in the open. Every
// source is read at once, then the summary is written from those numbers; the
// card says so, calmly, until the report lands. A build that stopped (a
// restart, a lost request) says so and offers to try again.

export function CreateStep({
  sections,
  running,
  waiting,
  blockedReason,
  error,
  onRetry,
  onBack,
}: {
  sections: readonly AnalyticsSource[];
  running: boolean;
  // An action of the card runs (Try again itself shows the build at once).
  waiting: boolean;
  blockedReason: string | null;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  const reasonId = useId();
  if (running) {
    return (
      <div aria-busy="true" className="space-y-3">
        <p
          className="flex items-center gap-2 text-sm font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          {COPY.building}
        </p>
        <ul className="space-y-1.5">
          {sections.map((source) => (
            <BuildLine
              key={source}
              label={COPY.readingSource(SOURCE_LABEL[source])}
            >
              <SourceMark source={source} className="size-6" />
            </BuildLine>
          ))}
          <BuildLine label={COPY.writingSummary}>
            <span
              aria-hidden="true"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "var(--ws-surface-2)" }}
            >
              <Sparkles
                className="size-3"
                style={{ color: "var(--ws-text)" }}
              />
            </span>
          </BuildLine>
        </ul>
        <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
          {COPY.buildingHint}
        </p>
        {error ? (
          <p
            role="alert"
            className="text-xs"
            style={{ color: "var(--destructive)" }}
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
        {COPY.stopped}
      </p>
      <StepActions
        reason={blockedReason}
        reasonId={reasonId}
        error={error}
        quiet={
          <QuietButton
            label={COPY.back}
            blockedReason={blockedReason}
            waiting={waiting}
            onClick={onBack}
          />
        }
        primary={
          <PrimaryButton
            label={COPY.tryAgain}
            waiting={waiting}
            blockedReason={blockedReason}
            reasonId={reasonId}
            onClick={onRetry}
          />
        }
      />
    </div>
  );
}

function BuildLine({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <li
      className="flex items-center gap-2.5 text-xs"
      style={{ color: "var(--ws-text-2)" }}
    >
      {children}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full motion-safe:animate-pulse"
        style={{ background: "var(--ws-pending)" }}
      />
    </li>
  );
}
