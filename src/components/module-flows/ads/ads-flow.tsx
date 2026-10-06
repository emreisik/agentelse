"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import type { WsTone } from "@/components/commands/ws-event-card";
import { FlowStepper } from "@/components/modules/flow-stepper";
import { MODULE_ICONS } from "@/components/modules/module-icon";
import { ActionCard } from "@/components/works/action-card";
import { useCardFocus } from "@/components/works/card-focus";
import {
  disabledReasonOf,
  useWorkCardHost,
  type WorkCardHostValue,
} from "@/components/works/work-card-host";
import {
  approvalLinkOf,
  isChainMoving,
  type AdsChain,
} from "@/lib/module-flows/ads/chain";
import { ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import {
  parseAdsFlowState,
  viewStepOf,
  type AdsBriefOptions,
} from "@/lib/module-flows/ads/state";
import {
  MODULE_FLOW_STEPS,
  type ModuleFlowCardData,
  type ModuleFlowStep,
} from "@/lib/module-flows/card";
import {
  draftAdsPlanAction,
  saveAdsBriefAction,
  setAdsStepAction,
} from "@/server/actions/ads-flow-actions";

import { AdsCreateStep, AdsReviewStep } from "./ad-steps";
import { AdsBriefStep } from "./brief-step";
import { AdsLaunchStep, useAdsChain } from "./launch-step";
import { useStepActions } from "./parts";
import { AdsPlanStep, type PlanDraftState } from "./plan-step";

// The Ads Manager flow card (docs/modules.md "Ads Manager"): Brief -> Plan ->
// Create -> Review -> Launch on ONE card that changes in place, in the Works
// card look. Meta now, Google Ads later. Every step has one primary button;
// Back works until the launch, after which the card follows the campaign, the
// ad set and the ad as they are created (paused) in Meta.

const COPY = ADS_FLOW_COPY;

export const ADS_STATUS: Readonly<
  Record<
    "approval" | "working" | "created" | "stopped" | "live" | "discarded",
    { label: string; tone: WsTone }
  >
> = {
  approval: { label: "Waiting for you", tone: "waiting" },
  working: { label: "Creating…", tone: "waiting" },
  created: { label: "Created, paused", tone: "positive" },
  stopped: { label: "Stopped", tone: "danger" },
  live: { label: "Live", tone: "positive" },
  discarded: { label: "Discarded", tone: "neutral" },
};

function statusOf(
  chain: AdsChain | null,
  complete: boolean,
): { label: string; tone: WsTone } | undefined {
  if (chain?.v2?.live) return ADS_STATUS.live;
  if (chain?.v2?.status === "DISCARDED") return ADS_STATUS.discarded;
  if (complete) return ADS_STATUS.created;
  if (!chain) return undefined;
  if (chain.stopped) return ADS_STATUS.stopped;
  if (approvalLinkOf(chain)) return ADS_STATUS.approval;
  return isChainMoving(chain) ? ADS_STATUS.working : undefined;
}

export function AdsFlow({
  card,
  commandId,
}: {
  card: ModuleFlowCardData;
  commandId?: string;
}) {
  const host = useWorkCardHost();
  if (!host) return null;
  return <AdsFlowCard card={card} commandId={commandId} host={host} />;
}

export function AdsFlowCard({
  card,
  commandId,
  host,
  initial,
}: {
  card: ModuleFlowCardData;
  commandId?: string;
  host: WorkCardHostValue;
  // Already read (tests); otherwise each step reads what it needs.
  initial?: { options?: AdsBriefOptions; chain?: AdsChain };
}) {
  const router = useRouter();
  const id = commandId ?? "";
  const state = parseAdsFlowState(card.data);
  const step = viewStepOf(card.step, state);
  // A card without its Command cannot be written to.
  const gate = commandId
    ? disabledReasonOf(host, { kind: "server" })
    : COPY.failed;
  const actions = useStepActions(id);
  const [draft, setDraft] = useState<PlanDraftState>({ status: "idle" });
  const read = useAdsChain({
    projectId: host.projectId,
    commandId: id,
    enabled: step === "deliver" && Boolean(commandId),
    initial: initial?.chain,
  });
  const focusRef = useCardFocus(id);
  const complete =
    Boolean(state.launch?.completedAt) || Boolean(read.chain?.complete);

  // The AI writes the ad on the Plan; one write at a time (a ref, not the
  // rendered state, so a quick second tap never starts another).
  const drafting = useRef(false);
  const draftPlan = async (regenerate: boolean) => {
    if (drafting.current || gate) return;
    drafting.current = true;
    setDraft({ status: "drafting" });
    try {
      const result = await draftAdsPlanAction(host.projectId, id, {
        regenerate,
      });
      if (result.ok) {
        setDraft({ status: "idle" });
        host.announce(COPY.planReady);
      } else {
        setDraft({ status: "idle", message: result.message });
      }
    } catch {
      setDraft({ status: "idle", message: COPY.failed });
    } finally {
      drafting.current = false;
    }
    router.refresh();
  };

  // Brief -> Plan: the Plan opens already saying the ad is being written,
  // then the AI writes it (unless the brief kept an ad written before).
  const saveBrief = async (input: unknown) => {
    setDraft({ status: "drafting" });
    const saved = await actions.run(
      "brief:next",
      () => saveAdsBriefAction(host.projectId, id, input),
      { moves: true },
    );
    if (!saved || saved.hasPlan) {
      setDraft({ status: "idle" });
      return;
    }
    await draftPlan(false);
  };

  // A done step before the launch opens again from the stepper.
  const at = MODULE_FLOW_STEPS.indexOf(step);
  const openable: Partial<Record<ModuleFlowStep, boolean>> = {};
  if (!state.launch && !gate) {
    for (const key of MODULE_FLOW_STEPS) {
      if (key !== "deliver" && MODULE_FLOW_STEPS.indexOf(key) < at) {
        openable[key] = true;
      }
    }
  }
  const pick = (target: ModuleFlowStep) => {
    if (!openable[target]) return;
    void actions.run(
      `step:${target}`,
      () => setAdsStepAction(host.projectId, id, target),
      { moves: true },
    );
  };

  const brandName = host.projectName;
  let body: ReactNode;
  if (step === "brief") {
    body = (
      <AdsBriefStep
        projectId={host.projectId}
        commandId={id}
        state={state}
        gate={gate}
        actions={actions}
        initialOptions={initial?.options}
        onNext={(input) => void saveBrief(input)}
      />
    );
  } else if (step === "plan" && state.brief) {
    body = (
      <AdsPlanStep
        projectId={host.projectId}
        commandId={id}
        brief={state.brief}
        plan={state.plan}
        draft={draft}
        gate={gate}
        actions={actions}
        onDraft={(regenerate) => void draftPlan(regenerate)}
      />
    );
  } else if (step === "create" && state.brief && state.plan) {
    body = (
      <AdsCreateStep
        projectId={host.projectId}
        commandId={id}
        brief={state.brief}
        plan={state.plan}
        gate={gate}
        actions={actions}
        brandName={brandName}
      />
    );
  } else if (step === "review" && state.brief && state.plan) {
    body = (
      <AdsReviewStep
        projectId={host.projectId}
        commandId={id}
        brief={state.brief}
        plan={state.plan}
        gate={gate}
        actions={actions}
        brandName={brandName}
      />
    );
  } else if (step === "deliver") {
    body = (
      <AdsLaunchStep
        projectId={host.projectId}
        commandId={id}
        read={read}
        gate={gate}
        actions={actions}
      />
    );
  }

  return (
    <ActionCard
      icon={MODULE_ICONS.ads}
      title={card.title}
      width="wide"
      cardId="module-flow"
      commandId={commandId}
      status={step === "deliver" ? statusOf(read.chain, complete) : undefined}
    >
      <FlowStepper
        module="ads"
        current={step}
        complete={complete}
        openable={openable}
        onPick={pick}
      />
      <div
        key={step}
        ref={focusRef}
        tabIndex={-1}
        data-ads-step={step}
        className="pt-1 outline-none"
      >
        {body}
      </div>
    </ActionCard>
  );
}
