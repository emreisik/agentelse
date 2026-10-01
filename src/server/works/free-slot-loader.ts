import "server-only";

import { prisma } from "@/lib/prisma";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import {
  parseCronTime,
  suggestSlots,
  type OccupiedSlot,
} from "@/lib/works/free-slots";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { CreativeRepository } from "@/server/repositories/creative.repository";

// Loads what the pure suggestSlots needs (spec 3.4.4). Suggestions are derived
// on every call and never stored.

const HORIZON_DAYS = 61;
const DAY_MS = 24 * 60 * 60_000;

export async function loadOccupiedSlots(
  projectId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<OccupiedSlot[]> {
  // Every scheduled piece counts, whatever its plan (autopilot writes planless ones).
  const rows = await CreativeRepository.listScheduledInRange(projectId, {
    from: now,
    to: new Date(now.getTime() + HORIZON_DAYS * DAY_MS),
  });
  const slots: OccupiedSlot[] = [];
  for (const row of rows) {
    if (!row.scheduledFor) continue;
    const [date, time] = utcToZonedDateTimeLocal(row.scheduledFor, timezone).split("T");
    if (!date || !time) continue;
    slots.push({ date, time, channel: row.channel ?? undefined });
  }
  return slots;
}

export async function loadPublishTimes(projectId: string): Promise<string[]> {
  const rows = await prisma.projectSchedule.findMany({
    where: { projectId, capability: "INSTAGRAM_PUBLISH", enabled: true },
    select: { cronExpression: true },
  });
  const times: string[] = [];
  for (const row of rows) {
    const time = parseCronTime(row.cronExpression);
    if (time && !times.includes(time)) times.push(time);
  }
  return times.sort();
}

export async function loadSuggestedSlots(
  projectId: string,
  opts: { channel: string; startFrom?: string; count?: number },
): Promise<{ timezone: string; slots: { date: string; time: string }[] }> {
  let timezone = "Europe/Istanbul";
  try {
    timezone = await getProjectTimezone(projectId);
    const now = new Date();
    const [occupied, publishTimes] = await Promise.all([
      loadOccupiedSlots(projectId, timezone, now),
      opts.channel === "instagram" ? loadPublishTimes(projectId) : Promise.resolve([]),
    ]);
    const slots = suggestSlots({
      now,
      timezone,
      channel: opts.channel,
      occupied,
      publishTimes,
      startFrom: opts.startFrom,
      count: opts.count,
    });
    return { timezone, slots };
  } catch (error) {
    // Readers get "no suggestion" instead of an exception.
    console.error(
      "[works] free slots failed:",
      error instanceof Error ? error.message : error,
    );
    return { timezone, slots: [] };
  }
}
