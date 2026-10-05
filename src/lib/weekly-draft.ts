// The weekly plan draft (Faz 4, docs/brand-brain-loop.md): every Sunday evening
// in the project's timezone Agentelse drafts next week's posts from the idea
// pool, in a chat of its own, for the owner to review and save. Nothing is
// saved, made or published before that. Pure and isomorphic.

import { addDaysToKey } from "@/lib/content-plan-view";

// The draft is made from this local time on Sunday until the day ends.
export const WEEKLY_DRAFT_HOUR = 18;
// Posts per week (the chat's default too).
export const WEEKLY_DRAFT_POSTS = 3;

export const WEEKLY_WORK_PREFIX = "wkplan_";
const WEEKLY_COMMAND_PREFIX = "wkplancmd_";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Deterministic per project and week: the id is the "drafted this week"
// marker, so two workers can never draft the same week twice (P2002).
export function weeklyWorkId(projectId: string, monday: string): string {
  return `${WEEKLY_WORK_PREFIX}${projectId}_${monday}`;
}

export function weeklyCommandId(projectId: string, monday: string): string {
  return `${WEEKLY_COMMAND_PREFIX}${projectId}_${monday}`;
}

// The Monday a weekly Work is for, or null when the id is not one.
export function weekOfWeeklyWork(
  projectId: string,
  workId: string,
): string | null {
  const prefix = `${WEEKLY_WORK_PREFIX}${projectId}_`;
  if (!workId.startsWith(prefix)) return null;
  const monday = workId.slice(prefix.length);
  return DATE_RE.test(monday) ? monday : null;
}

// Monday-first weekday of a date key (0 = Mon ... 6 = Sun).
function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}

// The Monday to draft for, when the project's local clock is in the window
// (Sunday from WEEKLY_DRAFT_HOUR); null otherwise. `local` is the project's
// "YYYY-MM-DDTHH:mm".
export function weeklyDraftTarget(local: string): string | null {
  const date = local.slice(0, 10);
  const hour = Number(local.slice(11, 13));
  if (!DATE_RE.test(date) || !Number.isFinite(hour)) return null;
  if (weekdayOf(date) !== 6 || hour < WEEKLY_DRAFT_HOUR) return null;
  return addDaysToKey(date, 1);
}

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
];

// "6–12 Oct", or "29 Sep – 5 Oct" across two months.
export function weekRangeLabel(monday: string): string {
  const sunday = addDaysToKey(monday, 6);
  const [, m1, d1] = monday.split("-").map(Number);
  const [, m2, d2] = sunday.split("-").map(Number);
  return m1 === m2
    ? `${d1}–${d2} ${MONTHS[m1! - 1]}`
    : `${d1} ${MONTHS[m1! - 1]} – ${d2} ${MONTHS[m2! - 1]}`;
}

export const WEEKLY_DRAFT_COPY = {
  // The chat's title (never a default title: the New Chat rules leave it alone).
  workTitle: (monday: string) => `Weekly plan · ${weekRangeLabel(monday)}`,
  // The plan card's own title: general, no platform name (the Works rule).
  planTitle: "Weekly plan",
  // The line above the card. Fixed server text with counts and dates only:
  // it is replayed to the model, so no idea or brand text goes in it.
  reply: (count: number, monday: string) =>
    `Agentelse drafted next week's plan (${weekRangeLabel(monday)}) from your idea pool: ${count} ${count === 1 ? "post" : "posts"}. Review it, change anything, and save it when it looks right. Nothing is made or posted before you approve.`,
  stepLabel: "Review next week's plan",
  stepTitle: (count: number) =>
    `Next week's plan is ready: ${count} ${count === 1 ? "post" : "posts"} from your idea pool.`,
} as const;

// Settings -> Autonomy "Weekly plan draft" is the policy's hands-on level
// (AutonomyPolicy.autopilotMode): off = REVIEW_EVERYTHING, the agency waits for
// the client; on keeps a level that lets it act (a CREATE_AUTOMATICALLY chosen
// before stays), and turns REVIEW_EVERYTHING back to AUTOPILOT, the default.
export type HandsOnLevel =
  "REVIEW_EVERYTHING" | "CREATE_AUTOMATICALLY" | "AUTOPILOT";

export function weeklyDraftOn(mode: HandsOnLevel | null | undefined): boolean {
  return mode !== "REVIEW_EVERYTHING";
}

export function handsOnLevelFor(
  weeklyDraft: boolean,
  current: HandsOnLevel | null | undefined,
): HandsOnLevel {
  if (!weeklyDraft) return "REVIEW_EVERYTHING";
  return current && current !== "REVIEW_EVERYTHING" ? current : "AUTOPILOT";
}

// Faz 5 (weekly-plan-produce.ts): a weekly draft nobody has touched (no chat
// message, no pane edit) for this long is saved and sent to production on its
// own, so the owner finds pieces waiting instead of an empty draft. Separate
// from AutonomyPolicy.autopilotMode — see the schema comment on why that
// field stays the weekly-draft switch alone.
export const AUTO_PRODUCE_UNTOUCHED_MS = 2 * 60 * 60_000;

export const WEEKLY_AUTO_PRODUCE_COPY = {
  settingsLabel: "Prepare it automatically",
  settingsDescription:
    "If you don't touch next week's draft for 2 hours, Agentelse saves it and starts making the pictures and captions. You still approve every post before it can go out.",
  // Replaces WEEKLY_DRAFT_COPY.reply's "Nothing is made or posted before you
  // approve" once this is on: that line would otherwise promise something
  // this feature's whole point is to no longer do.
  reply: (count: number, monday: string) =>
    `Agentelse drafted next week's plan (${weekRangeLabel(monday)}) from your idea pool: ${count} ${count === 1 ? "post" : "posts"}. Review it or change anything — if you don't, it saves itself in a couple of hours and starts making the pictures and captions. Nothing is posted before you approve.`,
  autoSavedReply: (count: number, monday: string) =>
    `Agentelse saved next week's plan (${weekRangeLabel(monday)}) and is making the ${count} ${count === 1 ? "post" : "posts"}. Nothing is posted before you approve.`,
  stepLabel: "Approve next week's posts",
} as const;
