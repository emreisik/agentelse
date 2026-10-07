"use client";

import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { FlowStepper } from "@/components/modules/flow-stepper";
import { ModuleIcon } from "@/components/modules/module-icon";
import { ActionCard } from "@/components/works/action-card";
import {
  disabledReasonOf,
  useWorkCardHost,
} from "@/components/works/work-card-host";
import type {
  ModuleFlowCardData,
  ModuleFlowStep,
} from "@/lib/module-flows/card";
import {
  parseSeoState,
  seoFlowComplete,
  seoModeOf,
  seoOpenableSteps,
  seoRunActive,
  seoStatusOf,
  seoStepsFor,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import { flowHintOf } from "@/lib/module-flows/card";
import { CardActions } from "@/components/works/card-actions";
import { MODULES } from "@/lib/modules/catalog";
import { goToSeoStepAction } from "@/server/actions/seo-flow-actions";

import { BriefStep } from "./brief-step";
import { SEO_FLOW_COPY as COPY } from "./copy";
import { CreateStep } from "./create-step";
import { DeliverStep } from "./deliver-step";
import {
  LivePhaseProvider,
  retryRun,
  serverButton,
  useSeoStepAction,
} from "./parts";
import { PlanStep } from "./plan-step";
import { ReviewStep } from "./review-step";
import { useSeoLive } from "./use-seo-live";

// The SEO Manager flow card (docs/modules.md "SEO Manager"): Brief (topic,
// site, language) -> Plan (keyword research with web search, Search Console
// quick wins, an editable outline) -> Create (the article) -> Review (on-page
// checks, Rewrite) -> Publish (copy it out, the Content Calendar, "Mark as
// published"), on ONE card that changes in place. Every write is a server
// action (seo-flow-actions.ts) followed by a refresh. While a model call holds
// the card (another tab, a reload) the card says so and checks back on its
// own until it is done.
// SC-F6: a card stamped with state.features.live streams a running model call
// over SSE (use-seo-live.ts: the phase in the pill and the working note, a
// refresh when it ends) and shows why a run stopped; state.features.modes adds
// the modes (Refresh a page, Fix a snippet; snippet mode has three steps).

const POLL_MS = 6000;

function SeoIcon(props: { className?: string; style?: CSSProperties }) {
  return <ModuleIcon module="seo" {...props} />;
}

// The step a tap is taking the card to, tied to the card as it was tapped:
// it lapses by itself as soon as the card changes (the server's answer, a
// refresh), so a failed or finished move never sticks.
type Moving = { from: ModuleFlowCardData["data"]; to: ModuleFlowStep };

export function SeoFlow({
  card,
  commandId,
}: {
  card: ModuleFlowCardData;
  commandId?: string;
}) {
  const host = useWorkCardHost();
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId =
    host?.projectId ??
    (typeof params?.projectId === "string" ? params.projectId : undefined);
  const state = useMemo(() => parseSeoState(card.data), [card.data]);
  const step = card.step;
  const running = seoRunActive(state.run);
  const blocked =
    disabledReasonOf(host, { kind: "server" }) ??
    (projectId && commandId ? null : COPY.unavailable);

  const [moving, setMoving] = useState<Moving | null>(null);
  const data = card.data;
  const onMoving = useCallback(
    (to: ModuleFlowStep | null) => setMoving(to ? { from: data, to } : null),
    [data],
  );
  const moveTo = moving && moving.from === data ? moving.to : null;
  const shownStep = moveTo ?? step;

  // Canlı kart: koşu SSE ile izlenir; bağlantı koparsa kendi 6 sn'lik yoklamasına
  // düşer. Damgasız kart bugünkü yoklamayı kullanır.
  const live = state.features?.live === true;
  const liveRun = useSeoLive({
    projectId,
    commandId,
    runId: state.run?.id,
    enabled: live && running,
  });

  // Someone else's model call (or one from before a reload): check back until
  // it lands. The tab that started it gets the answer with its own action.
  useEffect(() => {
    if (!running || live) return;
    const timer = window.setInterval(() => router.refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, live, router]);

  // A step change moves the focus to the new step, not to <body>.
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownBody = useRef(step);
  useEffect(() => {
    if (shownBody.current === step) return;
    shownBody.current = step;
    bodyRef.current?.focus({ preventScroll: true });
  }, [step]);

  // The stepper's own moves (an earlier step, or back to a later one).
  const nav = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { brief: "brief", plan: "plan", review: "review" },
    server: (to, ids) => goToSeoStepAction(ids.projectId, ids.commandId, to),
  });
  const openable =
    blocked || nav.busyId || moveTo ? {} : seoOpenableSteps(step, state);
  const pick = (to: ModuleFlowStep) =>
    nav.onAct({
      id: to,
      label: to,
      emphasis: "quiet",
      action: { kind: "server", id: to },
    });

  const stateStatus = seoStatusOf(state);
  const phase =
    live && running ? (liveRun.phase ?? state.run?.phase ?? null) : null;
  const status =
    phase && stateStatus
      ? { ...stateStatus, label: COPY.phasePill[phase] }
      : stateStatus;
  const mode = seoModeOf(state);
  const common = { projectId, commandId, state, blocked, onMoving };
  let body: ReactNode;
  switch (step) {
    case "brief":
      body = (
        <BriefStep
          {...common}
          running={running}
          defaultTopic={flowHintOf(card.data).topic}
        />
      );
      break;
    case "plan":
      body = <PlanStep {...common} running={running} />;
      break;
    case "create":
      body = (
        <CreateStep
          projectId={projectId}
          commandId={commandId}
          running={running}
          blocked={blocked}
          onMoving={onMoving}
        />
      );
      break;
    case "review":
      body = <ReviewStep {...common} running={running} />;
      break;
    case "deliver":
      body = <DeliverStep {...common} timezone={host?.timezone} />;
      break;
  }

  return (
    <ActionCard
      icon={SeoIcon}
      title={card.title}
      width="wide"
      cardId="module-flow"
      commandId={commandId}
      reason={state.brief?.topic ?? MODULES.seo.blurb}
      {...(status ? { status } : {})}
    >
      <FlowStepper
        module="seo"
        current={shownStep}
        complete={seoFlowComplete(state)}
        openable={openable}
        onPick={pick}
        {...(mode !== "article" ? { steps: seoStepsFor(mode) } : {})}
      />
      {live && !running && state.lastError ? (
        <LastError
          projectId={projectId}
          commandId={commandId}
          state={state}
          step={step}
          blocked={blocked}
        />
      ) : null}
      {nav.error ? (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--destructive)" }}
        >
          {nav.error}
        </p>
      ) : null}
      <div ref={bodyRef} tabIndex={-1} className="pt-1 outline-none">
        <LivePhaseProvider value={phase}>{body}</LivePhaseProvider>
      </div>
    </ActionCard>
  );
}

// Bir koşunun neden bittiği: sunucu en son hatayı karta yazar. Adımın kendi
// "Try again"i varsa (araştırma durduğunda Plan, yazım durduğunda Create)
// yalnız mesaj gösterilir; yoksa buradan yeniden denenir.
function stepRetriesItself(step: ModuleFlowCardData["step"], state: SeoState) {
  if (step === "create") return true;
  if (step !== "plan") return false;
  return seoModeOf(state) === "snippet" ? !state.snippet : !state.plan;
}

const RETRY = "retry";

function LastError({
  projectId,
  commandId,
  state,
  step,
  blocked,
}: {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  step: ModuleFlowCardData["step"];
  blocked: string | null;
}) {
  const error = state.lastError;
  const {
    onAct,
    busyId,
    error: retryError,
  } = useSeoStepAction({
    projectId,
    commandId,
    server: (_id, card) =>
      error
        ? retryRun(state, error.kind, card)
        : Promise.resolve({ ok: false as const, message: COPY.unavailable }),
  });
  if (!error) return null;
  const retry = !stepRetriesItself(step, state);
  return (
    <div
      role="alert"
      className="space-y-2 rounded-xl border px-3 py-2.5"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <p className="text-sm leading-5" style={{ color: "var(--ws-text)" }}>
        {error.message}
      </p>
      {retry ? (
        <CardActions
          buttons={[serverButton(RETRY, COPY.tryAgain, "secondary", blocked)]}
          onAct={onAct}
          busyId={busyId}
          error={retryError}
        />
      ) : null}
    </div>
  );
}
