import "server-only";

import type { ChannelConnections, ChannelKey } from "@/lib/content-channels";
import {
  selectProductionBatch,
  type JourneySnapshot,
  type NextStep,
} from "@/lib/journey";
import { zonedDateTimeToUtc, utcToZonedDateTimeLocal } from "@/lib/timezone";
import { produceCostNote } from "@/lib/works/cost";
import type { BriefFacts } from "@/lib/works/daily-brief";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Small pieces of the project page's wave-2 work (Today brief, ads card,
// variant-aware next steps), kept out of page.tsx so they can be tested
// without rendering it.

// Creatives whose current card still carries unchosen alternatives. A bulk
// "Approve n" must leave them out: approving would silently lock a picture the
// person has not picked. An archived card is an older version of a piece and
// its alternatives no longer matter.
export function variantCreativeIds(
  cards: readonly (IdeaEventCardData | undefined)[],
): Set<string> {
  const ids = new Set<string>();
  for (const card of cards) {
    if (
      card?.kind === "creative-ready" &&
      card.status !== "ARCHIVED" &&
      (card.alternatives?.length ?? 0) > 0
    ) {
      ids.add(card.creativeId);
    }
  }
  return ids;
}

// The cost of the top step when it produces a plan: the very pieces the
// plan-run route would make (same batch rule), priced like the button says.
// Undefined for any other step and for a plan that makes no pictures.
export function nextStepCostNoteFor(
  journey: JourneySnapshot | null,
  steps: readonly NextStep[],
): string | undefined {
  const top = steps[0];
  if (!journey || !top || top.action.kind !== "produce_plan") return undefined;
  const ids = new Set(
    selectProductionBatch(journey.items, top.action.planId, top.action.count),
  );
  const pieces = journey.items
    .filter((item) => ids.has(item.id))
    .map((item) => ({ channel: item.channel }));
  return produceCostNote(pieces) ?? undefined;
}

export type BriefFactsInput = {
  projectId: string;
  today: string;
  timezone: string;
  now: Date;
  connections: ChannelConnections;
  hasAnalytics: boolean;
  extras: Pick<
    BriefFacts,
    "todayItems" | "yesterdayPublished" | "yesterdayFailed" | "shortlistedIdeas"
  >;
  // For Today this is the PROJECT-WIDE snapshot (Today is project-wide).
  journey: JourneySnapshot | null;
  nextSteps: readonly NextStep[];
  goalTitle?: string;
  channelsWithoutWork: readonly ChannelKey[];
};

// 'HH:mm' on the project's wall clock; "" when the zone cannot be read (the
// layout then falls back to the week plan).
function localTimeOf(now: Date, timezone: string): string {
  try {
    return utcToZonedDateTimeLocal(now, timezone).slice(11, 16);
  } catch {
    return "";
  }
}

export function briefFactsFor(input: BriefFactsInput): BriefFacts {
  // A quiet step (an account nobody asked to connect) is not "next".
  const steps = input.nextSteps.filter((step) => !step.quiet);
  const costNote = nextStepCostNoteFor(input.journey, steps);
  return {
    today: input.today,
    nowLocalTime: localTimeOf(input.now, input.timezone),
    projectId: input.projectId,
    connections: input.connections,
    hasAnalytics: input.hasAnalytics,
    todayItems: input.extras.todayItems,
    nextSteps: steps,
    ...(costNote ? { nextStepCostNote: costNote } : {}),
    yesterdayPublished: input.extras.yesterdayPublished,
    yesterdayFailed: input.extras.yesterdayFailed,
    ...(input.goalTitle ? { goalTitle: input.goalTitle } : {}),
    shortlistedIdeas: input.extras.shortlistedIdeas,
    channelsWithoutWork: input.channelsWithoutWork,
  };
}

// Start of a project-local day as an ISO instant: the createdAt of the live
// (never stored) turns, so they sort before the day's real ones.
export function dayStartIso(day: string, timezone: string): string {
  try {
    return zonedDateTimeToUtc(`${day}T00:00`, timezone).toISOString();
  } catch {
    return new Date(`${day}T00:00:00Z`).toISOString();
  }
}

// The approval a card already offers a decision for: a creative / task card
// carries it on the card, the ads card inside its proposal. The page drops the
// standalone decision turn of every id returned here.
export function approvalIdOfCard(
  card: IdeaEventCardData | undefined,
): string | undefined {
  if (!card) return undefined;
  if (card.kind === "ads-insight") return card.proposal?.approvalId;
  if ("approvalId" in card && card.approvalId) return card.approvalId;
  return undefined;
}
