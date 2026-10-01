import {
  CARDS_THAT_KEEP_TEXT,
  type IdeaEventCardData,
} from "@/types/idea-event-card";

import { pendingHintFor } from "./starter-cards";

// Whether the chat hides a message's text because a card says it instead.
// Outside a Work this is the old rule: every card kind except the ones in
// CARDS_THAT_KEEP_TEXT. Inside a Work a plan that carries `via` (a pick, an
// idea, a master or a slot-first card) is hidden too: its reply is a factual
// sentence for the model's memory and would sit above a card saying the same.
// A plan from propose_content_plan has no `via` and keeps its lead-in.
export function cardTextHidden(
  card: IdeaEventCardData | undefined,
  inWork: boolean,
): boolean {
  if (!card) return false;
  if (!CARDS_THAT_KEEP_TEXT.has(card.kind)) return true;
  return inWork && card.kind === "content-plan-draft" && card.via !== undefined;
}

// Which skeleton a Work turn shows before its card or text arrives; null once
// either exists (the real thing replaces the skeleton). `request` is the
// person's own message, which says what is being made.
export function pendingCard(message: {
  text: string;
  card?: unknown;
  request?: string;
}): "plan" | "ideas" | "generic" | null {
  if (message.card) return null;
  if (message.text.trim() !== "") return null;
  return pendingHintFor(message.request ?? message.text);
}

// Folds one streamed text delta into the turn's text. In a Work, text that
// arrives after a card whose words replace the reply is dropped, so the card
// does not sit under a sentence that says the same (no flicker).
export function appendStreamText(
  streamed: string,
  delta: string,
  card: IdeaEventCardData | undefined,
  inWork: boolean,
): string {
  return inWork && cardTextHidden(card, true) ? streamed : streamed + delta;
}
