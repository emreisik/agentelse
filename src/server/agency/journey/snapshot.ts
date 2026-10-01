import "server-only";

import { prisma } from "@/lib/prisma";
import type { JourneySnapshot } from "@/lib/journey";
import {
  getProjectTimezone,
  todayInTimezone,
} from "@/server/chat/content-plan";
import { getChannelConnections } from "@/server/integrations/channel-connections";

import { computeNextSteps } from "./next-steps";
import { loadPlanResults } from "./results";
import {
  toJourneyItem,
  type PlanCreativeRow,
  type PlanTaskRow,
} from "./plan-progress";

// Reads what the journey needs from the records: the plan slots (Creative rows
// with a planId), the jobs that belong to them, which channels can publish and
// whether anything releases approved posts on their day. A handful of indexed
// reads, run on every chat/calendar load. Never throws into the page: on any
// failure the caller gets null and the bar falls back to its default shortcuts.

// Plans are at most 30 slots; a few plans deep is plenty for "what is next".
const MAX_SLOTS = 300;

export type JourneyOptions = {
  // Read only the plans of this Work (its content-plan-draft Commands).
  workId?: string;
};

// The plan Commands of one Work: the only plans its journey may look at.
async function loadWorkPlanIds(
  projectId: string,
  workId: string,
): Promise<string[]> {
  const plans = await prisma.command.findMany({
    where: {
      projectId,
      workId,
      parsedIntent: { path: ["card", "kind"], equals: "content-plan-draft" },
    },
    select: { id: true },
    take: 200,
  });
  return plans.map((plan) => plan.id);
}

export async function loadJourneySnapshot(
  projectId: string,
  options?: JourneyOptions,
): Promise<JourneySnapshot | null> {
  try {
    const timezone = await getProjectTimezone(projectId);
    const workId = options?.workId;
    const workPlanIds = workId
      ? await loadWorkPlanIds(projectId, workId)
      : undefined;
    const creatives =
      workPlanIds && workPlanIds.length === 0
        ? []
        : await prisma.creative.findMany({
            where: {
              projectId,
              planId: workPlanIds ? { in: workPlanIds } : { not: null },
              status: { not: "ARCHIVED" },
            },
            orderBy: [{ scheduledFor: { sort: "asc", nulls: "last" } }],
            take: MAX_SLOTS,
            select: {
              id: true,
              planId: true,
              status: true,
              currentVersionId: true,
              scheduledFor: true,
              channel: true,
              formatKey: true,
              title: true,
              platform: true,
              versions: {
                orderBy: { version: "desc" },
                take: 1,
                select: { assetId: true },
              },
            },
          });

    const planIds = [
      ...new Set(
        creatives.flatMap((creative) =>
          creative.planId ? [creative.planId] : [],
        ),
      ),
    ];
    const [taskRows, connections, schedules, results] = await Promise.all([
      planIds.length
        ? prisma.task.findMany({
            where: { projectId, commandId: { in: planIds } },
            select: { status: true, payload: true, updatedAt: true },
          })
        : Promise.resolve([]),
      getChannelConnections(projectId),
      prisma.projectSchedule.count({
        where: { projectId, capability: "INSTAGRAM_PUBLISH", enabled: true },
      }),
      loadPlanResults(projectId),
    ]);

    const tasks: PlanTaskRow[] = taskRows.flatMap((task) => {
      const creativeId = (task.payload as { planCreativeId?: unknown } | null)
        ?.planCreativeId;
      return typeof creativeId === "string"
        ? [{ creativeId, status: task.status, updatedAt: task.updatedAt }]
        : [];
    });

    const items = creatives.flatMap((creative) => {
      if (!creative.planId) return [];
      const row: PlanCreativeRow = {
        ...creative,
        planId: creative.planId,
        assetId: creative.versions[0]?.assetId,
      };
      const item = toJourneyItem(row, tasks, timezone);
      return item ? [item] : [];
    });

    return {
      today: todayInTimezone(timezone),
      items,
      connections,
      publishScheduleEnabled: schedules > 0,
      results,
      ...(workId ? { workScoped: true } : {}),
    };
  } catch (error) {
    console.error("[journey] snapshot failed:", error);
    return null;
  }
}

// The next steps for a project, or [] when there is nothing to advance (or the
// snapshot could not be read).
export async function loadNextSteps(
  projectId: string,
  options?: JourneyOptions,
) {
  const snapshot = await loadJourneySnapshot(projectId, options);
  return snapshot ? computeNextSteps(snapshot) : [];
}
