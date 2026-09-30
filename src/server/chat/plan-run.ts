import "server-only";

import {
  Prisma,
  type CapabilityKey,
  type CreativeContentFormat,
  type DepartmentKey,
  type SocialPlatform,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  CHANNELS,
  isChannelKey,
  resolveFormat,
  type ChannelFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { isDepartmentInFocus } from "@/server/agency/agency-focus";
import {
  selectProductionBatch,
  toJourneyItem,
  type PlanTaskRow,
} from "@/server/agency/journey/plan-progress";
import { planCreativeIdOf } from "@/server/execution/plan-creative-link";
import { ensureProjectActive } from "@/server/projects/activation";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import { DELIVERABLES } from "./deliverables";
import {
  createChannel,
  forEachWithLimit,
  patchCommandCard,
  runProductionItem,
  type FinalCardPolls,
  type ItemOutcome,
  type ProductionSpec,
} from "./production-run";
import type { ChatStreamEvent } from "./types";

// "Save & produce" on a saved content-plan card: the nearest week of the plan's
// empty calendar slots (at most MAX_PRODUCTION_BATCH) is produced RIGHT NOW,
// streamed as the same tagged item.* events a content-package run uses, and
// each result lands IN its slot (plan-creative-link.ts), so the calendar entry
// that was planned is the one that gets content. The rest of the plan is a
// next step of its own (next-steps.ts): paid image calls and the request time
// limit keep one click bounded.

// Jobs running at once: several renders side by side run into the image
// call's time limit.
const CONCURRENCY = 3;
// A "running" claim older than this is an abandoned run (the process died), so
// the plan can be produced again.
export const RUN_CLAIM_TTL_MS = 10 * 60_000;

export type PlanProduction = {
  // Plain-language name ("Instagram post").
  label: string;
  department: DepartmentKey;
  capability: CapabilityKey;
  targetPlatform?: SocialPlatform;
  // The shape of the deliverable, folded into the worker's brief.
  brief: string;
  // Image pieces render live; text ones show a running card.
  image: boolean;
  contentFormat?: CreativeContentFormat;
};

// Formats the catalog has no deliverable for (LinkedIn/X text), and the ones
// whose brief must name their own channel instead of the deliverable's.
const TEXT_BRIEFS: Readonly<Record<string, string>> = {
  "tiktok.video":
    "TikTok video concept: the hook for the first 2 seconds, a short scene-by-scene script, on-screen text, and a caption",
  "linkedin.post":
    "LinkedIn post: a strong first line, short paragraphs, one concrete insight and a soft call to action, about 120-200 words, no hashtag stuffing",
  "x.post": "X post: one idea in at most 280 characters, no hashtag stuffing",
  "x.thread":
    "X thread: 5-7 numbered posts, the first is the hook, each at most 280 characters",
};

// How a format is produced: the image formats go to the creative department
// (live render at the format's pixel size), everything else is written copy.
// Undefined = the catalog has no production path for it.
export function productionFor(
  channel: ChannelKey,
  format: ChannelFormat,
): PlanProduction | undefined {
  const platform = CHANNELS[channel].platform;
  const label = `${CHANNELS[channel].label} ${format.label.toLowerCase()}`;

  if (format.deliverable === "instagram_post") {
    const d = DELIVERABLES.instagram_post;
    return {
      label,
      department: d.department,
      capability: d.capability,
      targetPlatform: platform,
      brief:
        format.key === "instagram.carousel"
          ? `${d.brief} (the cover image of a carousel; list the slides in the caption)`
          : d.brief,
      image: true,
      contentFormat: format.contentFormat ?? "FEED_PORTRAIT",
    };
  }

  const d = format.deliverable ? DELIVERABLES[format.deliverable] : undefined;
  const brief = TEXT_BRIEFS[format.key] ?? d?.brief;
  if (!brief) return undefined;
  return {
    label,
    department: d?.department ?? "SOCIAL_MEDIA",
    capability: d?.capability ?? "CREATE_COPY",
    targetPlatform: platform,
    brief,
    image: false,
  };
}

export type ClaimedSlot = {
  id: string;
  title: string;
  production: PlanProduction;
  request: string;
};

export type PlanClaimResult =
  | { ok: true; slots: ClaimedSlot[]; startedAt: string }
  | { ok: false; message: string };

function slotRequest(input: {
  production: PlanProduction;
  title: string;
  idea: string | null;
  goal?: string;
  plannedFor: string;
  timezone: string;
}): string {
  return [
    `${input.production.label}: ${input.title}`,
    input.idea ? `Idea: ${input.idea}` : undefined,
    input.goal ? `Goal of the plan: ${input.goal}` : undefined,
    `Planned for: ${input.plannedFor.replace("T", " ")} (${input.timezone})`,
    `Deliverable: ${input.production.brief}.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

// Flips the plan card to "running" inside a serializable transaction (a double
// click or a second tab cannot take the same slots twice) and returns what to
// produce: the producible slots of the nearest week that have a production
// path and a department that is working.
export async function claimPlanProduction(input: {
  projectId: string;
  commandId: string;
  now?: Date;
}): Promise<PlanClaimResult> {
  const now = input.now ?? new Date();
  try {
    return await prisma.$transaction(
      async (tx): Promise<PlanClaimResult> => {
        const row = await tx.command.findUnique({
          where: { id: input.commandId },
          select: { parsedIntent: true, projectId: true },
        });
        const intent = row?.parsedIntent as { card?: unknown } | null;
        const card = intent?.card;
        if (
          row?.projectId !== input.projectId ||
          !isIdeaEventCardData(card) ||
          card.kind !== "content-plan-draft"
        ) {
          return { ok: false, message: "Plan not found." };
        }
        if (card.state === "superseded") {
          return {
            ok: false,
            message: "A newer version of this plan exists. Use that one.",
          };
        }
        if (card.state !== "saved") {
          return { ok: false, message: "Save the plan first." };
        }
        const running = card.production;
        if (
          running?.state === "running" &&
          now.getTime() - Date.parse(running.startedAt) < RUN_CLAIM_TTL_MS
        ) {
          return { ok: false, message: "This plan is already being produced." };
        }
        const slotIds = card.savedCreativeIds ?? [];
        if (slotIds.length === 0) {
          return { ok: false, message: "This plan has no saved slots." };
        }

        const [creatives, taskRows] = await Promise.all([
          tx.creative.findMany({
            where: {
              id: { in: slotIds },
              projectId: input.projectId,
              planId: input.commandId,
            },
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
              brief: true,
            },
          }),
          tx.task.findMany({
            where: { projectId: input.projectId, commandId: input.commandId },
            select: { status: true, payload: true, updatedAt: true },
          }),
        ]);

        const tasks: PlanTaskRow[] = taskRows.flatMap((task) => {
          const creativeId = planCreativeIdOf(task.payload);
          return creativeId
            ? [{ creativeId, status: task.status, updatedAt: task.updatedAt }]
            : [];
        });

        // Slots we can actually produce, with how.
        const byId = new Map<
          string,
          { production: PlanProduction; row: (typeof creatives)[number] }
        >();
        const journeyItems = creatives.flatMap((creative) => {
          const channel = isChannelKey(creative.channel)
            ? creative.channel
            : undefined;
          const format =
            channel && creative.formatKey
              ? resolveFormat(channel, creative.formatKey)
              : undefined;
          const production =
            channel && format && productionFor(channel, format);
          if (!production || !isDepartmentInFocus(production.department)) {
            return [];
          }
          const item = toJourneyItem(
            { ...creative, planId: input.commandId },
            tasks,
            card.timezone,
          );
          if (!item) return [];
          byId.set(creative.id, { production, row: creative });
          return [item];
        });

        const batch = selectProductionBatch(journeyItems, input.commandId);
        if (batch.length === 0) {
          const inFlight = journeyItems.some(
            (item) => item.stage === "PRODUCING",
          );
          return {
            ok: false,
            message: inFlight
              ? "This plan is already being produced."
              : "There is nothing left to produce in this plan.",
          };
        }

        const slots = batch.map((id): ClaimedSlot => {
          const { production, row: creative } = byId.get(id)!;
          const plannedFor = creative.scheduledFor
            ? utcToZonedDateTimeLocal(creative.scheduledFor, card.timezone)
            : "";
          const title = creative.title?.trim() || production.label;
          return {
            id,
            title,
            production,
            request: slotRequest({
              production,
              title,
              idea: creative.brief,
              goal: card.goal,
              plannedFor,
              timezone: card.timezone,
            }),
          };
        });

        await tx.command.update({
          where: { id: input.commandId },
          data: {
            parsedIntent: {
              ...intent,
              card: {
                ...card,
                production: {
                  state: "running",
                  creativeIds: slots.map((slot) => slot.id),
                  startedAt: now.toISOString(),
                },
              },
            } as never,
          },
        });
        return { ok: true, slots, startedAt: now.toISOString() };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    // Two claims raced (double click, two tabs): the loser gets a
    // serialization failure — say what it means instead of surfacing
    // database text.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      return { ok: false, message: "This plan is already being produced." };
    }
    throw error;
  }
}

export type RunContentPlanInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  // The plan's own Command row.
  commandId: string;
  // How long to look for the final card of a job another process ran.
  finalCardPolls?: FinalCardPolls;
};

function specOf(slot: ClaimedSlot): ProductionSpec {
  const { production } = slot;
  return {
    itemId: slot.id,
    title: slot.title,
    label: production.label,
    department: production.department,
    capability: production.capability,
    targetPlatform: production.targetPlatform,
    request: slot.request,
    payloadExtra: {
      planCreativeId: slot.id,
      // Image pieces render as drafts, like everything shown in the
      // conversation (generate_image's default).
      ...(production.image
        ? { contentFormat: production.contentFormat, quality: "medium" }
        : {}),
    },
    logPrefix: `[plan-run] ${production.label}`,
  };
}

// The whole run as one event stream. The route serializes it onto SSE; it is
// consumed to the end even if the client disconnects (the slots are already
// claimed, so it must finish and persist its cards).
export async function* runContentPlan(
  input: RunContentPlanInput,
): AsyncGenerator<ChatStreamEvent> {
  // A project that has not run setup is activated on the spot; only a project
  // on hold (PAUSED / CLOSED) is refused. See projects/activation.ts.
  const activation = await ensureProjectActive(input.projectId);
  if (!activation.usable) {
    yield {
      type: "error",
      code: "PROJECT_INACTIVE",
      message: "This project is on hold, so no new work can start.",
    };
    return;
  }

  const claim = await claimPlanProduction(input);
  if (!claim.ok) {
    yield { type: "error", code: "PLAN", message: claim.message };
    return;
  }

  yield {
    type: "run.items",
    items: claim.slots.map((slot) => ({
      id: slot.id,
      title: slot.title,
      label: slot.production.label,
      department: slot.production.department,
      image: slot.production.image,
    })),
  };

  const channel = createChannel<ChatStreamEvent>();
  const outcomes: ItemOutcome[] = [];
  const work = forEachWithLimit(claim.slots, CONCURRENCY, async (slot) => {
    outcomes.push(await runProductionItem(specOf(slot), input, channel.push));
  }).finally(() => channel.close());

  for await (const event of channel) yield event;
  await work;

  const planned = outcomes.filter((outcome) => outcome.planned).length;
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  if (planned === 0) {
    // Nothing could be started: release the claim so the plan can be tried
    // again right away.
    await patchCommandCard(input.commandId, { production: undefined }).catch(
      (error) => {
        console.error("[plan-run] release failed:", error);
      },
    );
  } else {
    await patchCommandCard(input.commandId, {
      production: {
        state: "done",
        creativeIds: claim.slots.map((slot) => slot.id),
        startedAt: claim.startedAt,
        finishedAt: new Date().toISOString(),
      },
    }).catch((error) => {
      console.error("[plan-run] card update failed:", error);
    });
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      actorType: "USER",
      actorId: input.userId,
      action: "content_plan.production_started",
      entityType: "Command",
      entityId: input.commandId,
      metadata: { items: planned, requested: claim.slots.length, failed },
    }).catch(() => undefined);
  }
  yield { type: "package.done", started: planned, failed };
}
