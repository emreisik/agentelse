// The SEO Manager's last step (docs/modules.md "SEO Manager", Publish): the
// article goes up by hand, so the card hands it over (Markdown, HTML), puts it
// on the Content Calendar for the day it goes live and records when it is out.
// Pure helpers for the card and the actions.

import { utcToZonedDateTimeLocal } from "@/lib/timezone";

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// A real "YYYY-MM-DDTHH:mm" (the date-time picker's value): no 31 February.
export function isWallClock(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = WALL_CLOCK.exec(value);
  if (!match) return false;
  const [, y, m, d, hh, mm] = match.map(Number) as number[];
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m! - 1 &&
    date.getUTCDate() === d &&
    hh! <= 23 &&
    mm! <= 59
  );
}

// SC-F7: the monthly plan's slot date (card hint) as the picker's first value,
// only while it is still ahead and the timezone is known; else null.
export function plannedPublishAt(
  plannedAt: string | undefined,
  timezone: string | undefined,
  now: Date,
): string | null {
  if (!plannedAt || !timezone) return null;
  const at = new Date(plannedAt);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null;
  try {
    return utcToZonedDateTimeLocal(at, timezone);
  } catch {
    return null;
  }
}

// The picker's first value: tomorrow at 10:00 in the project's day.
export function defaultPublishAt(todayKey: string): string {
  const [y, m, d] = todayKey.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return `${tomorrow.toISOString().slice(0, 10)}T10:00`;
}

// "Fri 9 Oct, 10:00" in the project's timezone.
export function formatWhen(iso: string, timezone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

// "Fri 9 Oct" in the project's timezone.
export function formatDay(iso: string, timezone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
