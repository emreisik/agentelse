import {
  CHANNELS,
  resolveFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import type { PlanItemStage } from "@/lib/journey";
import { mondayOf, addDaysToKey } from "@/lib/content-plan-view";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// The social media plan pane's rules (docs/works.md), kept out of the
// components so each can be tested: which of the three steps a plan is at, where
// each post stands, and what a format means in plain words. Pure.

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

// ---- steps -----------------------------------------------------------------

export const PANE_STEPS = ["plan", "content", "publish"] as const;
export type PaneStep = (typeof PANE_STEPS)[number];
export type StepState = "done" | "current" | "todo";

export type PaneProgress = {
  // Still a draft: nothing is made yet.
  draft: boolean;
  // Pieces of a saved plan (an archived one is out of the count).
  total: number;
  // Waiting to be made: no content yet, or the last attempt failed.
  producible: number;
  // Being made right now.
  making: number;
  // Content that waits for a decision.
  ready: number;
  // Decided: approved (it waits for its time) or already out.
  approved: number;
  // Every piece is approved or published: nothing is left to decide.
  allApproved: boolean;
};

export function progressOf(card: PlanCard): PaneProgress {
  if (card.state !== "saved" || !card.slots) {
    return {
      draft: card.state !== "saved",
      total: 0,
      producible: 0,
      making: 0,
      ready: 0,
      approved: 0,
      allApproved: false,
    };
  }
  const count = (...stages: PlanItemStage[]) =>
    card.slots!.filter((slot) => slot && stages.includes(slot.stage)).length;
  const total = card.slots.filter(Boolean).length;
  const approved = count("APPROVED", "PUBLISHED");
  return {
    draft: false,
    total,
    producible: count("PLANNED", "FAILED"),
    making: count("PRODUCING"),
    ready: count("IN_REVIEW"),
    approved,
    allApproved: total > 0 && approved === total,
  };
}

// The step the plan is at on its own: ideas while it is a draft, content once it
// is saved, and the last one when everything is decided.
export function stepOf(progress: PaneProgress): PaneStep {
  if (progress.draft) return "plan";
  return progress.allApproved ? "publish" : "content";
}

// Publishing can be planned once something waits for a decision and nothing is
// being made at this moment.
export function canPlanPublishing(progress: PaneProgress): boolean {
  return !progress.draft && progress.ready > 0 && progress.making === 0;
}

export function canOpenStep(step: PaneStep, progress: PaneProgress): boolean {
  if (step === "plan") return true;
  if (progress.draft) return false;
  if (step === "content") return true;
  return progress.allApproved || canPlanPublishing(progress);
}

// One state per step: the open one is current, the ones before the furthest
// reached are done; when everything is decided all three are done.
export function stepStates(
  shown: PaneStep,
  progress: PaneProgress,
): Record<PaneStep, StepState> {
  if (progress.allApproved) {
    return { plan: "done", content: "done", publish: "done" };
  }
  const furthest = Math.max(
    PANE_STEPS.indexOf(stepOf(progress)),
    PANE_STEPS.indexOf(shown),
  );
  const states = {} as Record<PaneStep, StepState>;
  PANE_STEPS.forEach((step, index) => {
    states[step] =
      step === shown ? "current" : index < furthest ? "done" : "todo";
  });
  return states;
}

// ---- where a post stands -----------------------------------------------------

export type PostState =
  | "idea"
  | "needs"
  | "making"
  | "ready"
  | "failed"
  | "declined"
  | "scheduled"
  | "published";

// The state of a post from the stages of its pieces (one per platform). Not all
// made: it needs content; a piece being made or failed shows first.
export function postStateOf(
  stages: readonly (PlanItemStage | null | undefined)[],
): PostState {
  const known = stages.filter((stage): stage is PlanItemStage => !!stage);
  if (known.length === 0) return "idea";
  const has = (stage: PlanItemStage) => known.includes(stage);
  if (has("PRODUCING")) return "making";
  if (has("FAILED")) return "failed";
  if (has("PLANNED")) return "needs";
  if (has("REJECTED")) return "declined";
  if (has("IN_REVIEW")) return "ready";
  return known.every((stage) => stage === "PUBLISHED")
    ? "published"
    : "scheduled";
}

// ---- a post's pieces ---------------------------------------------------------

export type PieceView = {
  // Position in the card's items.
  index: number;
  channel: ChannelKey;
  formatKey?: string;
  creativeId?: string;
  stage?: PlanItemStage;
  assetId?: string;
  text?: string;
  // "YYYY-MM-DDTHH:mm" in the plan's zone.
  when?: string;
};

type PlanItem = PlanCard["items"][number];

export function pieceOf(
  card: PlanCard,
  item: PlanItem,
  index: number,
  channel: ChannelKey,
): PieceView {
  const slot = card.slots?.[index] ?? undefined;
  return {
    index,
    channel,
    formatKey: item.formatKey,
    ...(slot
      ? {
          creativeId: slot.id,
          stage: slot.stage,
          assetId: slot.assetId,
          text: slot.text,
          when: slot.when,
        }
      : {}),
  };
}

// ---- formats in plain words ----------------------------------------------------

// "Carousel · 4:5", "Story · 9:16", "Post": the format and, for a picture or a
// video, its shape.
export function formatLineOf(channel: ChannelKey, formatKey?: string): string {
  const format = formatKey ? resolveFormat(channel, formatKey) : undefined;
  const def = format ?? CHANNELS[channel].formats[0];
  if (!def) return CHANNELS[channel].label;
  const ratio = def.contentFormat
    ? getCreativePlatformFormat(CHANNELS[channel].platform, def.contentFormat)
        .aspectRatio
    : undefined;
  return ratio ? `${def.label} · ${ratio}` : def.label;
}

// How a post of each format is made, in the words of what is produced (the
// image formats a picture with a caption, the others written text).
const APPROACH: Readonly<Record<string, string>> = {
  "instagram.post":
    "One picture with a caption that opens on the hook, made for the feed.",
  "instagram.carousel":
    "A cover picture for the carousel; the caption lists the slides.",
  "instagram.reel":
    "A reel script: the hook for the first seconds, scene by scene, with on-screen text.",
  "instagram.story":
    "One vertical picture with a short caption, made for stories.",
  "tiktok.video":
    "A video concept: the hook for the first 2 seconds, a short script, on-screen text and a caption.",
  "linkedin.post":
    "A written post: a strong first line, short paragraphs and one concrete insight.",
  "x.post": "One idea in at most 280 characters.",
  "x.thread": "A thread of 5-7 numbered posts; the first is the hook.",
};

export function approachOf(
  channel: ChannelKey,
  formatKey?: string,
): string | undefined {
  const key = formatKey ?? CHANNELS[channel].formats[0]?.key;
  return key ? APPROACH[key] : undefined;
}

// ---- dates -------------------------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function partsOf(day: string) {
  const match = DAY_RE.exec(day);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? { year: match[1]!, month, day: Number(match[3]) } : null;
}

// "Oct 5 – 11, 2026", "Oct 29 – Nov 4, 2026", "Oct 5, 2026"; "" without a day.
export function rangeLabel(days: readonly string[]): string {
  const valid = days.filter((day) => DAY_RE.test(day)).sort();
  const first = partsOf(valid[0] ?? "");
  const last = partsOf(valid.at(-1) ?? "");
  if (!first || !last) return "";
  if (valid[0] === valid.at(-1)) {
    return `${first.month} ${first.day}, ${first.year}`;
  }
  if (first.year !== last.year) {
    return `${first.month} ${first.day}, ${first.year} – ${last.month} ${last.day}, ${last.year}`;
  }
  return first.month === last.month
    ? `${first.month} ${first.day} – ${last.day}, ${last.year}`
    : `${first.month} ${first.day} – ${last.month} ${last.day}, ${last.year}`;
}

// The weekday of a day, Monday first ("Mon"), and its number ("05").
export function weekdayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const index = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
  return WEEKDAYS[index] ?? "";
}

export function dayNumberOf(day: string): string {
  return day.slice(8, 10);
}

// The seven days of the week a day is in, Monday first.
export function weekDays(day: string): string[] {
  const start = mondayOf(day);
  return Array.from({ length: 7 }, (_, offset) => addDaysToKey(start, offset));
}

// "Europe/Istanbul" -> "Istanbul".
export function zoneName(timezone: string | undefined): string {
  const city = timezone?.split("/").at(-1);
  return city ? city.replace(/_/g, " ") : "";
}

// "Fri, 3 Oct": a post's day in the pane (no Date object in the plan's zone: a
// calendar day has none).
export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

// Today's date in the plan's own zone, as YYYY-MM-DD.
export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// The times offered when a post moves (its own time is offered too).
export const MOVE_TIMES = [
  "09:00",
  "11:00",
  "13:00",
  "15:00",
  "18:00",
  "20:00",
] as const;
// The calendar reads a plan up to this far ahead (validatePlanDates).
export const MAX_DAYS_AHEAD = 60;

// ---- a new idea for a post -----------------------------------------------------

export type SuggestionStep =
  // Show the idea at this place of the post's other ideas.
  | { kind: "show"; alt: number }
  // The post has run out: ask for more (a paid round), then show this place.
  | { kind: "generate"; showAlt: number };

// What a tap on "New idea" does. Each tap moves on to the next of the ideas the
// post already has; past the last it asks for more while that is still allowed,
// else it starts over. Null: there is nothing to show and nothing to ask for.
export function nextSuggestion(input: {
  // How many other ideas the post has.
  pool: number;
  // The one being shown now, if any.
  current: number | null;
  // More may still be asked for (room in the post and a paid round left).
  canGenerate: boolean;
}): SuggestionStep | null {
  const { pool, current, canGenerate } = input;
  if (pool === 0) return canGenerate ? { kind: "generate", showAlt: 0 } : null;
  const next = current === null ? 0 : current + 1;
  if (next < pool) return { kind: "show", alt: next };
  return canGenerate
    ? { kind: "generate", showAlt: pool }
    : { kind: "show", alt: 0 };
}
