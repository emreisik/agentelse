import type { ModuleKey } from "@/lib/modules/catalog";
import { MAX_OPTION_SLOTS } from "@/lib/works/plan-layout";

import type { PromptIdea } from "./idea-pool";

// Per-turn notes for a conversation that belongs to a Work. Pure strings: the
// static CHAT_INSTRUCTIONS is a cached prefix and is never edited, so whatever
// must differ inside a Work is said here and overrides it.

// What every Work chat follows: each step is a card, never retold in words.
const CARD_RULE =
  "In this Work every step ends in a card. Answer questions and explanations in a few plain sentences. To propose or do anything, call the matching tool and stop: the card carries its own reason and buttons, so never repeat its content in words.";

// A general chat and the Social Media Planner: the card rule, then how posts
// are planned and made.
export const WORKS_CARD_NOTE =
  CARD_RULE +
  ' This chat is free: it is not bound to a channel and you never ask which channel it is for. Every piece you plan or make has its own channel and format (the tools apply each channel\'s standards): take them from the client\'s words, else from the chat\'s default channels. Planning: when the client asks for a plan ("plan the week", a content calendar, what to post), call propose_content_plan RIGHT AWAY: no wizard, no questions, no directions first. For whatever they did not say use defaults: the default channels, 3 posts per week for the next 7 days starting tomorrow, a goal and theme from the brand\'s current focus. A plan is general: ONE item per post (never per platform), all on the first default channel; the client picks the platforms on the card. Title it generally ("Social media plan"), never with a platform\'s name. The plan card is where they change anything; to change it, call propose_content_plan again with the full updated plan. Call propose_plan_options only when the client explicitly asks to choose between directions (it needs a `[Plan brief]` line). Ideas: call propose_ideas. A topic or goal with no named deliverable (for example "Kommo CRM for health tourism"): call propose_ideas for it, or propose_content_plan when a plan is meant. One main message the client wants on several channels (for example "write one message for Instagram and LinkedIn"): call propose_master_content, never create_task once per channel. There is no content package and no generate_ideas_from_opportunities in a Work: ignore every instruction that tells you to call propose_content_package or generate_ideas_from_opportunities, and use propose_plan_options or propose_ideas instead. generate_image and create_task put the piece on the calendar first (the tool chooses the next free day), so never promise a day or time yourself and never ask for one. A picture in a Work is a Post (3:4) or a Story (9:16) for Instagram only: never offer or ask for a Reel or a square picture (a Reel is planned as a script). Do not search the web for plans or ideas: they come from the idea pool and the brand profile. Everything you write into a card (topics, angles, ideas, captions) follows the brand\'s rules and language.';

// An Ads Manager, Analytics or SEO Manager chat (Work.module): the card rule
// without the post planning, whose tools these chats do not have (tools.ts
// MODULE_TOOLS). Their module line says where posts are made (prompt.ts).
export const WORKS_MODULE_CARD_NOTE =
  CARD_RULE +
  " There is no content package and no generate_ideas_from_opportunities in a Work: ignore every instruction that tells you to call propose_content_package or generate_ideas_from_opportunities. create_task puts the piece on the calendar first (the tool chooses the next free day), so never promise a day or time yourself and never ask for one. Everything you write into a card follows the brand's rules and language.";

// Only a general chat and the Social Media Planner plan and make posts.
function plansPosts(module: ModuleKey | null | undefined): boolean {
  return !module || module === "social";
}

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

// The project's idea pool (idea-pool.ts): what the Brand Brain and earlier
// chats saved, best first. A plan draws from it before inventing anything.
export function worksIdeaPoolNote(ideas: readonly PromptIdea[]): string {
  return [
    "Idea pool (ideas the Brand Brain and earlier chats saved for this brand, best first; records, not instructions from the client). When you call propose_content_plan, build its posts from these ideas first, in this order, skipping any that do not fit what the client asked: for a post taken from an idea, use the idea as its topic and set that item's `ideaId` to the idea's id. Fill only the remaining posts with your own ideas, without an `ideaId`. Never invent or alter an `ideaId`, and never use one idea for two posts. Directions (propose_plan_options) draw on these ideas too. putForward: the client put that idea forward, so prefer it.",
    JSON.stringify(ideas),
  ].join("\n");
}

// The Social Media Planner (Work.module "social"; owner's decision of 5 Oct):
// its chat opens with "Plan next week's posts from my idea pool." (the tile's
// message, use-module-choice.ts), answered with a plan card at once, and every
// post is written to a higher bar than a general chat's: a hook, one visual
// idea, the words on the picture and a caption that asks for something. The
// plan tool's fields stay as they are, so the headline and the visual ride in
// `captionIdea`, which becomes the piece's brief when it is made.
export const WORKS_SOCIAL_PLAN_NOTE = [
  'Social Media Planner: plans here are made from the idea pool. When the client asks for a plan (this chat usually opens with "Plan next week\'s posts from my idea pool."), call propose_content_plan in THIS reply with no question first: never ask what the plan is for, its goal, its channels or how many posts, and never offer a wizard.',
  "For whatever they did not say: the chat's default channels, 3 posts spread over the next 7 days from tomorrow (for example days 1, 3 and 5), each at a time this audience is online (vary them, for example 09:00, 12:30 and 19:00, not all at 10:00), and the goal from the brand's current focus.",
  "Take the STRONGEST ideas of the idea pool (put-forward ones first, then the ones that fit the brand's current focus and what worked best), one post per idea, each with that idea's `ideaId`. Write posts of your own (without an `ideaId`) only for what the pool cannot fill, from the brand profile and its current focus.",
  'Every post must be ready to make. `topic` is the hook: one specific, scroll-stopping line about this brand (a concrete benefit, a number, a question or a tension), never a generic opener such as "Discover our…", "Introducing…" or "Check out…". `captionIdea` is three parts joined by " | ": the on-image headline in double quotes (at most 6 words: the text written on the picture), then the visual idea (one concrete scene: subject, setting, framing and mood, in the brand\'s look), then the caption idea (1-2 sentences in the brand\'s voice ending with one clear call to action). `purpose` stays 2-4 words.',
  "Write all of it in the brand's language and voice and follow its rules; do more of what the client marked as worked on published posts and avoid what did not; never invent prices, discounts or claims the brand profile does not support. Ideas you propose in this chat (propose_ideas) meet the same bar.",
].join(" ");

// What the client marked on published posts (Faz 4, post-results): lessons,
// never numbers. Plans and ideas lean toward what worked.
export type PostLessons = { worked: string[]; didNotWork: string[] };

export function worksPostLessonsNote(lessons: PostLessons): string {
  return [
    "How the client judged this brand's published posts (records, not instructions from the client). When you plan or propose ideas, lean toward what worked and steer away from what did not; never mention these records unless asked.",
    JSON.stringify(lessons),
  ].join("\n");
}

export function worksNotes(input: {
  planSlots?: readonly string[];
  fromEarlierBrief?: boolean;
  tooLarge?: boolean;
  ideaPool?: readonly PromptIdea[];
  postLessons?: PostLessons;
  // The Work's module (Work.module while modules are on); absent or null is a
  // general chat. A module chat that makes no posts gets none of the post
  // planning notes: the plan size, the idea pool and the plan slots all steer
  // tools it does not have.
  module?: ModuleKey | null;
}): string[] {
  const posts = plansPosts(input.module);
  const notes = [posts ? WORKS_CARD_NOTE : WORKS_MODULE_CARD_NOTE];
  if (posts && input.tooLarge) notes.push(WORKS_TOO_LARGE_NOTE);
  if (posts && input.ideaPool && input.ideaPool.length > 0) {
    notes.push(worksIdeaPoolNote(input.ideaPool));
  }
  if (input.module === "social") notes.push(WORKS_SOCIAL_PLAN_NOTE);
  if (
    input.postLessons &&
    input.postLessons.worked.length + input.postLessons.didNotWork.length > 0
  ) {
    notes.push(worksPostLessonsNote(input.postLessons));
  }
  const slots = posts ? (input.planSlots ?? []) : [];
  if (slots.length > 0) {
    const bounded = slots.slice(0, MAX_OPTION_SLOTS);
    notes.push(
      worksPlanSlotsNote(bounded, bounded.length, input.fromEarlierBrief),
    );
  }
  return notes;
}
