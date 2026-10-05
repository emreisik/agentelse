"use client";

import { AdPreviewCard } from "@/components/ads/ad-preview-card";
import { CardActions } from "@/components/works/card-actions";
import { assetUrl } from "@/lib/asset-url";
import { ADS_FLOW_COPY } from "@/lib/module-flows/ads/copy";
import {
  ADS_CTA_LABEL,
  ADS_OBJECTIVE_META,
  audienceLine,
  linkDomain,
  spendLine,
  type AdsBrief,
  type AdsPlan,
} from "@/lib/module-flows/ads/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  launchAdsAction,
  setAdsStepAction,
} from "@/server/actions/ads-flow-actions";

import type { StepActions } from "./parts";

// Steps 3 and 4. Create: the ad is the post's own picture with the Plan's text,
// the link and the button, shown as it will look in the feed. Review: what is
// spent and on whom, the ad again, and Launch.

const COPY = ADS_FLOW_COPY;

type StepProps = {
  projectId: string;
  commandId: string;
  brief: AdsBrief;
  plan: AdsPlan;
  gate: string | null;
  actions: StepActions;
  // The brand's name: the preview's Page when the connection gave none.
  brandName?: string;
};

export function AdPreview({
  brief,
  plan,
  brandName,
}: Pick<StepProps, "brief" | "plan" | "brandName">) {
  return (
    <AdPreviewCard
      pageName={brief.pageName ?? brandName ?? ""}
      message={plan.primaryText}
      link={brief.link}
      callToActionLabel={ADS_CTA_LABEL[brief.callToAction]}
      media={{
        kind: "single",
        imageUrl: assetUrl(brief.source.assetId, "card"),
      }}
    />
  );
}

function backButton(gate: string | null, id: string): CardButton {
  return {
    id,
    label: COPY.back,
    emphasis: "quiet",
    action: { kind: "server", id },
    disabledReason: gate ?? undefined,
  };
}

export function AdsCreateStep({
  projectId,
  commandId,
  brief,
  plan,
  gate,
  actions,
  brandName,
}: StepProps) {
  const buttons: CardButton[] = [
    backButton(gate, "create:back"),
    {
      id: "create:next",
      label: COPY.next,
      emphasis: "primary",
      action: { kind: "server", id: "create:next" },
      disabledReason: gate ?? undefined,
    },
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium" style={{ color: "var(--ws-text)" }}>
        {COPY.yourAd}
      </p>
      <AdPreview brief={brief} plan={plan} brandName={brandName} />
      <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
        {COPY.picture}
      </p>
      <CardActions
        buttons={buttons}
        busyId={actions.busyId}
        error={actions.error}
        onAct={(button) =>
          void actions.run(
            button.id,
            () =>
              setAdsStepAction(
                projectId,
                commandId,
                button.id === "create:back" ? "plan" : "review",
              ),
            { moves: true },
          )
        }
      />
    </div>
  );
}

export function AdsSummary({ brief, plan }: Pick<StepProps, "brief" | "plan">) {
  const objective = ADS_OBJECTIVE_META[brief.objective];
  const rows: [string, string][] = [
    [COPY.summary.goal, `${objective.label} · ${objective.goalLabel}`],
    [COPY.summary.budget, spendLine(brief)],
    [COPY.summary.audience, audienceLine(brief)],
    [
      COPY.summary.link,
      `${linkDomain(brief.link)} · ${ADS_CTA_LABEL[brief.callToAction]}`,
    ],
    [COPY.summary.post, brief.source.title],
    [
      COPY.summary.names,
      `${plan.campaignName} / ${plan.adSetName} / ${plan.adName}`,
    ],
  ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt
            className="text-xs leading-5"
            style={{ color: "var(--ws-text-2)" }}
          >
            {label}
          </dt>
          <dd className="break-words" style={{ color: "var(--ws-text)" }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AdsReviewStep({
  projectId,
  commandId,
  brief,
  plan,
  gate,
  actions,
  brandName,
}: StepProps) {
  const buttons: CardButton[] = [
    backButton(gate, "review:back"),
    {
      id: "review:launch",
      label: actions.busyId === "review:launch" ? COPY.launching : COPY.launch,
      emphasis: "primary",
      action: { kind: "server", id: "review:launch" },
      disabledReason: gate ?? undefined,
    },
  ];
  return (
    <div className="space-y-3">
      <AdsSummary brief={brief} plan={plan} />
      <AdPreview brief={brief} plan={plan} brandName={brandName} />
      <div className="space-y-1 text-xs" style={{ color: "var(--ws-text-2)" }}>
        <p>{COPY.safety}</p>
        <p>{COPY.noEndDate(brief.days)}</p>
      </div>
      <CardActions
        buttons={buttons}
        busyId={actions.busyId}
        error={actions.error}
        onAct={(button) =>
          button.id === "review:back"
            ? void actions.run(
                button.id,
                () => setAdsStepAction(projectId, commandId, "create"),
                { moves: true },
              )
            : void actions.run(
                button.id,
                () => launchAdsAction(projectId, commandId),
                { moves: true, announce: COPY.launched },
              )
        }
      />
    </div>
  );
}
