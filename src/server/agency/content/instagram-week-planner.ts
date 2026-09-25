import "server-only";

import type { CreativeLens, Idea } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { generateCreativeImage } from "@/server/media/creative-image";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ApprovalRepository } from "@/server/repositories/approval.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { creativeClaimCheckDef } from "@/server/reasoning/prompts/creative-claim-check";
import { isAgentelseError } from "@/server/security/errors";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";

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
  // True when the batch stopped early because the project's daily
  // task/reasoning cap (or budget) was hit mid-run — see the
  // AutonomyPolicyRepository.checkAndIncrement call below. Distinct from
  // imagesFailed: a capped idea was never attempted, not a generation
  // failure.
  cappedForToday: boolean;
  // Landed at IN_REVIEW instead of auto-APPROVED — either because the
  // project's AutopilotMode isn't AUTOPILOT, or the claim-safety check
  // flagged it. See the main loop below.
  pendingReview: number;
  // Per-item record for the "content-plan-summary" chat card's visual
  // grid (idea-event-card.tsx) and for the chat-triggered path's direct
  // reply (command-service.ts) — every successfully generated creative,
  // regardless of autopilot mode; scheduledFor is filled in only for the
  // ones the scheduling pass below actually assigned a slot to.
  items: {
    creativeId: string;
    assetId?: string;
    title: string;
    scheduledFor?: string;
  }[];
};

// Content-mix quota (spec: ContentProgram, e.g. "40% Product, 25%
// Editorial..."). Weights are relative, not required to sum to 1/100 — a
// lens's share of the week's total slots is weight / sum(all weights).
// Absent/empty = today's exact original behavior (pure nbaScore ordering,
// no mix). Reuses the existing Idea.lens field (CreativeLens) instead of
// inventing new content categories.
export type ContentMix = Partial<Record<CreativeLens, number>>;

// Shared with scheduler-service.ts (the cron-triggered path) and
// command-service.ts (the chat-triggered path, see the CREATE_CONTENT_PLAN
// branch there) — both read the same ProjectSchedule.configuration shape
// (set by the Settings -> Publishing "Auto content planning" card), so the
// dailyImageCap/lensMix a project has configured apply no matter which
// path triggers the batch.
export function weeklyPlanConfigFromSchedule(config: Record<string, unknown>): {
  dailyImageCap: number;
  lensMix?: ContentMix;
} {
  const dailyImageCap =
    typeof config.dailyImageCap === "number" ? config.dailyImageCap : 3;
  const lensMix =
    config.lensMix && typeof config.lensMix === "object"
      ? (config.lensMix as ContentMix)
      : undefined;
  return { dailyImageCap, lensMix };
}

// Shared between the cron-triggered path's own chat message (see
// planWeeklyInstagramContent's skipSummaryMessage) and the chat-triggered
// path's direct reply (command-service.ts) — the same one-line human
// summary either way.
export function summarizeWeeklyPlanResult(result: WeeklyPlanResult): string {
  const parts = [`${result.imagesGenerated}/${result.ideasConsidered} created`];
  if (result.scheduled > 0) parts.push(`${result.scheduled} scheduled`);
  if (result.pendingReview > 0) {
    parts.push(`${result.pendingReview} awaiting approval`);
  }
  if (result.imagesFailed > 0) parts.push(`${result.imagesFailed} failed`);
  if (result.cappedForToday) parts.push("stopped early (daily cap reached)");
  return `📅 Weekly content plan: ${parts.join(", ")}.`;
}

// Pure, DB-free selection so the quota math is unit-testable on its own:
// picks up to `totalSlots` ideas from `candidates` (already sorted best-
// first within any given lens is NOT assumed — this does its own nbaScore
// sort). Each lens gets floor(weight/totalWeight * totalSlots) ideas (best
// nbaScore first within that lens); any shortfall (a lens has fewer
// eligible ideas than its quota, or leftover slots from rounding) is
// backfilled with the next-best remaining ideas of ANY lens, so the mix is
// a target the selection leans toward, never a hard cap that leaves slots
// idle when the shortlist's real makeup doesn't match it exactly.
export function selectIdeasForWeek(
  candidates: Idea[],
  totalSlots: number,
  mix?: ContentMix,
): Idea[] {
  const byScore = (a: Idea, b: Idea) => (b.nbaScore ?? -1) - (a.nbaScore ?? -1);
  const sorted = [...candidates].sort(byScore);

  const activeMix = Object.entries(mix ?? {}).filter(
    (entry): entry is [CreativeLens, number] =>
      typeof entry[1] === "number" && entry[1] > 0,
  );
  if (activeMix.length === 0) return sorted.slice(0, totalSlots);

  const totalWeight = activeMix.reduce((sum, [, weight]) => sum + weight, 0);
  const selected: Idea[] = [];
  const selectedIds = new Set<string>();

  for (const [lens, weight] of activeMix) {
    const quota = Math.floor((weight / totalWeight) * totalSlots);
    if (quota <= 0) continue;
    const fromLens = sorted.filter((idea) => idea.lens === lens);
    for (const idea of fromLens.slice(0, quota)) {
      selected.push(idea);
      selectedIds.add(idea.id);
    }
  }

  if (selected.length < totalSlots) {
    for (const idea of sorted) {
      if (selected.length >= totalSlots) break;
      if (selectedIds.has(idea.id)) continue;
      selected.push(idea);
      selectedIds.add(idea.id);
    }
  }

  return selected.sort(byScore).slice(0, totalSlots);
}

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
// (Creative Image Studio), this one runs with no
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
  options?: {
    lensMix?: ContentMix;
    // The chat-triggered path (command-service.ts's CREATE_CONTENT_PLAN
    // branch) shows this same summary as its direct reply to the user's
    // message instead — posting it again here would duplicate it right
    // next to itself in the single project chat. The cron-triggered path
    // (scheduler-service.ts) has no such reply, so it leaves this unset
    // and gets the summary the normal way.
    skipSummaryMessage?: boolean;
  },
): Promise<WeeklyPlanResult> {
  const { workspaceId, projectId, brandId } = scope;
  const cap = Math.max(1, Math.floor(dailyImageCap));
  const totalSlots = cap * PLAN_DAYS;

  // A wider candidate pool than totalSlots so selectIdeasForWeek's content
  // mix (when configured) has real per-lens choice instead of just
  // whatever a plain nbaScore-desc `take` happened to include — bounded to
  // a sane multiple rather than the whole backlog.
  const candidates = await prisma.idea.findMany({
    where: { projectId, status: "SHORTLISTED" },
    orderBy: [
      { nbaScore: { sort: "desc", nulls: "last" } },
      { updatedAt: "desc" },
    ],
    take: Math.min(totalSlots * 5, 500),
  });
  const ideas = selectIdeasForWeek(candidates, totalSlots, options?.lensMix);

  const result: WeeklyPlanResult = {
    ideasConsidered: ideas.length,
    imagesGenerated: 0,
    imagesFailed: 0,
    scheduled: 0,
    cappedForToday: false,
    pendingReview: 0,
    items: [],
  };
  if (ideas.length === 0) return result;

  const format = getCreativePlatformFormat("INSTAGRAM", CONTENT_FORMAT);
  // Fetched once for the whole batch, not per-idea — all three are
  // read-only project-level context, not something that changes mid-run.
  // brand: Creative has no brand relation (just a brandId column) — needed
  // for the chat card's wordmark (see the creative-ready card below).
  const [autonomyPolicy, brandTwin, brand] = await Promise.all([
    AutonomyPolicyRepository.getOrCreate(scope),
    getBrandTwin(projectId),
    prisma.brand.findUnique({ where: { id: brandId }, select: { name: true } }),
  ]);
  // REVIEW_EVERYTHING: nothing is pre-scheduled, full human curation.
  // CREATE_AUTOMATICALLY/AUTOPILOT: still auto-scheduled — the only
  // difference between those two is whether the creative needs an explicit
  // Approve click before the publish queue can touch it (see the loop
  // below).
  const schedulable = autonomyPolicy.autopilotMode !== "REVIEW_EVERYTHING";
  const createdCreativeIds: string[] = [];

  // Best-effort per idea — one failed generation (provider outage, content
  // policy rejection) must not stop the rest of the week's batch, same
  // pattern as IdeaFoundry.generateForTopOpportunities.
  //
  // Unlike every other autonomous content-creation path in this codebase
  // (AgencyDirector, OpportunityEngine, SignalUniverse, IdeaFoundry,
  // WorkHandoffEngine — all gated via AutonomyPolicyRepository.
  // checkAndIncrement), this planner previously called none of the
  // project's daily-cap/budget machinery: it could generate and
  // auto-approve up to dailyImageCap x 7 = 70 images in one run, fully
  // untracked against maxTasksPerDay or dailyBudgetUsd. One
  // checkAndIncrement("tasksCreated") call per image reuses the exact same
  // counter/cap every other surface already respects (still 0 cost, since
  // image-generation spend has no reliable per-provider $ estimate to feed
  // into reasoningCostUsd) — this is a task-count throttle, not a new
  // dollar-budget mechanism.
  for (const idea of ideas) {
    try {
      await AutonomyPolicyRepository.checkAndIncrement(
        scope,
        "tasksCreated",
        1,
      );

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
      const version = await CreativeRepository.addVersion(
        creative.id,
        projectId,
        {
          assetId: asset.id,
          contentFormat: CONTENT_FORMAT,
          generationProvider: generated.provider,
          generationMetadata: {
            prompt,
            source: "auto_weekly_plan",
            ideaId: idea.id,
          },
        },
      );
      await CreativeRepository.transition(creative.id, projectId, "IN_REVIEW");

      // Brand-safety/claim gate (spec: CLAIM_VALIDATION/BRAND_SAFETY) — a
      // single bounded text check against the brand's own approvedClaims/
      // negativeRules, not a visual check. Fails OPEN (treated as safe) on
      // a reasoning-service error: this is strictly additional coverage on
      // top of a path that had NONE before, so a transient failure here
      // degrades to today's prior behavior, not a new risk.
      const claimCheck = await ReasoningService.run(creativeClaimCheckDef, {
        workspaceId,
        projectId,
        brandId,
        context: {
          title: idea.title,
          description: idea.description,
          approvedClaims: brandTwin?.approvedClaims ?? [],
          negativeRules: brandTwin?.negativeRules ?? [],
        },
      })
        .then((r) => r.output)
        .catch((error) => {
          console.error(
            `[instagram-week-planner] claim check failed for idea ${idea.id}, defaulting to safe:`,
            error,
          );
          return { safe: true } as const;
        });

      const needsHumanReview =
        autonomyPolicy.autopilotMode !== "AUTOPILOT" || !claimCheck.safe;

      let approvalId: string | undefined;
      let finalStatus: "IN_REVIEW" | "APPROVED" = "IN_REVIEW";

      if (needsHumanReview) {
        result.pendingReview += 1;
        const approval = await ApprovalRepository.create({
          workspaceId,
          projectId,
          brandId,
          entityType: "Creative",
          entityId: creative.id,
          type: "CREATIVE_APPROVAL",
          requestedByType: "SYSTEM",
        });
        approvalId = approval.id;
      } else {
        await CreativeRepository.transition(creative.id, projectId, "APPROVED");
        finalStatus = "APPROVED";
      }

      await IdeaRepository.transition(idea.id, projectId, "APPROVED");
      await IdeaRepository.transition(idea.id, projectId, "PLANNING");
      await IdeaRepository.transition(idea.id, projectId, "ACTIVE");
      await IdeaRepository.transition(idea.id, projectId, "MEASURING");

      // Unlike every other creative-generation path (execution-service.ts),
      // there's no task/loading card to resolve back to here — this posts
      // straight into the idea's spot in the single project chat (see
      // docs/brand-workspace-migration.md single-chat consolidation).
      // Best-effort: a chat-post failure must not be counted as a failed
      // generation (the creative itself is already fully created).
      await IdeaChatRepository.postSystemMessage({
        workspaceId,
        projectId,
        ideaId: idea.id,
        text: `🎨 Creative ready: ${idea.title} — ${
          finalStatus === "APPROVED" ? "auto-approved." : "awaiting approval."
        }`,
        card: {
          kind: "creative-ready",
          title: idea.title,
          creativeId: creative.id,
          assetId: asset.id,
          mimeType: asset.mimeType,
          status: finalStatus,
          assetWidth: asset.width ?? undefined,
          assetHeight: asset.height ?? undefined,
          platform: "INSTAGRAM",
          contentFormat: CONTENT_FORMAT,
          approvalId,
          versionNumber: version.version,
          brandName: brand?.name,
        },
      }).catch((error) => {
        console.error(
          `[instagram-week-planner] postSystemMessage failed for idea ${idea.id}:`,
          error,
        );
      });

      if (schedulable) createdCreativeIds.push(creative.id);
      result.items.push({
        creativeId: creative.id,
        assetId: asset.id,
        title: idea.title,
      });
      result.imagesGenerated += 1;
    } catch (error) {
      // A cap/budget hit isn't a generation failure — every remaining idea
      // would fail the exact same check, so stop the batch now instead of
      // burning through the rest of `ideas` for nothing.
      if (isAgentelseError(error) && error.code === "BUDGET_EXCEEDED") {
        result.cappedForToday = true;
        console.warn(
          `[instagram-week-planner] stopped early — daily cap hit after ${result.imagesGenerated} images:`,
          error.message,
        );
        break;
      }
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
        const creativeId = createdCreativeIds[index]!;
        const scheduledFor = zonedDateTimeToUtc(`${dayKey}T${time}`, timezone);
        await CreativeRepository.setScheduledFor(
          creativeId,
          projectId,
          scheduledFor,
        );
        const item = result.items.find((i) => i.creativeId === creativeId);
        if (item) item.scheduledFor = scheduledFor.toISOString();
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
      cappedForToday: result.cappedForToday,
      pendingReview: result.pendingReview,
      autopilotMode: autonomyPolicy.autopilotMode,
    },
  });

  // One project-wide summary card (visual mini-grid, see
  // idea-event-card.tsx's ContentPlanSummaryCard), not per-idea — the
  // individual creative-ready cards above already cover the per-idea
  // detail. ideaId: null since this is a batch spanning many ideas, not
  // any single one's event (see docs/brand-workspace-migration.md
  // single-chat consolidation). Skipped when the chat-triggered path
  // (command-service.ts) is about to show the same text as its direct
  // reply — see skipSummaryMessage above.
  if (!options?.skipSummaryMessage) {
    await IdeaChatRepository.postSystemMessage({
      workspaceId,
      projectId,
      ideaId: null,
      text: summarizeWeeklyPlanResult(result),
      card: {
        kind: "content-plan-summary",
        ideasConsidered: result.ideasConsidered,
        imagesGenerated: result.imagesGenerated,
        imagesFailed: result.imagesFailed,
        scheduled: result.scheduled,
        pendingReview: result.pendingReview,
        cappedForToday: result.cappedForToday,
        items: result.items,
      },
    }).catch((error) => {
      console.error(
        "[instagram-week-planner] summary postSystemMessage failed:",
        error,
      );
    });
  }

  return result;
}
