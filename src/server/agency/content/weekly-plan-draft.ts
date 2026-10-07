import "server-only";

import { prisma } from "@/lib/prisma";
import type { ChannelKey } from "@/lib/content-channels";
import { utcToZonedDateTimeLocal, zonedDateTimeToUtc } from "@/lib/timezone";
import { addDaysToKey } from "@/lib/content-plan-view";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import {
  defaultPlanBrief,
  describePlanSlots,
  layoutPlanSlots,
  type PlanSlot,
} from "@/lib/works/plan-layout";
import { chatDefaultChannels } from "@/lib/works/starter-cards";
import { channelOptions } from "@/lib/works/work";
import {
  WEEKLY_AUTO_PRODUCE_COPY,
  WEEKLY_DRAFT_COPY,
  WEEKLY_DRAFT_POSTS,
  WEEKLY_WORK_PREFIX,
  weeklyCommandId,
  weeklyDraftOn,
  weeklyDraftTarget,
  weeklyWorkId,
} from "@/lib/weekly-draft";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { buildPlanCard, keepPoolIdeaIds } from "@/server/chat/content-plan";
import { loadIdeaPoolForPrompt, poolIdeaIds } from "@/server/chat/idea-pool";
import { isUniqueViolation } from "@/server/guided-setup/store";
import { weeklySeoNote } from "@/server/seo/content-plan/weekly";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { MemoryService } from "@/server/memory/memory-service";
import {
  weeklyPlanDraftDef,
  type WeeklyPlanDraftOutput,
} from "@/server/reasoning/prompts/weekly-plan-draft";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import {
  withBrandFlags,
  writePlanDraftWork,
} from "@/server/works/draft-plan-work";
import { isWorksEnabled } from "@/server/works/flag";

// Faz 4, the autonomous weekly plan draft (docs/brand-brain-loop.md). Every
// Sunday evening in the project's timezone, for a project whose owner has not
// switched it off (Settings -> Autonomy, "Weekly plan draft" =
// AutonomyPolicy.autopilotMode other than REVIEW_EVERYTHING), Agentelse drafts
// next Monday-Sunday from the idea pool: one lite model call writes a post per
// server-fixed slot, the server checks the words, the idea links and the brand
// rules, and the draft lands as an ordinary plan card in a chat (Work) of its
// own. Saving, making and publishing stay the owner's taps.
//
// The week's Work id is the "drafted" marker (weeklyWorkId): the Work and its
// card are written in one transaction, so a crash never leaves half of it, and
// a second worker gets P2002 instead of a second draft.

const DEFAULT_TIMEZONE = "Europe/Istanbul";
// A failed draft is tried again after this long, not on every tick.
const FAILED_RETRY_MS = 60 * 60_000;
// How far back an open draft card can still cover next week.
const OPEN_DRAFT_LOOKBACK_DAYS = 21;
const TOPIC_MAX = 120;
// Room for a drafted pool idea ('"headline" | visual | caption', ideas.md).
const CAPTION_MAX = 1500;
const PURPOSE_MAX = 60;

// The durable "this week was drafted" fact, written in the same transaction as
// the Work and kept when the owner deletes that chat (the Work id alone would
// then let a restarted worker draft the deleted week again).
export const WEEKLY_DRAFTED_ACTION = "weekly_plan.drafted";

// What this process already decided for a project's week, and until when the
// next ticks skip it without a query: a written or already drafted week for the
// rest of the evening, a week with nothing to draft for a while (the pool may
// fill, the owner may clear the week), a failure for a few minutes.
const decided = new Map<string, { monday: string; until: number }>();
const SETTLED_MS = 12 * 60 * 60_000;
const NOTHING_YET_MS = 30 * 60_000;
const FAILED_MS = 10 * 60_000;

export function clearWeeklyDraftMemo() {
  decided.clear();
}

type Candidate = { id: string; workspaceId: string; timezone: string };

function weekMarkerId(projectId: string, monday: string): string {
  return `${projectId}:${monday}`;
}

// A timezone the runtime does not know (the Publishing timezone was free text:
// "UTC+3") reads as the default zone, so one project's typo never stops the
// step for every other project.
function safeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

// Sunday 18:00-24:00 exists somewhere on Earth only between Sunday 04:00 UTC
// (UTC+14) and Monday 12:00 UTC (UTC-12): outside that, the step costs no query.
export function sundayEveningSomewhere(now: Date): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return (day === 0 && hour >= 4) || (day === 1 && hour < 12);
}

export const WeeklyPlanDraft = {
  // At most `limit` drafts per tick. Returns how many were written.
  async runDue(limit = 2, now: Date = new Date()): Promise<number> {
    if (!isWorksEnabled() || !sundayEveningSomewhere(now)) return 0;
    const projects = await prisma.project.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, workspaceId: true },
    });
    if (projects.length === 0) return 0;
    const schedules = await prisma.projectSchedule.findMany({
      where: {
        capability: "INSTAGRAM_PUBLISH",
        projectId: { in: projects.map((p) => p.id) },
      },
      select: { projectId: true, timezone: true },
    });
    const timezoneOf = new Map(
      schedules.map((row) => [row.projectId, row.timezone] as const),
    );

    // Only projects whose local clock is in the Sunday-evening window, and
    // whose week this process has not settled yet.
    const due: (Candidate & { monday: string })[] = [];
    for (const project of projects) {
      const timezone = safeTimezone(
        timezoneOf.get(project.id) ?? DEFAULT_TIMEZONE,
      );
      const monday = weeklyDraftTarget(utcToZonedDateTimeLocal(now, timezone));
      if (!monday) continue;
      const memo = decided.get(project.id);
      if (memo && memo.monday === monday && now.getTime() < memo.until)
        continue;
      due.push({ ...project, timezone, monday });
    }
    if (due.length === 0) return 0;

    const policies = await prisma.autonomyPolicy.findMany({
      where: { projectId: { in: due.map((p) => p.id) } },
      select: { projectId: true, autopilotMode: true, weeklyAutoProduce: true },
    });
    const switchedOff = new Set(
      policies
        .filter((policy) => !weeklyDraftOn(policy.autopilotMode))
        .map((policy) => policy.projectId),
    );
    const autoProduceOn = new Set(
      policies
        .filter((policy) => policy.weeklyAutoProduce)
        .map((policy) => policy.projectId),
    );

    let written = 0;
    for (const project of due) {
      if (written >= limit) break;
      // Not memoized: the owner may switch it on this evening.
      if (switchedOff.has(project.id)) continue;
      const remember = (ms: number) =>
        decided.set(project.id, {
          monday: project.monday,
          until: now.getTime() + ms,
        });
      try {
        const outcome = await draftWeek(
          project,
          project.monday,
          now,
          autoProduceOn.has(project.id),
        );
        if (outcome === "written") written += 1;
        remember(
          outcome === "written" || outcome === "drafted"
            ? SETTLED_MS
            : outcome === "skipped"
              ? NOTHING_YET_MS
              : FAILED_MS,
        );
      } catch (error) {
        remember(FAILED_MS);
        console.error(
          `[weekly-plan-draft] draft failed for project ${project.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return written;
  },
};

type DraftOutcome = "written" | "drafted" | "skipped" | "retry";

// One project's week. "drafted": it was drafted before (even if the owner has
// deleted that chat since); "skipped": nothing to draft now (the week already
// planned, an empty pool); "retry": try on a later tick (paused, a failed
// model call within the hour).
async function draftWeek(
  project: Candidate,
  monday: string,
  now: Date,
  autoProduceOn: boolean,
): Promise<DraftOutcome> {
  const projectId = project.id;
  if (!(await isProjectAgencyActive(projectId))) return "retry";

  const workId = weeklyWorkId(projectId, monday);
  const [existing, marker] = await Promise.all([
    prisma.work.findUnique({ where: { id: workId }, select: { id: true } }),
    prisma.auditLog.findFirst({
      where: {
        projectId,
        entityType: "Project",
        entityId: weekMarkerId(projectId, monday),
        action: WEEKLY_DRAFTED_ACTION,
      },
      select: { id: true },
    }),
  ]);
  if (existing || marker) return "drafted";

  // The week already has posts on the calendar, or an open draft covers it.
  const weekStart = zonedDateTimeToUtc(`${monday}T00:00`, project.timezone);
  const weekEnd = zonedDateTimeToUtc(
    `${addDaysToKey(monday, 7)}T00:00`,
    project.timezone,
  );
  const planned = await prisma.creative.count({
    where: {
      projectId,
      status: { notIn: ["ARCHIVED", "REJECTED"] },
      scheduledFor: { gte: weekStart, lt: weekEnd },
      // SC-F7: aylık SEO slotu sosyal haftalık taslağı engellemesin (OR biçimi: yalnız `not: 'seo'` NULL kanallı satırları da düşürürdü). Plan o proje için kapalıyken sorgu aynıdır.
      ...(seoContentPlanActiveFor(projectId)
        ? { OR: [{ channel: null }, { channel: { not: "seo" } }] }
        : {}),
    },
  });
  if (planned > 0) return "skipped";
  if (await openDraftCovers(projectId, monday, now)) return "skipped";

  const pool = await loadIdeaPoolForPrompt(projectId);
  if (pool.length === 0) return "skipped";

  // A failed model call is not repeated on every tick.
  const lastAttempt = await prisma.reasoningCall.findFirst({
    where: { projectId, purpose: weeklyPlanDraftDef.purpose },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, status: true },
  });
  if (
    lastAttempt &&
    lastAttempt.status !== "OK" &&
    now.getTime() - lastAttempt.createdAt.getTime() < FAILED_RETRY_MS
  ) {
    return "retry";
  }

  const brand = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  if (!brand) return "skipped";

  const connections = await getChannelConnections(projectId).catch(() => ({}));
  const channel: ChannelKey =
    chatDefaultChannels(channelOptions(connections))[0] ?? "instagram";
  const today = utcToZonedDateTimeLocal(now, project.timezone).slice(0, 10);
  const brief = defaultPlanBrief({
    channels: [channel],
    today,
    perWeek: WEEKLY_DRAFT_POSTS,
    weeks: 1,
    start: monday,
  });
  const slots = brief ? layoutPlanSlots({ brief, today }) : [];
  if (slots.length === 0) return "skipped";

  const [brandContext, postResults] = await Promise.all([
    ConstitutionService.getBrandContext(brand.id),
    MemoryService.postLessons(brand.id),
  ]);
  const { output } = await ReasoningService.run(weeklyPlanDraftDef, {
    workspaceId: project.workspaceId,
    projectId,
    brandId: brand.id,
    context: {
      brand: brandContext,
      slots: describePlanSlots(slots),
      ideaPool: pool,
      postResults,
    },
  });

  const drafted = draftItems(output, slots);
  if (drafted.length === 0) {
    console.error(
      `[weekly-plan-draft] the model wrote no usable post for project ${projectId}`,
    );
    return "skipped";
  }
  const items = keepPoolIdeaIds(
    drafted,
    await poolIdeaIds(
      projectId,
      drafted.flatMap((item) => (item.ideaId ? [item.ideaId] : [])),
    ),
  );

  const language = await brandRuleLanguageOf(projectId);
  const rules = await loadBrandRules({
    projectId,
    brandId: brand.id,
    language,
  });
  // SC-F7: bu hafta aylık plandan SEO makalesi çıkıyorsa cevaba tek cümle (kapalıyken '' ve sorgu yok).
  const seoNote = await weeklySeoNote(projectId, weekStart, weekEnd);
  const flagged = withBrandFlags(
    buildPlanCard(
      { title: WEEKLY_DRAFT_COPY.planTitle, items },
      project.timezone,
      connections,
    ),
    rules,
  );

  try {
    await prisma.$transaction(async (tx) => {
      await writePlanDraftWork(tx, {
        workId,
        commandId: weeklyCommandId(projectId, monday),
        workspaceId: project.workspaceId,
        projectId,
        brandId: brand.id,
        title: WEEKLY_DRAFT_COPY.workTitle(monday),
        reply: `${(autoProduceOn
          ? WEEKLY_AUTO_PRODUCE_COPY.reply
          : WEEKLY_DRAFT_COPY.reply)(flagged.items.length, monday)}${seoNote ? ` ${seoNote}` : ""}`,
        card: flagged,
        now,
      });
      await tx.auditLog.create({
        data: {
          workspaceId: project.workspaceId,
          projectId,
          brandId: brand.id,
          actorType: "SYSTEM",
          action: WEEKLY_DRAFTED_ACTION,
          entityType: "Project",
          entityId: weekMarkerId(projectId, monday),
          metadata: { workId, posts: flagged.items.length },
        },
      });
    });
  } catch (error) {
    // Another worker drafted this week first.
    if (isUniqueViolation(error)) return "drafted";
    throw error;
  }

  await archiveUntouchedOlderDrafts(projectId, workId);
  return "written";
}

// The model's posts, one per slot (an unknown or repeated slot number, or a
// post whose words do not clean, is dropped), on the slot's fixed day, time,
// channel and format.
export function draftItems(
  output: WeeklyPlanDraftOutput,
  slots: readonly PlanSlot[],
): {
  date: string;
  time: string;
  channel: ChannelKey;
  formatKey: string;
  topic: string;
  captionIdea: string;
  purpose?: string;
  ideaId?: string;
}[] {
  const used = new Set<number>();
  const items: ReturnType<typeof draftItems> = [];
  for (const post of output.posts) {
    const index = Math.round(post.slot) - 1;
    const slot = slots[index];
    if (!slot || used.has(index)) continue;
    const topic = cleanWorksTextOrNull(post.topic, TOPIC_MAX);
    const captionIdea = cleanWorksTextOrNull(post.captionIdea, CAPTION_MAX);
    if (!topic || !captionIdea) continue;
    const purpose = cleanWorksTextOrNull(post.purpose, PURPOSE_MAX);
    const ideaId = post.ideaId?.trim();
    used.add(index);
    items.push({
      date: slot.date,
      time: slot.time,
      channel: slot.channel,
      formatKey: slot.formatKey,
      topic,
      captionIdea,
      ...(purpose ? { purpose } : {}),
      ...(ideaId ? { ideaId } : {}),
    });
  }
  return items.sort((a, b) =>
    `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`),
  );
}

// An open (unsaved) plan draft anywhere in the project with a post in the
// target week: the owner already has a plan for it in the making.
async function openDraftCovers(
  projectId: string,
  monday: string,
  now: Date,
): Promise<boolean> {
  const sunday = addDaysToKey(monday, 6);
  const rows = await prisma.command.findMany({
    where: {
      projectId,
      createdAt: {
        gte: new Date(now.getTime() - OPEN_DRAFT_LOOKBACK_DAYS * 86_400_000),
      },
      parsedIntent: { path: ["card", "kind"], equals: "content-plan-draft" },
    },
    select: { parsedIntent: true },
  });
  return rows.some((row) => {
    const card = (row.parsedIntent as { card?: unknown } | null)?.card as
      { state?: unknown; items?: unknown } | undefined;
    if (card?.state !== "draft" || !Array.isArray(card.items)) return false;
    return card.items.some((item) => {
      const date = (item as { date?: unknown } | null)?.date;
      return typeof date === "string" && date >= monday && date <= sunday;
    });
  });
}

// Earlier weekly drafts nobody touched (no message of the owner's, the card
// still unsaved) leave Recents once the new one arrives: their week has begun,
// so they could not be saved as they are anyway. Best-effort.
async function archiveUntouchedOlderDrafts(
  projectId: string,
  currentWorkId: string,
): Promise<void> {
  try {
    const older = await prisma.work.findMany({
      where: {
        projectId,
        status: "ACTIVE",
        id: {
          startsWith: `${WEEKLY_WORK_PREFIX}${projectId}_`,
          not: currentWorkId,
        },
      },
      select: {
        id: true,
        commands: { select: { source: true, parsedIntent: true } },
      },
    });
    const stale = older.filter(
      (work) =>
        work.commands.every((command) => command.source === "SYSTEM") &&
        work.commands.every((command) => {
          const card = (command.parsedIntent as { card?: unknown } | null)
            ?.card as { kind?: unknown; state?: unknown } | undefined;
          return card?.kind !== "content-plan-draft" || card.state === "draft";
        }),
    );
    if (stale.length === 0) return;
    await prisma.work.updateMany({
      where: { projectId, id: { in: stale.map((work) => work.id) } },
      data: { status: "ARCHIVED" },
    });
  } catch (error) {
    console.error(
      "[weekly-plan-draft] could not archive older drafts:",
      error instanceof Error ? error.message : error,
    );
  }
}
