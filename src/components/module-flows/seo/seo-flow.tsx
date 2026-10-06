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
  seoOpenableSteps,
  seoRunActive,
  seoStatusOf,
} from "@/lib/module-flows/seo/state";
import { flowHintOf } from "@/lib/module-flows/card";
import { MODULES } from "@/lib/modules/catalog";
import { goToSeoStepAction } from "@/server/actions/seo-flow-actions";

import { BriefStep } from "./brief-step";
import { SEO_FLOW_COPY as COPY } from "./copy";
import { CreateStep } from "./create-step";
import { DeliverStep } from "./deliver-step";
import { useSeoStepAction } from "./parts";
import { PlanStep } from "./plan-step";
import { ReviewStep } from "./review-step";

// The SEO Manager flow card (docs/modules.md "SEO Manager"): Brief (topic,
// site, language) -> Plan (keyword research with web search, Search Console
// quick wins, an editable outline) -> Create (the article) -> Review (on-page
// checks, Rewrite) -> Publish (copy it out, the Content Calendar, "Mark as
// published"), on ONE card that changes in place. Every write is a server
// action (seo-flow-actions.ts) followed by a refresh. While a model call holds
// the card (another tab, a reload) the card says so and checks back on its
// own until it is done.

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

  // Someone else's model call (or one from before a reload): check back until
  // it lands. The tab that started it gets the answer with its own action.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, router]);

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

  const status = seoStatusOf(state);
  const common = { projectId, commandId, state, blocked, onMoving };
  let body: ReactNode;
  switch (step) {
    case "brief":
      body = <BriefStep {...common} defaultTopic={flowHintOf(card.data).topic} />;
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
      />
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
        {body}
      </div>
    </ActionCard>
  );
}
