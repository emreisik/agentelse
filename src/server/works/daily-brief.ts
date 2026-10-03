import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { isChannelKey, resolveFormat } from "@/lib/content-channels";
import { addDaysKey, type PlanItemStage } from "@/lib/journey";
import { prisma } from "@/lib/prisma";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import type { BriefFacts } from "@/lib/works/daily-brief";
import { deriveItemStage } from "@/server/agency/journey/plan-progress";

// The DB-only extras of the Today Work's daily brief (spec 3.11.3). No Graph,
// GA or other network call; every read is isolated so one failure zeroes one
// field instead of the page. The page runs this on every progress refresh, so
// the budget is four reads in one Promise.all.

type Extras = Pick<
  BriefFacts,
  "todayItems" | "yesterdayPublished" | "yesterdayFailed" | "shortlistedIdeas"
>;

const PUBLISH_CAPABILITIES: CapabilityKey[] = [
  "INSTAGRAM_PUBLISH",
  "TIKTOK_PUBLISH",
  "LINKEDIN_PUBLISH",
  "X_PUBLISH",
  "FACEBOOK_PUBLISH",
];

const MAX_TODAY_ITEMS = 50;

async function isolated<T>(label: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error(
      `[works] daily brief ${label} failed:`,
      error instanceof Error ? error.message : error,
    );
    return fallback;
  }
}

export async function loadBriefExtras(
  projectId: string,
  timezone: string,
  today: string,
): Promise<Extras> {
  const empty: Extras = {
    todayItems: [],
    yesterdayPublished: 0,
    yesterdayFailed: 0,
    shortlistedIdeas: 0,
  };
  let dayStart: Date;
  let dayEnd: Date;
  let yesterdayStart: Date;
  try {
    // The window is the project's local day, never the server's or UTC's.
    dayStart = zonedDateTimeToUtc(`${today}T00:00`, timezone);
    dayEnd = zonedDateTimeToUtc(`${addDaysKey(today, 1)}T00:00`, timezone);
    yesterdayStart = zonedDateTimeToUtc(`${addDaysKey(today, -1)}T00:00`, timezone);
  } catch {
    return empty;
  }
  const yesterday = { gte: yesterdayStart, lt: dayStart };

  const [creatives, tasks, posted, shortlistedIdeas] = await Promise.all([
    isolated(
      "today items",
      () =>
        prisma.creative.findMany({
          where: {
            projectId,
            scheduledFor: { gte: dayStart, lt: dayEnd },
            status: { notIn: ["ARCHIVED"] },
          },
          select: {
            id: true,
            title: true,
            channel: true,
            formatKey: true,
            planId: true,
            status: true,
            currentVersionId: true,
            scheduledFor: true,
          },
          orderBy: { scheduledFor: "asc" },
          take: MAX_TODAY_ITEMS,
        }),
      [],
    ),
    isolated(
      "yesterday tasks",
      () =>
        prisma.task.findMany({
          where: {
            projectId,
            capability: { in: PUBLISH_CAPABILITIES },
            status: { in: ["COMPLETED", "FAILED"] },
            OR: [{ completedAt: yesterday }, { completedAt: null, updatedAt: yesterday }],
          },
          select: { status: true, payload: true },
        }),
      [],
    ),
    isolated(
      "client-posted",
      () =>
        prisma.creative.findMany({
          where: { projectId, status: "PUBLISHED", updatedAt: yesterday },
          select: { id: true, channel: true, formatKey: true },
          take: MAX_TODAY_ITEMS,
        }),
      [],
    ),
    isolated(
      "shortlisted ideas",
      () => prisma.idea.count({ where: { projectId, status: "SHORTLISTED" } }),
      0,
    ),
  ]);

  const todayItems: Extras["todayItems"] = [];
  for (const row of creatives) {
    // No task read here (query budget): a DRAFT without content reads as planned.
    const stage: PlanItemStage | null = deriveItemStage(row, []);
    if (!stage) continue;
    todayItems.push({
      id: row.id,
      title: row.title?.trim() || "Untitled",
      channel: isChannelKey(row.channel) ? row.channel : undefined,
      stage,
      formatKey: row.formatKey ?? undefined,
      planId: row.planId ?? undefined,
    });
  }

  // Only manually posted pieces: client-published ones already have a task row.
  // A piece whose publish task completed yesterday is counted through that
  // task, even when its channel or format is unknown (legacy rows).
  const completedCreativeIds = new Set<string>();
  for (const task of tasks) {
    if (task.status !== "COMPLETED") continue;
    const creativeId = (task.payload as { creativeId?: unknown } | null)
      ?.creativeId;
    if (typeof creativeId === "string") completedCreativeIds.add(creativeId);
  }
  const clientPosted = posted.filter((row) => {
    if (completedCreativeIds.has(row.id)) return false;
    if (!isChannelKey(row.channel) || !row.formatKey) return true;
    const format = resolveFormat(row.channel, row.formatKey);
    return !format || format.publish === "manual";
  }).length;

  return {
    todayItems,
    yesterdayPublished:
      tasks.filter((task) => task.status === "COMPLETED").length + clientPosted,
    yesterdayFailed: tasks.filter((task) => task.status === "FAILED").length,
    shortlistedIdeas,
  };
}
