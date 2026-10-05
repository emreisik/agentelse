"use client";

import type { ReactNode } from "react";
import { Layers } from "lucide-react";

import { WsEventCard } from "@/components/commands/ws-event-card";
import { ModuleFlowCard } from "@/components/module-flows/module-flow-card";
import { useCardFocus } from "@/components/works/card-focus";
import { AdsInsightCard } from "@/components/works/ads-insight-card";
import { DailyBriefCard } from "@/components/works/daily-brief-card";
import { MasterContentCard } from "@/components/works/master-content-card";
import { IdeaOptionsCard } from "@/components/works/idea-options-card";
import { ContentPlanPane } from "@/components/works/plan-pane/plan-pane";
import { PlanOptionsCard } from "@/components/works/plan-options-card";
import { PaneCard } from "@/components/works/pane-card";
import { PlannedSlotCard } from "@/components/works/planned-slot-card";
import { SocialPostCard } from "@/components/works/social-post/social-post-card";
import type { WorkCardHostValue } from "@/components/works/work-card-host";
import { compactSpecOf, isSingleSlotPlan } from "@/lib/works/compact-card";
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
  "module-flow",
]);

// A long card is a compact card in the chat that opens it in the pane on the
// right (docs/works.md); a short one stays as it is. The wrapper is keyed by the
// card's Command, not by its kind: a card that changes in place (directions ->
// plan) keeps it, so an open pane follows the card instead of closing.
export function inPane(
  card: IdeaEventCardData,
  commandId: string | undefined,
  element: ReactNode,
  // Under the compact card, outside the pane (a plan's quick links).
  below?: ReactNode,
): ReactNode {
  const spec = compactSpecOf(card);
  if (!spec) {
    return below ? (
      <>
        {element}
        {below}
      </>
    ) : (
      element
    );
  }
  const id = commandId ?? spec.title;
  return (
    <PaneCard key={`pane-${id}`} cardId={id} spec={spec} below={below}>
      {element}
    </PaneCard>
  );
}

export function renderWorksCard(
  card: IdeaEventCardData,
  { commandId }: { commandId?: string; host: WorkCardHostValue },
): ReactNode | null {
  switch (card.kind) {
    case "content-plan-options":
      return inPane(
        card,
        commandId,
        <PlanOptionsCard
          key={commandId ?? card.title}
          card={card}
          commandId={commandId ?? card.title}
        />,
      );
    case "idea-options":
      return inPane(
        card,
        commandId,
        <IdeaOptionsCard
          key={commandId ?? card.title}
          card={card}
          commandId={commandId ?? card.title}
        />,
      );
    case "master-content":
      return inPane(
        card,
        commandId,
        <MasterContentCard
          key={commandId ?? card.title}
          card={card}
          commandId={commandId ?? card.title}
        />,
      );
    case "daily-brief":
      return <DailyBriefCard card={card} />;
    case "ads-insight":
      return inPane(card, commandId, <AdsInsightCard card={card} />);
    case "module-flow":
      return <ModuleFlowCard card={card} commandId={commandId} />;
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
  if (isSingleSlotPlan(card)) {
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
      <ContentPlanPane card={card} commandId={commandId} />
    </div>
  );
}

// Every finished piece in a Work is a social post card: approving, revising,
// publishing and sharing all happen inside it (social-post/social-post-card.tsx).
export function WorksCreativeCard({
  card,
}: {
  card: ReadyCard;
  host: WorkCardHostValue;
}) {
  const focusRef = useCardFocus(card.creativeId);
  return (
    <div ref={focusRef} tabIndex={-1} className="outline-none">
      <SocialPostCard card={card} />
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
