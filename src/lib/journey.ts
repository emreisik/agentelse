import {
  CHANNELS,
  type ChannelKey,
  type PublishMode,
} from "@/lib/content-channels";
import type { WebsiteJourneyFacts } from "@/lib/website-analytics/health/view-types";
import { integrationsHref } from "@/lib/works/starter-cards";

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
  // The post this piece is a channel of (docs/works.md "Posts"); absent on
  // pieces saved before posts, each a post of its own.
  postId?: string;
};

// How many posts the items are: the channel pieces of one post count once.
export function postCountOf(items: readonly Pick<JourneyItem, "id" | "postId">[]): number {
  return new Set(items.map((item) => item.postId ?? item.id)).size;
}

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
  // True when the snapshot was read for one Work (only that Work's plans):
  // switches on the approve step and the visible connect step.
  workScoped?: boolean;
  // How many ideas wait in the idea pool (lib/idea-pool.ts): with no plan yet,
  // the chat offers to plan from them.
  ideaPool?: number;
  // Published plan pieces of the last 30 days the owner has not judged yet
  // ("Worked" / "Didn't work", lib/post-results.ts).
  awaitingVerdict?: number;
  // The weekly plan draft waiting in its own chat (weekly-plan-draft.ts), when
  // the snapshot was read from another chat.
  weeklyDraft?: { workId: string; count: number };
  // Work-scoped: this chat holds an unsaved plan draft.
  openDraftHere?: boolean;
  // GA-F3: Google Analytics bağlantısı ve ölçüm düzeltmesi (yalnız GA_HEALTH açıkken).
  website?: WebsiteJourneyFacts;
  // SC-F3: en yeni açık kritik arama sağlığı uyarısı ve kritik uyarı sayısı.
  searchCritical?: { alertId: string; title: string; count: number };
};

export type NextStepAction =
  // Produce the nearest week of a saved plan (the plan-run route).
  | { kind: "produce_plan"; planId: string; count: number }
  // Bring the pieces waiting for a decision into view.
  | { kind: "review_queue"; creativeId: string; count: number }
  // Approve the pieces in review in one go. Carries the ids the person SAW:
  // the server approves only those (never pieces that finished review later).
  | {
      kind: "approve_plan";
      planIds: string[];
      creativeIds: string[];
      count: number;
    }
  | { kind: "connect_channel"; channel: ChannelKey }
  | { kind: "enable_scheduled_publish"; count: number }
  // Approved pieces the client posts themselves, due today or earlier.
  | { kind: "publish_manual"; creativeIds: string[] }
  // Start the plan wizard for the next stretch.
  | { kind: "plan_next"; afterDate: string }
  // Ask the chat for a plan built from the idea pool; with an idea, a post
  // from that one idea (the Ideas panel's "Plan in chat").
  | {
      kind: "plan_from_ideas";
      count: number;
      idea?: { id: string; title: string };
    }
  // Open the chat that holds the weekly plan draft.
  | { kind: "open_weekly_draft"; workId: string; count: number }
  // What the measurement loop reported about published pieces.
  | { kind: "show_results"; count: number }
  // GA-F3: alan adı olan ama Google Analytics bağlamamış projeye sessiz öneri.
  | { kind: "connect_analytics" }
  // GA-F3: en önemli açık ölçüm sorunu; Website panelindeki kontrole gider.
  | { kind: "fix_tracking"; checkKey: string; href: string }
  // Open critical search health issue (SC-F3): the Search page's health section.
  | { kind: "fix_search_issue"; alertId: string; count: number };

export type NextStep = {
  key: string;
  // "blocker" = something is stuck or late; "next" = the natural next move.
  tone: "blocker" | "next";
  // Button text.
  label: string;
  // One line: what and why.
  title: string;
  action: NextStepAction;
  // Never blocks the plan and can stay true for weeks (an account that is not
  // connected): kept out of the chat bar, which only shows what is waiting.
  // The plan card and the calendar still show it.
  quiet?: boolean;
};

// One click produces at most this many pieces, all from the nearest days:
// image calls are slow and paid, and the request has a time limit.
export const MAX_PRODUCTION_BATCH = 7;
// Posts one "Produce" click makes: each costs one paid picture, its other
// formats are adaptations of it (plan-run.ts).
export const MAX_POSTS_PER_RUN = 3;

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
export function nextStepHref(
  projectId: string,
  step: NextStep,
  // A step that belongs to one Work carries its id, so the chat opens that
  // Work (the bare project URL starts a new chat, whose steps are empty) and
  // the integrations page can offer the way back.
  options?: { workId?: string },
): string {
  const action = step.action;
  const workId = options?.workId;
  switch (action.kind) {
    case "review_queue":
      return `/projects/${projectId}/takvim?creative=${action.creativeId}`;
    case "connect_channel":
      return workId
        ? integrationsHref(projectId, action.channel, { fromWorkId: workId })
        : `/projects/${projectId}/integrations`;
    case "open_weekly_draft":
      return `/projects/${projectId}?work=${encodeURIComponent(action.workId)}`;
    case "connect_analytics":
      return `/projects/${projectId}/integrations?integration=google_analytics`;
    case "fix_tracking":
      return action.href;
    case "fix_search_issue":
      return `/projects/${projectId}/arama?issue=${encodeURIComponent(action.alertId)}#health`;
    default:
      return workId
        ? `/projects/${projectId}?work=${encodeURIComponent(workId)}&next=${action.kind}`
        : `/projects/${projectId}?next=${action.kind}`;
  }
}

// The plan a next step is about, so a link to it can open the Work that holds
// that plan (the bare project URL starts a new chat, whose own journey is empty
// and would run nothing). The plan the step names; else the plan of the pieces
// it names; else the plan that ends last (the newest). Undefined without plans.
export function planIdOfStep(
  step: NextStep,
  items: readonly JourneyItem[],
): string | undefined {
  const action = step.action;
  if (action.kind === "produce_plan") return action.planId;
  if (action.kind === "approve_plan" && action.planIds[0]) {
    return action.planIds[0];
  }
  if (action.kind === "publish_manual") {
    const named = items.find((item) => action.creativeIds.includes(item.id));
    if (named) return named.planId;
  }
  const newest = [...items]
    .filter((item) => item.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return (newest ?? items[0])?.planId;
}

export const NEXT_STEP_KINDS: readonly NextStepAction["kind"][] = [
  "produce_plan",
  "review_queue",
  "approve_plan",
  "connect_channel",
  "enable_scheduled_publish",
  "publish_manual",
  "plan_next",
  "plan_from_ideas",
  "open_weekly_draft",
  "show_results",
  "connect_analytics",
  "fix_tracking",
];

// The kinds a `?next=` landing may run by itself. approve_plan decides on the
// person's behalf (an approval), so it only ever runs from a tap on the bar,
// never from a link that merely opens the chat.
export const AUTO_RUN_NEXT_KINDS: readonly NextStepAction["kind"][] =
  NEXT_STEP_KINDS.filter((kind) => kind !== "approve_plan");
