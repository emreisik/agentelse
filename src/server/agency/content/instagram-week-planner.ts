import "server-only";

import { prisma } from "@/lib/prisma";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { generateCreativeImage } from "@/server/media/creative-image";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";

export type WeeklyPlanScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type WeeklyPlanResult = {
  ideasConsidered: number;
  imagesGenerated: number;
  imagesFailed: number;
  scheduled: number;
};

const CONTENT_FORMAT = "FEED_SQUARE" as const;
const PLAN_DAYS = 7;
const DAY_MS = 86_400_000;
// Used only when Settings -> Publishing has no slot times configured yet —
// spread across the day so a cap > 1 doesn't stack every post at the same
// minute.
const FALLBACK_TIMES = [
  "09:00",
  "13:00",
  "17:00",
  "20:00",
  "11:00",
  "15:00",
  "19:00",
];

// A ProjectSchedule row's cronExpression is "M H * * *" (built by
// updateInstagramPublishScheduleAction / updateAutoContentPlanScheduleAction)
// — read the HH:mm back out.
function cronToTime(cronExpression: string | null): string | null {
  if (!cronExpression) return null;
  const [minute, hour] = cronExpression.split(" ");
  if (!hour || !minute) return null;
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function timesForDay(cap: number, configured: string[]): string[] {
  const times = [...new Set(configured)].slice(0, cap);
  let i = 0;
  while (times.length < cap && i < 50) {
    const candidate = FALLBACK_TIMES[i % FALLBACK_TIMES.length]!;
    if (!times.includes(candidate)) times.push(candidate);
    i++;
  }
  return times.slice(0, cap).sort();
}

// Weekly, batched, fully-autonomous Instagram content planner — the user
// asked for content to plan itself from the ideas the agency already
// generates, with no manual trigger per post ("otomatik tüm görsellerin
// olusması gerekıyor ... sürekli olusturdugu fikirlerden yeni poslar
// planlaması"). Unlike every other image-generation path in this codebase
// (Creative Image Studio, Instagram Grid Studio), this one runs with no
// human action — a ProjectSchedule row (capability CREATE_CONTENT_PLAN,
// configuration.mode AUTO_PLAN_GRID_WEEK, see scheduler-service.ts) fires
// it on a weekly cron via SchedulerService.runDueSchedules.
//
// It draws from the project's own SHORTLISTED idea backlog — the exact
// pool AgencyDirector.decideOnIdea works from (agency-director.ts:86 only
// acts on status === "SHORTLISTED") — and immediately walks each idea it
// uses through IDEA_TRANSITIONS (SHORTLISTED -> APPROVED -> PLANNING ->
// ACTIVE -> MEASURING) so AgencyDirector's normal autonomous loop can never
// pick the same idea up a second time. The chain goes one step past ACTIVE
// to MEASURING (a legal, currently-unused IDEA_TRANSITIONS exit) rather
// than stopping at ACTIVE, since IdeaRepository.countActive counts ACTIVE
// toward AutonomyPolicy.maxActiveIdeas — leaving ideas parked at ACTIVE
// forever (nothing else ever moves them, since no WorkPlan governs them)
// would permanently eat into that budget, one idea per week forever.
export async function planWeeklyInstagramContent(
  scope: WeeklyPlanScope,
  dailyImageCap: number,
): Promise<WeeklyPlanResult> {
  const { workspaceId, projectId, brandId } = scope;
  const cap = Math.max(1, Math.floor(dailyImageCap));

  const ideas = await prisma.idea.findMany({
    where: { projectId, status: "SHORTLISTED" },
    orderBy: [
      { nbaScore: { sort: "desc", nulls: "last" } },
      { updatedAt: "desc" },
    ],
    take: cap * PLAN_DAYS,
  });

  const result: WeeklyPlanResult = {
    ideasConsidered: ideas.length,
    imagesGenerated: 0,
    imagesFailed: 0,
    scheduled: 0,
  };
  if (ideas.length === 0) return result;

  const format = getCreativePlatformFormat("INSTAGRAM", CONTENT_FORMAT);
  const createdCreativeIds: string[] = [];

  // Best-effort per idea — one failed generation (provider outage, content
  // policy rejection) must not stop the rest of the week's batch, same
  // pattern as IdeaFoundry.generateForTopOpportunities.
  for (const idea of ideas) {
    try {
      const prompt = `${idea.title}: ${idea.description}`;
      const generated = await generateCreativeImage(prompt, {
        imageSize: format.pixelSize,
      });
      if (!generated) {
        result.imagesFailed += 1;
        continue;
      }

      const asset = await prisma.asset.create({
        data: {
          workspaceId,
          projectId,
          brandId,
          type: "CREATIVE",
          source: "AI_GENERATED",
          filename: generated.filename,
          mimeType: generated.mimeType,
          storageKey: generated.storageKey,
          size: generated.size,
          width: generated.width,
          height: generated.height,
        },
      });

      const creative = await CreativeRepository.create({
        workspaceId,
        projectId,
        brandId,
        type: "SOCIAL_POST",
        platform: "INSTAGRAM",
        title: idea.title,
      });
      await CreativeRepository.addVersion(creative.id, projectId, {
        assetId: asset.id,
        contentFormat: CONTENT_FORMAT,
        generationProvider: generated.provider,
        generationMetadata: {
          prompt,
          source: "auto_weekly_plan",
          ideaId: idea.id,
        },
      });
      await CreativeRepository.transition(creative.id, projectId, "IN_REVIEW");
      await CreativeRepository.transition(creative.id, projectId, "APPROVED");

      await IdeaRepository.transition(idea.id, projectId, "APPROVED");
      await IdeaRepository.transition(idea.id, projectId, "PLANNING");
      await IdeaRepository.transition(idea.id, projectId, "ACTIVE");
      await IdeaRepository.transition(idea.id, projectId, "MEASURING");

      createdCreativeIds.push(creative.id);
      result.imagesGenerated += 1;
    } catch (error) {
      result.imagesFailed += 1;
      console.error(`[instagram-week-planner] idea ${idea.id} failed:`, error);
    }
  }

  if (createdCreativeIds.length > 0) {
    const publishSchedules = await prisma.projectSchedule.findMany({
      where: { projectId, capability: "INSTAGRAM_PUBLISH" },
      select: { cronExpression: true, timezone: true },
    });
    const timezone = publishSchedules[0]?.timezone ?? "Europe/Istanbul";
    const configuredTimes = publishSchedules
      .map((s) => cronToTime(s.cronExpression))
      .filter((t): t is string => Boolean(t));
    const daySlots = timesForDay(cap, configuredTimes);

    let index = 0;
    for (
      let day = 1;
      day <= PLAN_DAYS && index < createdCreativeIds.length;
      day++
    ) {
      const dayKey = dayKeyInTimezone(
        new Date(Date.now() + day * DAY_MS),
        timezone,
      );
      for (const time of daySlots) {
        if (index >= createdCreativeIds.length) break;
        const scheduledFor = zonedDateTimeToUtc(`${dayKey}T${time}`, timezone);
        await CreativeRepository.setScheduledFor(
          createdCreativeIds[index]!,
          projectId,
          scheduledFor,
        );
        index += 1;
        result.scheduled += 1;
      }
    }
  }

  await AuditLogRepository.record({
    workspaceId,
    projectId,
    brandId,
    actorType: "SYSTEM",
    action: "instagram_week_plan.completed",
    entityType: "ProjectSchedule",
    entityId: projectId,
    metadata: {
      ideasConsidered: result.ideasConsidered,
      imagesGenerated: result.imagesGenerated,
      imagesFailed: result.imagesFailed,
      scheduled: result.scheduled,
      dailyImageCap: cap,
    },
  });

  return result;
}
