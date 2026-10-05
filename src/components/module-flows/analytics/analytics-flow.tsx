"use client";

import { RefreshCw, Share2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { WsStatusPill } from "@/components/commands/ws-event-card";
import { FlowStepper } from "@/components/modules/flow-stepper";
import { ModuleIcon } from "@/components/modules/module-icon";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import {
  SOURCE_LABEL,
  type AnalyticsSource,
} from "@/lib/module-flows/analytics/catalog";
import { ANALYTICS_COPY as COPY } from "@/lib/module-flows/analytics/copy";
import {
  periodText,
  reportHasNumbers,
} from "@/lib/module-flows/analytics/report";
import {
  isBuildRunning,
  isFlowComplete,
  openableSteps,
  readAnalyticsState,
} from "@/lib/module-flows/analytics/state";
import type {
  ModuleFlowCardData,
  ModuleFlowStep,
} from "@/lib/module-flows/card";
import { MODULES } from "@/lib/modules/catalog";
import { flowStepLabel } from "@/lib/modules/flow";
import { copyText } from "@/lib/works/copy";
import {
  buildAnalyticsReportAction,
  markAnalyticsSharedAction,
  openAnalyticsStepAction,
  saveAnalyticsBriefAction,
  type AnalyticsFlowResult,
} from "@/server/actions/analytics-flow-actions";

import { BriefStep } from "./brief-step";
import { CreateStep } from "./create-step";
import { DeliverStep } from "./deliver-step";
import { PrimaryButton, QuietButton, StepActions } from "./parts";
import { PlanStep } from "./plan-step";
import { ReportView } from "./report-view";

// The Analytics flow card (docs/modules.md "Analytics"): Brief -> Plan ->
// Create -> Review -> Share on ONE card that changes in place. The brief picks
// the period and the connected sources, the plan the report's sections; Build
// reads every source for real and writes an AI summary from those numbers only;
// the report is reviewed as KPI tiles and shared as text, Markdown or a PDF.
// Every move is one Server Action (analytics-flow-actions.ts); the card's data
// is read back through readAnalyticsState, never trusted as stored.

// While another request builds this report (a reload, a second tab), the card
// looks again this often until the report lands or the build goes stale.
const POLL_MS = 5_000;

type PendingKind = "brief" | "step" | "share" | "build";

export function AnalyticsFlow({
  card,
  commandId,
}: {
  card: ModuleFlowCardData;
  commandId?: string;
}) {
  const host = useWorkCardHost();
  const router = useRouter();
  const headingId = useId();
  const reasonId = useId();
  const state = useMemo(() => readAnalyticsState(card.data), [card.data]);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();
  const [pendingKind, setPendingKind] = useState<PendingKind | null>(null);
  const [building, setBuilding] = useState<AnalyticsSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourcesVersion, setSourcesVersion] = useState(0);
  const stepRef = useRef<HTMLDivElement>(null);
  const focusStep = useRef(false);

  const busy = isPending ? pendingKind : null;
  const running = card.step === "create" && isBuildRunning(state.build, now);

  useEffect(() => {
    if (!running || busy) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, busy, router]);

  // A step this card moved to takes the focus, so the next step is read out.
  useEffect(() => {
    if (!focusStep.current) return;
    focusStep.current = false;
    stepRef.current?.focus({ preventScroll: true });
  }, [card.step]);

  if (!host) return null;
  const projectId = host.projectId;
  const blockedReason = commandId
    ? disabledReasonOf(host, { kind: "server" })
    : COPY.readOnly;
  const waiting = busy !== null;

  const run = (
    kind: PendingKind,
    call: (id: string) => Promise<AnalyticsFlowResult>,
  ) => {
    if (isPending || !commandId || blockedReason) return;
    setError(null);
    setPendingKind(kind);
    focusStep.current = true;
    startTransition(async () => {
      let result: AnalyticsFlowResult;
      try {
        result = await call(commandId);
      } catch {
        result = { ok: false, code: "FAILED", message: copyText("kit.failed") };
      }
      if (result.ok) {
        if (result.message) host.announce(result.message);
        if (result.changed) router.refresh();
        return;
      }
      focusStep.current = false;
      if (result.code === "STALE") {
        toast.error(COPY.stale);
        router.refresh();
        return;
      }
      if (result.code === "SOURCES") setSourcesVersion((value) => value + 1);
      setError(result.message);
    });
  };

  const openStep = (step: ModuleFlowStep) =>
    run("step", (id) => openAnalyticsStepAction(projectId, id, step));

  const build = (sections: AnalyticsSource[]) => {
    if (isPending || !commandId || blockedReason) return;
    setBuilding(sections);
    run("build", (id) => buildAnalyticsReportAction(projectId, id, sections));
  };

  // The first share marks the flow delivered; a failure there changes nothing
  // the person sees, so it stays quiet.
  const markShared = () => {
    if (!commandId || state.sharedAt || blockedReason) return;
    markAnalyticsSharedAction(projectId, commandId).then(
      (result) => {
        if (result.ok && result.changed) router.refresh();
      },
      () => undefined,
    );
  };

  const shownStep: ModuleFlowStep = busy === "build" ? "create" : card.step;
  const complete = !busy && isFlowComplete(card.step, state);
  const openable =
    busy || blockedReason ? undefined : openableSteps(card.step, state, now);
  const shownError = error ?? state.error;
  const meta =
    state.sources.length > 0
      ? `${periodText(state.period)} · ${state.sources
          .map((source) => SOURCE_LABEL[source])
          .join(", ")}`
      : MODULES.analytics.blurb;

  let body: ReactNode;
  switch (shownStep) {
    case "brief":
      body = (
        <BriefStep
          key={`${state.period}|${state.sources.join(",")}`}
          projectId={projectId}
          flow={state}
          sourcesVersion={sourcesVersion}
          busy={busy === "brief"}
          waiting={waiting}
          blockedReason={blockedReason}
          error={error}
          onContinue={(period, sources) =>
            run("brief", (id) =>
              saveAnalyticsBriefAction(projectId, id, { period, sources }),
            )
          }
        />
      );
      break;
    case "plan":
      body = (
        <PlanStep
          key={`${state.sources.join(",")}|${state.sections.join(",")}`}
          flow={state}
          waiting={waiting}
          blockedReason={blockedReason}
          error={shownError}
          onBack={() => openStep("brief")}
          onBuild={build}
        />
      );
      break;
    case "create":
      body = (
        <CreateStep
          sections={busy === "build" ? building : state.sections}
          running={busy === "build" || running}
          waiting={waiting}
          blockedReason={blockedReason}
          error={error}
          onRetry={() => build(state.sections)}
          onBack={() => openStep("plan")}
        />
      );
      break;
    case "review":
    case "deliver": {
      const report = state.report;
      if (!report) {
        const buildReason =
          state.sources.length > 0 ? blockedReason : COPY.reasonBriefFirst;
        body = (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: "var(--ws-text-2)" }}>
              {COPY.reportMissing}
            </p>
            <StepActions
              reasonId={reasonId}
              reason={buildReason}
              error={shownError}
              quiet={
                <QuietButton
                  label={COPY.back}
                  waiting={waiting}
                  blockedReason={blockedReason}
                  onClick={() => openStep("brief")}
                />
              }
              primary={
                <PrimaryButton
                  label={COPY.build}
                  waiting={waiting}
                  blockedReason={buildReason}
                  reasonId={reasonId}
                  onClick={() => build(state.sections)}
                />
              }
            />
          </div>
        );
        break;
      }
      const shareReason = reportHasNumbers(report)
        ? blockedReason
        : COPY.reasonNothingToShare;
      body = (
        <div className="space-y-4">
          <ReportView
            report={report}
            projectId={projectId}
            timeZone={host.timezone}
          />
          {shownStep === "review" ? (
            <StepActions
              reasonId={reasonId}
              reason={shareReason}
              error={shownError}
              quiet={
                <QuietButton
                  label={COPY.rebuild}
                  icon={<RefreshCw aria-hidden="true" />}
                  waiting={waiting}
                  blockedReason={blockedReason}
                  onClick={() => build(state.sections)}
                />
              }
              primary={
                <PrimaryButton
                  label={COPY.share}
                  icon={<Share2 aria-hidden="true" />}
                  busy={busy === "share"}
                  waiting={waiting}
                  blockedReason={shareReason}
                  reasonId={reasonId}
                  onClick={() =>
                    run("share", (id) =>
                      openAnalyticsStepAction(projectId, id, "deliver"),
                    )
                  }
                />
              }
            />
          ) : (
            <DeliverStep
              report={report}
              options={{ brand: host.projectName, timeZone: host.timezone }}
              onShared={markShared}
              announce={host.announce}
            />
          )}
        </div>
      );
      break;
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      data-card="module-flow"
      data-module="analytics"
      data-card-id={commandId}
      className="mt-1 w-full max-w-xl space-y-4 rounded-2xl border p-3.5 sm:p-4"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
      }}
    >
      <header className="flex items-center gap-2.5">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-[10px]"
          style={{ background: "var(--ws-surface-2)", color: "var(--ws-text)" }}
        >
          <ModuleIcon module="analytics" />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            id={headingId}
            className="truncate text-sm font-semibold"
            style={{ color: "var(--ws-text)" }}
          >
            {card.title}
          </h3>
          <p className="truncate text-xs" style={{ color: "var(--ws-text-2)" }}>
            {meta}
          </p>
        </div>
        {complete ? <WsStatusPill label={COPY.shared} tone="positive" /> : null}
      </header>

      <FlowStepper
        module="analytics"
        current={shownStep}
        complete={complete}
        openable={openable}
        onPick={openStep}
      />

      <div
        ref={stepRef}
        tabIndex={-1}
        role="group"
        aria-label={flowStepLabel(shownStep, "analytics")}
        aria-busy={busy ? true : undefined}
        className="outline-none"
      >
        {body}
      </div>
    </section>
  );
}
