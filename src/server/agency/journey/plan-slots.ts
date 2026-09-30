import type { JourneyItem } from "@/lib/journey";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// A saved plan card is a plan; how far each of its pieces has got is whatever
// the calendar says today. The page calls this on the cards it renders, with
// the stages the journey snapshot already derived, so the stored card never
// carries (and never goes stale on) progress. Only a SAVED plan has slots.
export function withPlanSlots(
  card: IdeaEventCardData | undefined,
  byCreativeId: ReadonlyMap<string, Pick<JourneyItem, "stage" | "assetId">>,
): IdeaEventCardData | undefined {
  if (
    card?.kind !== "content-plan-draft" ||
    card.state !== "saved" ||
    !card.savedCreativeIds
  ) {
    return card;
  }
  return {
    ...card,
    slots: card.savedCreativeIds.map((id) => {
      const item = byCreativeId.get(id);
      return item ? { id, stage: item.stage, assetId: item.assetId } : null;
    }),
  };
}
