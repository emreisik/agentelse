// Deterministic calendar for plan directions (Works slice 2, spec 3.2.2).
// The server fixes dates, channels, formats and times as a pure function of the
// brief; the model only writes the ideas, so a pick needs no model call.
// Pure and isomorphic.

import {
  defaultFormat,
  type ChannelKey,
  type PlanGoal,
} from "@/lib/content-channels";
import { addDaysToKey, mondayOf } from "@/lib/content-plan-view";
import {
  parsePlanBrief,
  serializePlanBrief,
  type PlanBrief,
} from "@/lib/plan-brief";

import { cleanWorksTextOrNull } from "./clean-text";

// 10 covers 5 per week x 2 weeks; 14 slots x 3 options came close to the model
// output limit and a truncated tool call looped for several rounds.
export const MAX_OPTION_SLOTS = 10;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 3;
// Times a slot of the "today" anchor may take (first one that still fits).
export const ANCHOR_TIMES = ["10:00", "12:00", "15:00", "18:00"] as const;
// The anchor must leave the client this long to react.
const ANCHOR_LEAD_MINUTES = 60;
// Times of the slots of one day, by their index within the day.
const DAY_TIMES = ["10:00", "12:00", "15:00"] as const;
const HORIZON_DAYS = 60;
const THEME_MAX = 80;

export type PlanSlot = {
  date: string;
  time: string;
  channel: ChannelKey;
  formatKey: string;
};

// Weekdays are Monday-first indexes (0 = Mon ... 6 = Sun), like mondayOf.
const WEEKDAY_PATTERN: Record<number, readonly number[]> = {
  1: [2],
  2: [1, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
};

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
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

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A real calendar day: the round trip rejects "2026-02-30".
function isDateKey(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match || Number(match[1]) < 1000) return false;
  return addDaysToKey(value, 0) === value;
}

function minutesOf(time: string): number | null {
  const match = TIME_RE.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function weekdayIndex(dateKey: string): number {
  const monday = mondayOf(dateKey);
  const [y, m, d] = dateKey.split("-").map(Number);
  const [my, mm, md] = monday.split("-").map(Number);
  const diff = Date.UTC(y!, m! - 1, d!) - Date.UTC(my!, mm! - 1, md!);
  return Math.round(diff / 86_400_000);
}

function maxKey(a: string, b: string): string {
  return a >= b ? a : b;
}

// The first anchor time that is not earlier than now + lead, null when none.
// Minutes are compared as numbers, never as strings.
function anchorTime(nowLocalTime: string | undefined): string | null {
  const now = nowLocalTime === undefined ? null : minutesOf(nowLocalTime);
  // No (or an unreadable) clock: the first time of the day is allowed.
  const earliest = now === null ? 0 : now + ANCHOR_LEAD_MINUTES;
  for (const time of ANCHOR_TIMES) {
    const minutes = minutesOf(time);
    if (minutes !== null && minutes >= earliest) return time;
  }
  return null;
}

export function layoutPlanSlots({
  brief,
  today,
  nowLocalTime,
}: {
  brief: PlanBrief;
  today: string;
  // 'HH:mm' in the project timezone.
  nowLocalTime?: string;
}): PlanSlot[] {
  const total = brief.perWeek * brief.weeks;
  const pattern = WEEKDAY_PATTERN[brief.perWeek];
  if (!pattern || total <= 0 || !isDateKey(today) || !isDateKey(brief.start)) {
    return [];
  }

  const pairs = brief.channels.flatMap(({ channel, formats }) =>
    formats.map((formatKey) => ({ channel, formatKey })),
  );
  if (pairs.length === 0) return [];

  const slots: PlanSlot[] = [];
  const perDay = new Map<string, number>();
  const push = (date: string, time: string | null) => {
    const k = perDay.get(date) ?? 0;
    perDay.set(date, k + 1);
    const pair = pairs[slots.length % pairs.length]!;
    slots.push({
      date,
      time: time ?? DAY_TIMES[Math.min(k, DAY_TIMES.length - 1)]!,
      channel: pair.channel,
      formatKey: pair.formatKey,
    });
  };

  // A brief that starts today plans today ("Plan today") even when today is
  // not a day of the pattern; when no time is left today the anchor is dropped
  // and the walk begins tomorrow so no slot lands in the past.
  const startsToday = brief.start <= today;
  if (startsToday) {
    const time = anchorTime(nowLocalTime);
    if (time) push(today, time);
  }

  const walkStart = startsToday
    ? addDaysToKey(today, 1)
    : maxKey(brief.start, today);
  for (
    let offset = 0;
    offset < HORIZON_DAYS && slots.length < total;
    offset++
  ) {
    const date = addDaysToKey(walkStart, offset);
    if (pattern.includes(weekdayIndex(date))) push(date, null);
  }
  return slots;
}

// The numbered lines the model sees: '1. Mon 5 Oct 10:00 · instagram.post'.
export function describePlanSlots(slots: readonly PlanSlot[]): string[] {
  return slots.map((slot, index) => {
    const [y, m, d] = slot.date.split("-").map(Number);
    const day = new Date(Date.UTC(y!, m! - 1, d!));
    const weekday = WEEKDAY_NAMES[(day.getUTCDay() + 6) % 7]!;
    const month = MONTH_NAMES[day.getUTCMonth()]!;
    return `${index + 1}. ${weekday} ${d} ${month} ${slot.time} · ${slot.formatKey}`;
  });
}

// A typed change ("more playful") carries no [Plan brief]: the newest brief of
// the Work's recent user messages (chronological order) stands in for it.
export function latestPlanBrief(
  userMessages: readonly string[],
): PlanBrief | null {
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const brief = parsePlanBrief(userMessages[i]!);
    if (brief) return brief;
  }
  return null;
}

// The starter's and the daily brief's brief. Mirrors buildFirstPlanBrief.
export function defaultPlanBrief({
  channels,
  today,
  goal,
  theme,
  weeks,
  perWeek,
  start,
}: {
  channels: readonly ChannelKey[];
  today: string;
  goal?: PlanGoal;
  theme?: string | null;
  weeks?: number;
  perWeek?: number;
  start?: string;
}): PlanBrief | null {
  if (!isDateKey(today)) return null;
  const picked: ChannelKey[] = [];
  for (const key of channels) {
    if (key === "ads" || picked.includes(key)) continue;
    picked.push(key);
  }
  if (picked.length === 0) return null;

  const brief: PlanBrief = {
    goal: goal ?? "awareness",
    channels: picked.map((channel) => ({
      channel,
      formats: [defaultFormat(channel).key],
    })),
    perWeek: perWeek ?? 3,
    weeks: weeks ?? 1,
    start: start ?? addDaysToKey(today, 1),
  };
  // The focus title is untrusted and lands in the visible "Theme:" sentence;
  // a theme that does not clean is left out rather than quoted.
  const cleanTheme = cleanWorksTextOrNull(theme, THEME_MAX);
  if (cleanTheme) brief.theme = cleanTheme;

  // What the agent parses must be exactly what we meant.
  const parsed = parsePlanBrief(serializePlanBrief(brief));
  if (!parsed || JSON.stringify(parsed) !== JSON.stringify(brief)) return null;
  return brief;
}
