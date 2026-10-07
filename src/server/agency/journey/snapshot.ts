import "server-only";

import { prisma } from "@/lib/prisma";
import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import {
  WEEKLY_WORK_PREFIX,
  weekOfWeeklyWork,
  weeklyCommandId,
} from "@/lib/weekly-draft";
import type { JourneySnapshot } from "@/lib/journey";
import { addDaysToKey } from "@/lib/content-plan-view";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { countAwaitingVerdict } from "@/server/agency/learning/post-results";
import {
  getProjectTimezone,
  todayInTimezone,
} from "@/server/chat/content-plan";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { countEnabledPublishSchedules } from "@/server/chat/publish-schedule";
import { loadSearchAttention } from "@/server/seo/health/attention";
import { loadWebsiteJourneyFacts } from "@/server/website-analytics/health/read";

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
      cardKind: "content-plan-draft",
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
    const workId = options?.workId;
    // Every read below needs only the project (and the Work), so they all go
    // out together; only the plan tasks wait for the plan slots, and the
    // weekly draft for the timezone. They used to run in four rounds, about
    // eleven round trips end to end, the longest wait of the chat page.
    const timezoneRead = getProjectTimezone(projectId);
    const creativesRead = (async () => {
      const workPlanIds = workId
        ? await loadWorkPlanIds(projectId, workId)
        : undefined;
      return workPlanIds && workPlanIds.length === 0
        ? []
        : prisma.creative.findMany({
            where: {
              projectId,
              planId: workPlanIds ? { in: workPlanIds } : { not: null },
              status: { not: "ARCHIVED" },
              // A channel left out of its post is no piece of the plan.
              excludedAt: null,
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
              postId: true,
              versions: {
                orderBy: { version: "desc" },
                take: 1,
                select: { assetId: true },
              },
            },
          });
    })();
    const taskRowsRead = creativesRead.then((creatives) => {
      const planIds = [
        ...new Set(
          creatives.flatMap((creative) =>
            creative.planId ? [creative.planId] : [],
          ),
        ),
      ];
      return planIds.length
        ? prisma.task.findMany({
            where: { projectId, commandId: { in: planIds } },
            select: { status: true, payload: true, updatedAt: true },
          })
        : [];
    });
    const weeklyDraftRead = timezoneRead.then((timezone) =>
      loadWeeklyDraft(projectId, todayInTimezone(timezone), timezone, workId),
    );

    const [
      timezone,
      creatives,
      taskRows,
      connections,
      schedules,
      results,
      ideaPool,
      weeklyDraft,
      awaitingVerdict,
      openDraftHere,
      attention,
      website,
    ] = await Promise.all([
      timezoneRead,
      creativesRead,
      taskRowsRead,
      getChannelConnections(projectId),
      countEnabledPublishSchedules(projectId),
      loadPlanResults(projectId),
      prisma.idea.count({
        where: {
          projectId,
          status: { in: [...IDEA_POOL_STATUSES] },
          isMock: false,
        },
      }),
      weeklyDraftRead,
      // Published posts of the last 30 days still waiting for the owner's
      // verdict on how they did: project-wide, the same posts the results
      // dialog lists (post-results.ts).
      countAwaitingVerdict(projectId).catch(() => 0),
      workId ? hasOpenDraft(projectId, workId) : Promise.resolve(false),
      // SC-F3: bayraklar kapalıyken sorgu yok.
      loadSearchAttention(projectId).catch(() => null),
      // GA-F3: GA_HEALTH kapalıyken sorgu yok.
      loadWebsiteJourneyFacts(projectId).catch(() => null),
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
      ideaPool,
      awaitingVerdict,
      ...(weeklyDraft ? { weeklyDraft } : {}),
      ...(openDraftHere ? { openDraftHere } : {}),
      ...(attention && attention.critical[0]
        ? {
            searchCritical: {
              alertId: attention.critical[0].id,
              title: attention.critical[0].title,
              count: attention.criticalCount,
            },
          }
        : {}),
      ...(website ? { website } : {}),
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

// The weekly plan draft (weekly-plan-draft.ts) still waiting in its own chat:
// the newest weekly chat whose card is unsaved and whose week has not begun
// (Save refuses a past day). Not pointed to from the draft's own chat. Never
// throws: no pointer on a failed read.
async function loadWeeklyDraft(
  projectId: string,
  today: string,
  timezone: string,
  currentWorkId: string | undefined,
): Promise<{ workId: string; count: number } | undefined> {
  try {
    const work = await prisma.work.findFirst({
      where: {
        projectId,
        status: "ACTIVE",
        id: { startsWith: `${WEEKLY_WORK_PREFIX}${projectId}_` },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!work || work.id === currentWorkId) return undefined;
    const monday = weekOfWeeklyWork(projectId, work.id);
    if (!monday || monday < today) return undefined;
    const command = await prisma.command.findFirst({
      where: { id: weeklyCommandId(projectId, monday), projectId },
      select: { parsedIntent: true },
    });
    const card = (command?.parsedIntent as { card?: unknown } | null)?.card as
      | { kind?: unknown; state?: unknown; items?: unknown }
      | undefined;
    if (card?.kind !== "content-plan-draft" || card.state !== "draft") {
      return undefined;
    }
    const count = Array.isArray(card.items)
      ? card.items.filter(
          (item) => !(item as { removed?: unknown } | null)?.removed,
        ).length
      : 0;
    if (count === 0) return undefined;
    // The week got planned elsewhere meanwhile: saving the draft too would
    // double-book it, so it is no longer pointed to.
    const planned = await prisma.creative.count({
      where: {
        projectId,
        status: { notIn: ["ARCHIVED", "REJECTED"] },
        scheduledFor: {
          gte: zonedDateTimeToUtc(`${monday}T00:00`, timezone),
          lt: zonedDateTimeToUtc(`${addDaysToKey(monday, 7)}T00:00`, timezone),
        },
      },
    });
    return planned > 0 ? undefined : { workId: work.id, count };
  } catch (error) {
    console.error("[journey] weekly draft read failed:", error);
    return undefined;
  }
}

// Whether this chat holds a plan draft nobody has saved yet: its own bar must
// not offer to plan again (that would replace the draft).
async function hasOpenDraft(projectId: string, workId: string): Promise<boolean> {
  try {
    const open = await prisma.command.count({
      where: {
        projectId,
        workId,
        AND: [
          { cardKind: "content-plan-draft" },
          { parsedIntent: { path: ["card", "state"], equals: "draft" } },
        ],
      },
    });
    return open > 0;
  } catch (error) {
    console.error("[journey] open draft read failed:", error);
    return false;
  }
}
