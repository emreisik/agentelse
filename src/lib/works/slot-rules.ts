import { isChannelKey, resolveFormat } from "@/lib/content-channels";

// Shared slot validation (spec 3.4.3). Pure: no IO, no zone maths. Shape is
// checked before anything reaches zonedDateTimeToUtc, so a rolled-over or
// invalid instant can never exist downstream.

export const MIN_SLOT_LEAD_MINUTES = 60;
export const MAX_TARGETS_PER_PRESS = 6;
// Duplicates MAX_PLAN_HORIZON_DAYS of the server-only content-plan.ts on
// purpose: this module is imported by client cards too.
export const SLOT_HORIZON_DAYS = 60;

export type SlotTargetInput = {
  channel: string;
  formatKey: string;
  date: string;
  time: string;
};

export type SlotRuleResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "EMPTY"
        | "TOO_MANY"
        | "NO_CHANNEL"
        | "OUTSIDE_WORK"
        | "BAD_FORMAT"
        | "BAD_DATE"
        | "BAD_TIME"
        | "PAST";
      message: string;
      suggestIndex?: number;
    };

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Minutes since midnight, or null when the shape is not strictly HH:mm.
export function minutesOf(time: string): number | null {
  if (!TIME_SHAPE.test(time)) return null;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

// UTC-midnight ms of a real calendar day, or null (month 13, Feb 30...).
function dayMs(date: string): number | null {
  if (!DATE_SHAPE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

function fail(
  code: Exclude<SlotRuleResult, { ok: true }>["code"],
  message: string,
  suggestIndex?: number,
): SlotRuleResult {
  return suggestIndex === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, suggestIndex };
}

export function validateSlotTargets(input: {
  workChannels: readonly string[];
  targets: readonly SlotTargetInput[];
  today: string;
  nowLocal: string;
}): SlotRuleResult {
  const { workChannels, targets, today, nowLocal } = input;
  if (targets.length === 0) return fail("EMPTY", "Pick at least one channel.");
  if (targets.length > MAX_TARGETS_PER_PRESS) {
    return fail(
      "TOO_MANY",
      `Pick at most ${MAX_TARGETS_PER_PRESS} channels at once.`,
    );
  }
  if (workChannels.length === 0) {
    return fail("NO_CHANNEL", "This work has no channels yet.");
  }

  const todayMs = dayMs(today);
  const nowMinutes = minutesOf(nowLocal.slice(11, 16));
  const nowDate = nowLocal.slice(0, 10);

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]!;
    if (!isChannelKey(target.channel) || !workChannels.includes(target.channel)) {
      return fail("OUTSIDE_WORK", "That channel is not part of this work.", i);
    }
    if (!resolveFormat(target.channel, target.formatKey)) {
      return fail("BAD_FORMAT", "That format does not exist on this channel.", i);
    }
    const ms = dayMs(target.date);
    if (ms === null || todayMs === null) {
      return fail("BAD_DATE", "That date is not valid.", i);
    }
    const minutes = minutesOf(target.time);
    if (minutes === null) {
      return fail("BAD_TIME", "That time is not valid. Use HH:mm.", i);
    }
    if (ms < todayMs) return fail("PAST", "That day has already passed.", i);
    if (ms > todayMs + SLOT_HORIZON_DAYS * DAY_MS) {
      return fail(
        "BAD_DATE",
        `Pick a day within the next ${SLOT_HORIZON_DAYS} days.`,
        i,
      );
    }
    if (target.date === today) {
      // Fail closed when the clock string is unusable.
      if (
        nowMinutes === null ||
        nowDate !== today ||
        minutes < nowMinutes + MIN_SLOT_LEAD_MINUTES
      ) {
        return fail(
          "PAST",
          "That time is too soon. Pick a time at least an hour from now.",
          i,
        );
      }
    }
  }
  return { ok: true };
}

// 'Fri 2 Oct, 11:00' — the date is read as UTC midnight so the weekday never
// shifts with the server's zone.
export function slotWhenLabel(date: string, time: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
    .format(new Date(`${date}T00:00:00.000Z`))
    .replace(",", "");
  return `${day}, ${time}`;
}

// Text that ends up inside a bracketed, single-line chat sentence.
export function sanitizeClickText(text: string, max: number): string {
  const clean = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
