import {
  CHANNELS,
  type ChannelKey,
  type PublishMode,
} from "@/lib/content-channels";

// The shape of the "what is next" layer that walks a client from a saved
// content plan to published, measured content. Isomorphic (no server-only):
// the chat bar and the plan card import the types, the server computes them
// (src/server/agency/journey). Everything here is derived from real rows
// (Creative, Task, Approval, connections); nothing is stored.

// Where one planned piece stands. Derived, never stored, by plan-progress.ts.
export const PLAN_ITEM_STAGES = [
  "PLANNED", // a calendar slot with no content yet
  "PRODUCING", // a job for it is running
  "FAILED", // the last attempt failed and nothing else is running
  "IN_REVIEW", // content exists, waiting for the client's decision
  "REJECTED", // the client declined it
  "APPROVED", // approved, waiting for its publish moment
  "PUBLISHED",
] as const;
export type PlanItemStage = (typeof PLAN_ITEM_STAGES)[number];

export type JourneyItem = {
  id: string;
  // The Command row of the plan that drafted it (Creative.planId).
  planId: string;
  stage: PlanItemStage;
  channel?: ChannelKey;
  // The catalog's publish mode for its format ("manual" when unknown).
  publish: PublishMode;
  // Wall-clock day in the project's timezone (YYYY-MM-DD), "" when unscheduled.
  date: string;
  title: string;
  // The latest version's image, when it has one (the plan card's thumbnail).
  assetId?: string;
  // Only Instagram is published by the agency on its own today (see
  // autoPublishCreative); every other channel is a hand-off or a one-click
  // share the client makes.
  platform?: string;
};

// What the measurement loop reported about one published plan piece, in its
// own words (journey/results.ts). Never computed here.
export type JourneyResult = {
  creativeId: string;
  title: string;
  // "Instagram · Reel".
  where: string;
  // The check that reported ("24h engagement check").
  check: string;
  observation: string;
  checkedAt: string;
};

// What a snapshot needs to decide the next step; the loader
// (snapshot.ts) builds it, computeNextSteps (next-steps.ts) only reads it.
export type JourneySnapshot = {
  // The project's "today" (YYYY-MM-DD, its scheduling timezone).
  today: string;
  items: JourneyItem[];
  // Per planning channel: can the agency publish there right now?
  connections: Partial<Record<ChannelKey, { connected: boolean }>>;
  // An enabled Instagram publish schedule exists (Settings -> Publishing).
  publishScheduleEnabled: boolean;
  // Real measurement results for published plan pieces, newest first.
  results: JourneyResult[];
};

export type NextStepAction =
  // Produce the nearest week of a saved plan (the plan-run route).
  | { kind: "produce_plan"; planId: string; count: number }
  // Bring the pieces waiting for a decision into view.
  | { kind: "review_queue"; creativeId: string; count: number }
  | { kind: "connect_channel"; channel: ChannelKey }
  | { kind: "enable_scheduled_publish"; count: number }
  // Approved pieces the client posts themselves, due today or earlier.
  | { kind: "publish_manual"; creativeIds: string[] }
  // Start the plan wizard for the next stretch.
  | { kind: "plan_next"; afterDate: string }
  // What the measurement loop reported about published pieces.
  | { kind: "show_results"; count: number };

export type NextStep = {
  key: string;
  // "blocker" = something is stuck or late; "next" = the natural next move.
  tone: "blocker" | "next";
  // Button text.
  label: string;
  // One line: what and why.
  title: string;
  action: NextStepAction;
};

// One click produces at most this many pieces, all from the nearest days:
// image calls are slow and paid, and the request has a time limit.
export const MAX_PRODUCTION_BATCH = 7;

// A plan that ends within this many days gets its successor suggested.
export const PLAN_RUNWAY_DAYS = 3;

export function addDaysKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

// Whether the agency can publish this piece by itself: the catalog says
// "auto", the channel is connected, and autoPublishCreative can reach it
// (Instagram only). Anything else is the client's to post.
export function publishesItself(
  item: Pick<JourneyItem, "publish" | "channel" | "platform">,
  connections: JourneySnapshot["connections"],
): boolean {
  return (
    item.publish === "auto" &&
    item.platform === "INSTAGRAM" &&
    item.channel !== undefined &&
    connections[item.channel]?.connected === true
  );
}

export function channelLabel(channel: ChannelKey): string {
  return CHANNELS[channel].label;
}

// Which slots one "Save & produce" click makes: the producible ones (no
// content yet, or a failed attempt) of ONE plan, from its earliest day to six
// days later, at most MAX_PRODUCTION_BATCH. The next week is a next step of
// its own, which keeps the paid image calls and the request time bounded.
export function selectProductionBatch(
  items: readonly Pick<JourneyItem, "id" | "planId" | "stage" | "date">[],
  planId?: string,
  limit: number = MAX_PRODUCTION_BATCH,
): string[] {
  const producible = items
    .filter(
      (item) =>
        (item.stage === "PLANNED" || item.stage === "FAILED") &&
        (planId === undefined || item.planId === planId),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const first = producible[0];
  if (!first) return [];
  // The earliest plan wins when no plan is named, so the window never mixes
  // two plans.
  const owner = planId ?? first.planId;
  const windowEnd = first.date ? addDaysKey(first.date, 6) : undefined;
  return producible
    .filter(
      (item) => item.planId === owner && (!windowEnd || item.date <= windowEnd),
    )
    .slice(0, limit)
    .map((item) => item.id);
}

// Where a step leads from outside the chat (the calendar's banner). A step the
// chat itself has to run (producing, planning...) goes to the chat with
// `?next=<kind>`, which runs it once on landing; the rest are plain pages.
export function nextStepHref(projectId: string, step: NextStep): string {
  const action = step.action;
  switch (action.kind) {
    case "review_queue":
      return `/projects/${projectId}/takvim?creative=${action.creativeId}`;
    case "connect_channel":
      return `/projects/${projectId}/integrations`;
    default:
      return `/projects/${projectId}?next=${action.kind}`;
  }
}

export const NEXT_STEP_KINDS: readonly NextStepAction["kind"][] = [
  "produce_plan",
  "review_queue",
  "connect_channel",
  "enable_scheduled_publish",
  "publish_manual",
  "plan_next",
  "show_results",
];
