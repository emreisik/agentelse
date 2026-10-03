import { MAX_OPTION_SLOTS } from "@/lib/works/plan-layout";

// Per-turn notes for a conversation that belongs to a Work. Pure strings: the
// static CHAT_INSTRUCTIONS is a cached prefix and is never edited, so whatever
// must differ inside a Work is said here and overrides it.

export const WORKS_CARD_NOTE =
  "In this Work every step ends in a card. Answer questions and explanations in a few plain sentences. To propose or do anything, call the matching tool and stop: the card carries its own reason and buttons, so never repeat its content in words. This chat is free: it is not bound to a channel and you never ask which channel it is for. Every piece you plan or make has its own channel and format (the tools apply each channel's standards): take them from the client's words, else from the chat's default channels. Planning: when the client asks for a plan (\"plan the week\", a content calendar, what to post), call propose_content_plan RIGHT AWAY: no wizard, no questions, no directions first. For whatever they did not say use defaults: the default channels, 3 posts per week for the next 7 days starting tomorrow, a goal and theme from the brand's current focus. A plan is general: ONE item per post (never per platform), all on the first default channel; the client picks the platforms on the card. Title it generally (\"Social media plan\"), never with a platform's name. The plan card is where they change anything; to change it, call propose_content_plan again with the full updated plan. Call propose_plan_options only when the client explicitly asks to choose between directions (it needs a `[Plan brief]` line). Ideas: call propose_ideas. A topic or goal with no named deliverable (for example \"Kommo CRM for health tourism\"): call propose_ideas for it, or propose_content_plan when a plan is meant. One main message the client wants on several channels (for example \"write one message for Instagram and LinkedIn\"): call propose_master_content, never create_task once per channel. There is no content package and no generate_ideas_from_opportunities in a Work: ignore every instruction that tells you to call propose_content_package or generate_ideas_from_opportunities, and use propose_plan_options or propose_ideas instead. generate_image and create_task put the piece on the calendar first (the tool chooses the next free day), so never promise a day or time yourself and never ask for one. A picture in a Work is a Post (3:4) or a Story (9:16) for Instagram only: never offer or ask for a Reel or a square picture (a Reel is planned as a script). Do not search the web for plans or ideas: they come from the brand profile. Everything you write into a card (topics, angles, ideas, captions) follows the brand's rules and language.";

export function worksPlanSlotsNote(
  lines: readonly string[],
  ideasPerOption: number,
  fromEarlierBrief = false,
): string {
  const head = fromEarlierBrief
    ? "Slots for the plan brief of earlier in this Work (the server fixed the days, rolled forward to today; one idea per slot, in this order):"
    : "Slots for this brief (the server fixed the days; one idea per slot, in this order):";
  const numbered = lines
    .slice(0, MAX_OPTION_SLOTS)
    .map((line, index) => `${index + 1}. ${line}`);
  return [
    head,
    ...numbered,
    `Each option needs exactly ${ideasPerOption} ideas, in this order.`,
  ].join("\n");
}

// A brief with more posts than the directions card can carry: said up front,
// so the model does not write three options and only then learn it was wasted.
export const WORKS_TOO_LARGE_NOTE = `This [Plan brief] has more than ${MAX_OPTION_SLOTS} posts, too many for directions: do not call propose_plan_options for it. Call propose_content_plan with the full plan instead.`;

export function worksNotes(input: {
  planSlots?: readonly string[];
  fromEarlierBrief?: boolean;
  tooLarge?: boolean;
}): string[] {
  const notes = [WORKS_CARD_NOTE];
  if (input.tooLarge) notes.push(WORKS_TOO_LARGE_NOTE);
  const slots = input.planSlots ?? [];
  if (slots.length > 0) {
    const bounded = slots.slice(0, MAX_OPTION_SLOTS);
    notes.push(
      worksPlanSlotsNote(bounded, bounded.length, input.fromEarlierBrief),
    );
  }
  return notes;
}
