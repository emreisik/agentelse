"use client";

import { useId, useState } from "react";

import { CardActions } from "@/components/works/card-actions";
import { ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import {
  ADS_LIMITS,
  defaultAdsPlan,
  planIssue,
  type AdsBrief,
  type AdsPlan,
  type AdsPlanInput,
} from "@/lib/module-flows/ads/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  saveAdsPlanAction,
  setAdsStepAction,
} from "@/server/actions/ads-flow-actions";

import {
  FIELD_CLASS,
  FIELD_STYLE,
  LoadingLine,
  Section,
  type StepActions,
} from "./parts";

// Step 2, Plan: the campaign, ad set and ad names and the ad's primary text,
// written by the AI from the post (or the post's own words until it has), all
// editable. Next keeps what is on screen.

const COPY = ADS_FLOW_COPY;

export type PlanDraftState = {
  status: "idle" | "drafting";
  // Why the last AI write did not happen.
  message?: string;
};

const FIELDS = [
  ["campaignName", COPY.campaignName],
  ["adSetName", COPY.adSetName],
  ["adName", COPY.adName],
] as const;

export function AdsPlanStep({
  projectId,
  commandId,
  brief,
  plan,
  draft,
  gate,
  actions,
  onDraft,
}: {
  projectId: string;
  commandId: string;
  brief: AdsBrief;
  plan?: AdsPlan;
  draft: PlanDraftState;
  gate: string | null;
  actions: StepActions;
  onDraft: (regenerate: boolean) => void;
}) {
  if (draft.status === "drafting") {
    return <LoadingLine className="py-3">{COPY.drafting}</LoadingLine>;
  }
  // A new stored plan (written by the AI) starts the fields again.
  const key = plan
    ? `${plan.campaignName}|${plan.adSetName}|${plan.adName}|${plan.primaryText}`
    : "post";
  return (
    <PlanForm
      key={key}
      projectId={projectId}
      commandId={commandId}
      brief={brief}
      plan={plan}
      draft={draft}
      gate={gate}
      actions={actions}
      onDraft={onDraft}
    />
  );
}

function PlanForm({
  projectId,
  commandId,
  brief,
  plan,
  draft,
  gate,
  actions,
  onDraft,
}: {
  projectId: string;
  commandId: string;
  brief: AdsBrief;
  plan?: AdsPlan;
  draft: PlanDraftState;
  gate: string | null;
  actions: StepActions;
  onDraft: (regenerate: boolean) => void;
}) {
  const baseId = useId();
  const [values, setValues] = useState<AdsPlanInput>(() => {
    const start = plan ?? defaultAdsPlan(brief);
    return {
      campaignName: start.campaignName,
      adSetName: start.adSetName,
      adName: start.adName,
      primaryText: start.primaryText,
    };
  });
  const set = (field: keyof AdsPlanInput, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));
  const issue = planIssue(values);
  const textId = `${baseId}-text`;
  const flags =
    plan?.flags?.length && plan.primaryText === values.primaryText
      ? plan.flags
      : [];

  const buttons: CardButton[] = [
    {
      id: "plan:back",
      label: COPY.back,
      emphasis: "quiet",
      action: { kind: "server", id: "plan:back" },
      disabledReason: gate ?? undefined,
    },
    {
      id: "plan:write",
      label: plan ? COPY.rewrite : COPY.write,
      emphasis: "secondary",
      action: { kind: "server", id: "plan:write" },
      disabledReason: gate ?? undefined,
    },
    {
      id: "plan:next",
      label: COPY.next,
      emphasis: "primary",
      action: { kind: "server", id: "plan:next" },
      disabledReason: gate ?? issue ?? undefined,
    },
  ];

  const onAct = (button: CardButton) => {
    if (button.id === "plan:back") {
      void actions.run(
        button.id,
        () => setAdsStepAction(projectId, commandId, "brief"),
        { moves: true },
      );
    } else if (button.id === "plan:write") {
      actions.clearError();
      onDraft(Boolean(plan));
    } else if (button.id === "plan:next") {
      void actions.run(
        button.id,
        () => saveAdsPlanAction(projectId, commandId, values),
        { moves: true },
      );
    }
  };

  return (
    <div className="space-y-4">
      {draft.message ? (
        <p role="alert" className="text-xs" style={{ color: "var(--ws-text)" }}>
          {draft.message}
        </p>
      ) : !plan ? (
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {COPY.notDrafted}
        </p>
      ) : null}

      {/* The campaign's name on its own row; the ad set's and the ad's share
          one from the small breakpoint up. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map(([field, label]) => {
          const id = `${baseId}-${field}`;
          return (
            <div
              key={field}
              className={field === "campaignName" ? "sm:col-span-2" : undefined}
            >
              <Section label={label} htmlFor={id}>
                <input
                  id={id}
                  value={values[field]}
                  maxLength={ADS_LIMITS.name}
                  onChange={(event) => set(field, event.target.value)}
                  className={FIELD_CLASS}
                  style={FIELD_STYLE}
                />
              </Section>
            </div>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label
            htmlFor={textId}
            className="text-xs font-medium"
            style={{ color: "var(--ws-text-2)" }}
          >
            {COPY.primaryText}
          </label>
          <span
            className="text-[11px] tabular-nums"
            style={{ color: "var(--ws-text-2)" }}
          >
            {COPY.characters(values.primaryText.length, ADS_LIMITS.primaryText)}
          </span>
        </div>
        <textarea
          id={textId}
          rows={3}
          value={values.primaryText}
          maxLength={ADS_LIMITS.primaryText}
          onChange={(event) => set("primaryText", event.target.value)}
          className={`${FIELD_CLASS} resize-y leading-relaxed`}
          style={FIELD_STYLE}
        />
        {flags.length > 0 ? (
          <p className="text-xs" style={{ color: "var(--ws-text)" }}>
            {COPY.flagged(flags)}
          </p>
        ) : null}
      </div>

      <CardActions
        buttons={buttons}
        busyId={actions.busyId}
        error={actions.error}
        onAct={onAct}
      />
    </div>
  );
}
