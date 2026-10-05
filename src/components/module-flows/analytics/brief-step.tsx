"use client";

import { Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { ConnectionDot } from "@/components/commands/channel-badge";
import {
  ANALYTICS_PERIODS,
  ANALYTICS_SOURCES,
  SOURCE_LABEL,
  integrationsHref,
  orderedSources,
  type AnalyticsPeriod,
  type AnalyticsSource,
  type AnalyticsSourceStates,
  type SourceState,
} from "@/lib/module-flows/analytics/catalog";
import {
  ANALYTICS_COPY as COPY,
  SOURCE_CONNECTED,
  SOURCE_FIX_LINK,
  SOURCE_STATUS_TEXT,
} from "@/lib/module-flows/analytics/copy";
import type { AnalyticsFlowState } from "@/lib/module-flows/analytics/state";
import { cn } from "@/lib/utils";
import { analyticsSourcesAction } from "@/server/actions/analytics-flow-actions";

import {
  GroupHeading,
  PrimaryButton,
  QuietButton,
  SourceMark,
  StepActions,
} from "./parts";

// Step 1, Brief: the period and the sources, each with its live connection
// state (read when the step opens). A source that can't be read is not a
// choice: it shows why and a quiet link to the integrations page. Connected
// sources start ticked; at least one is needed to go on.

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; sources: AnalyticsSourceStates };

export function BriefStep({
  projectId,
  flow,
  sourcesVersion,
  busy,
  waiting,
  blockedReason,
  error,
  onContinue,
}: {
  projectId: string;
  flow: AnalyticsFlowState;
  // Bumped by the card when the server says a source can't be read anymore.
  sourcesVersion: number;
  // Its own Continue runs / any action of the card runs.
  busy: boolean;
  waiting: boolean;
  blockedReason: string | null;
  error: string | null;
  onContinue: (period: AnalyticsPeriod, sources: AnalyticsSource[]) => void;
}) {
  const periodId = useId();
  const sourcesId = useId();
  const reasonId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [period, setPeriod] = useState<AnalyticsPeriod>(flow.period);
  // null: nothing chosen by hand yet, every connected source is ticked.
  const [picked, setPicked] = useState<AnalyticsSource[] | null>(
    flow.sources.length > 0 ? flow.sources : null,
  );

  useEffect(() => {
    let alive = true;
    analyticsSourcesAction(projectId).then(
      (result) => {
        if (!alive) return;
        setLoaded(
          result.ok
            ? { state: "ready", sources: result.sources }
            : { state: "failed" },
        );
      },
      () => {
        if (alive) setLoaded({ state: "failed" });
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId, attempt, sourcesVersion]);

  const sources = loaded.state === "ready" ? loaded.sources : null;
  const connected = sources
    ? ANALYTICS_SOURCES.filter(
        (source) => sources[source].status === "connected",
      )
    : [];
  const chosen = (picked ?? connected).filter((source) =>
    connected.includes(source),
  );

  const reason =
    loaded.state === "loading"
      ? COPY.checking
      : loaded.state === "failed"
        ? COPY.sourcesFailed
        : connected.length === 0
          ? COPY.reasonNoneConnected
          : chosen.length === 0
            ? COPY.reasonPick
            : blockedReason;
  // While the sources load (or fail to), their own line is the reason: it is
  // not written a second time under the button.
  const reasonShownBelow = loaded.state === "ready" ? reason : null;

  const toggle = (source: AnalyticsSource) =>
    setPicked(
      chosen.includes(source)
        ? chosen.filter((item) => item !== source)
        : orderedSources([...chosen, source]),
    );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <GroupHeading id={periodId}>{COPY.periodHeading}</GroupHeading>
        <div
          role="group"
          aria-labelledby={periodId}
          className="grid grid-cols-3 gap-1 rounded-xl border p-1"
          style={{ borderColor: "var(--ws-border)" }}
        >
          {ANALYTICS_PERIODS.map((days) => {
            const on = period === days;
            return (
              <button
                key={days}
                type="button"
                aria-pressed={on}
                onClick={() => setPeriod(days)}
                className={cn(
                  "min-h-10 rounded-lg px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  !on && "hover:bg-[var(--ws-hover)]",
                )}
                style={
                  on
                    ? {
                        background: "var(--ws-text)",
                        color: "var(--ws-surface)",
                      }
                    : { color: "var(--ws-text-2)" }
                }
              >
                {COPY.periodOption(days)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <GroupHeading id={sourcesId}>{COPY.sourcesHeading}</GroupHeading>
        {sources ? (
          <ul
            aria-labelledby={sourcesId}
            className="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
          >
            {ANALYTICS_SOURCES.map((source) => (
              <li key={source}>
                <SourceTile
                  source={source}
                  state={sources[source]}
                  on={chosen.includes(source)}
                  projectId={projectId}
                  onToggle={() => toggle(source)}
                />
              </li>
            ))}
          </ul>
        ) : loaded.state === "failed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p
              id={reasonId}
              className="text-xs"
              style={{ color: "var(--ws-text-2)" }}
            >
              {COPY.sourcesFailed}
            </p>
            <QuietButton
              label={COPY.retry}
              onClick={() => {
                setLoaded({ state: "loading" });
                setAttempt((value) => value + 1);
              }}
            />
          </div>
        ) : (
          <SourcesLoading messageId={reasonId} />
        )}
      </div>

      <StepActions
        reason={reasonShownBelow}
        reasonId={reasonId}
        error={error}
        primary={
          <PrimaryButton
            label={COPY.continue}
            busy={busy}
            busyLabel={COPY.saving}
            waiting={waiting}
            blockedReason={reason}
            reasonId={reasonId}
            onClick={() => onContinue(period, chosen)}
          />
        }
      />
    </div>
  );
}

function SourcesLoading({ messageId }: { messageId: string }) {
  return (
    <div aria-busy="true" className="space-y-2">
      <p
        id={messageId}
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--ws-text-2)" }}
      >
        <Loader2
          aria-hidden="true"
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
        {COPY.checking}
      </p>
      <div
        aria-hidden="true"
        className="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
      >
        {ANALYTICS_SOURCES.map((source) => (
          <div
            key={source}
            className="flex min-h-14 items-center gap-2.5 rounded-xl border px-3 py-2"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <SourceMark source={source} className="opacity-50" />
            <span
              className="h-3 w-24 rounded-full motion-safe:animate-pulse"
              style={{ background: "var(--ws-surface-2)" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceTile({
  source,
  state,
  on,
  projectId,
  onToggle,
}: {
  source: AnalyticsSource;
  state: SourceState;
  on: boolean;
  projectId: string;
  onToggle: () => void;
}) {
  const name = SOURCE_LABEL[source];
  if (state.status !== "connected") {
    const fix = SOURCE_FIX_LINK[state.status];
    return (
      <div
        className="flex min-h-14 items-center gap-2.5 rounded-xl border border-dashed px-3 py-2"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <SourceMark source={source} className="opacity-60" />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-sm font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {name}
          </span>
          <span
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: "var(--ws-text-3)" }}
          >
            <ConnectionDot state="missing" />
            <span className="truncate">{SOURCE_STATUS_TEXT[state.status]}</span>
          </span>
        </span>
        <Link
          href={integrationsHref(projectId)}
          aria-label={COPY.fixAria(fix, name)}
          className="inline-flex min-h-9 shrink-0 items-center rounded-lg px-2 text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ color: "var(--ws-text)" }}
        >
          {fix}
        </Link>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className="flex min-h-14 w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-[var(--ws-hover)] focus-visible:ring-2 focus-visible:ring-ring/50"
      style={{ borderColor: on ? "var(--ws-accent)" : "var(--ws-border)" }}
    >
      <SourceMark source={source} />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-sm font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          {name}
        </span>
        <span
          className="flex items-center gap-1.5 text-[11px]"
          style={{ color: "var(--ws-text-2)" }}
        >
          <ConnectionDot state="connected" />
          <span className="truncate">{state.account ?? SOURCE_CONNECTED}</span>
        </span>
      </span>
      <span
        aria-hidden="true"
        className="grid size-5 shrink-0 place-items-center rounded-full border"
        style={
          on
            ? {
                background: "var(--ws-accent)",
                borderColor: "var(--ws-accent)",
                color: "var(--ws-on-accent)",
              }
            : { borderColor: "var(--ws-border)" }
        }
      >
        {on ? <Check className="size-3" /> : null}
      </span>
    </button>
  );
}
