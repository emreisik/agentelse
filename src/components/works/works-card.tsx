"use client";

import type { ReactNode } from "react";
import { Layers } from "lucide-react";

import { CreativeCard } from "@/components/commands/creative-card";
import { ContentPlanCard } from "@/components/commands/content-plan-card";
import { WsEventCard } from "@/components/commands/ws-event-card";
import { useCardFocus } from "@/components/works/card-focus";
import { AdsInsightCard } from "@/components/works/ads-insight-card";
import { CreativePublishLine } from "@/components/works/creative-publish-line";
import { CreativeVariantsStrip } from "@/components/works/creative-variants-strip";
import { DailyBriefCard } from "@/components/works/daily-brief-card";
import { MasterContentCard } from "@/components/works/master-content-card";
import { IdeaOptionsCard } from "@/components/works/idea-options-card";
import { PlanCardExtras } from "@/components/works/plan-card-extras";
import { PlanOptionsCard } from "@/components/works/plan-options-card";
import { PlannedSlotCard } from "@/components/works/planned-slot-card";
import type { WorkCardHostValue } from "@/components/works/work-card-host";
import { copyText } from "@/lib/works/copy";
import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

// Kinds only a Work creates. Without a WorkCardHost (Works turned off after a
// rollback) they show a neutral card instead of an empty message.
export const WORKS_ONLY_KINDS: ReadonlySet<string> = new Set([
  "content-plan-options",
  "idea-options",
  "master-content",
  "daily-brief",
  "ads-insight",
]);

// A plan of one post that came straight from an idea, a brief, a suggestion
// or slot-first generation is shown as the compact planned-slot card.
const COMPACT_VIA: ReadonlySet<string> = new Set([
  "idea",
  "generate",
  "suggestion",
  "brief",
]);

export function renderWorksCard(
  card: IdeaEventCardData,
  { commandId }: { commandId?: string; host: WorkCardHostValue },
): ReactNode | null {
  switch (card.kind) {
    case "content-plan-options":
      return (
        <PlanOptionsCard
          key={commandId ?? card.title}
          card={card}
          commandId={commandId ?? card.title}
        />
      );
    case "idea-options":
      return (
        <IdeaOptionsCard
          key={commandId ?? card.title}
          card={card}
          commandId={commandId ?? card.title}
        />
      );
    case "master-content":
      return (
        <MasterContentCard
          key={commandId ?? card.title}
          card={card}
          commandId={commandId ?? card.title}
        />
      );
    case "daily-brief":
      return <DailyBriefCard card={card} />;
    case "ads-insight":
      return <AdsInsightCard card={card} />;
    default:
      return null;
  }
}

const MASTER_LINE_MAX = 140;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // Written with <= so the copy scan does not read the operator as a JSX tag.
  return flat.length <= MASTER_LINE_MAX
    ? flat
    : `${flat.slice(0, MASTER_LINE_MAX - 1)}…`;
}

export function WorksPlanCard({
  card,
  commandId,
}: {
  card: PlanCard;
  commandId?: string;
}) {
  // Called before the branch: hooks cannot be conditional.
  const focusRef = useCardFocus(commandId ?? "");
  if (card.items.length === 1 && card.via && COMPACT_VIA.has(card.via)) {
    return <PlannedSlotCard card={card} commandId={commandId} />;
  }
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      role="group"
      aria-label={card.title}
      data-card="content-plan-draft"
      data-card-id={commandId}
      className="outline-none"
    >
      {card.state === "saved" && card.master?.message ? (
        <p
          data-master-header
          className="mb-1.5 truncate px-0.5 text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          <span className="font-semibold">
            {copyText("master.messageLabel")}
          </span>
          {": "}
          {clip(card.master.message)}
        </p>
      ) : null}
      <ContentPlanCard
        card={card}
        commandId={commandId}
        aboveActions={<PlanCardExtras card={card} commandId={commandId} />}
      />
    </div>
  );
}

export function WorksCreativeCard({
  card,
}: {
  card: ReadyCard;
  host: WorkCardHostValue;
}) {
  const focusRef = useCardFocus(card.creativeId);
  return (
    <div ref={focusRef} tabIndex={-1} className="outline-none">
      <CreativeCard card={card} />
      {(card.alternatives?.length ?? 0) > 0 ||
      (card.status === "IN_REVIEW" && card.assetId && card.planId) ? (
        <CreativeVariantsStrip card={card} planCommandId={card.planId} />
      ) : null}
      <CreativePublishLine card={card} />
    </div>
  );
}

export function WorksFallbackCard({ card }: { card: IdeaEventCardData }) {
  return (
    <WsEventCard icon={Layers} title={copyText("kit.fallbackTitle")}>
      <p
        data-kind={card.kind}
        className="text-sm"
        style={{ color: "var(--ws-text-2)" }}
      >
        {copyText("kit.fallbackBody")}
      </p>
    </WsEventCard>
  );
}
