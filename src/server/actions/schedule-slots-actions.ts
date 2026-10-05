"use server";

import type { IdeaStatus, Prisma } from "@prisma/client";

import {
  CHANNELS,
  defaultFormat,
  isChannelKey,
  resolveFormat,
} from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import { utcToZonedDateTimeLocal, zonedDateTimeToUtc } from "@/lib/timezone";
import {
  blocksOf,
  brandCheckOf,
  checkItems,
  flagsForItem,
  type BrandFlag,
} from "@/lib/works/brand-rules";
import {
  NEUTRAL_IDEA_LABEL,
  cleanWorksTextOrNull,
} from "@/lib/works/clean-text";
import { copyText } from "@/lib/works/copy";
import { ideaTargetFields } from "@/lib/works/idea-options";
import {
  sanitizeClickText,
  slotWhenLabel,
  validateSlotTargets,
  type SlotTargetInput,
} from "@/lib/works/slot-rules";
import { workSummaryFrom } from "@/lib/works/work";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { updateCardInTx } from "@/server/chat/card-store";
import { RUN_CLAIM_TTL_MS } from "@/server/chat/plan-run";
import { createSlots, type SlotTarget } from "@/server/chat/schedule-slots";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { loadSuggestedSlots } from "@/server/works/free-slot-loader";
import { movePostInTx } from "@/server/works/post-move";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
  refreshWorkPages,
  type GuardFail,
  type WorksAuth,
} from "@/server/works/guard";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Idea -> calendar and the planned-slot card's two edits (spec 3.4.1, 3.4.9).
// Every refusal rule runs before the first write; the Work, the idea and the
// Creative are always looked up WITH the project id. 'use server': only async
// exports, the helpers live in schedule-slots.ts / slot-rules.ts / guard.ts.

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

type SlotSuggestion = { channel: string; date: string; time: string };

export type ScheduleSlotsResult =
  | {
      ok: true;
      commandId: string;
      alreadyScheduled: boolean;
      slots: {
        channel: string;
        formatKey: string;
        date: string;
        time: string;
        creativeId: string;
        existed: boolean;
      }[];
      ideaStatus: IdeaStatus;
      timezone: string;
    }
  | {
      ok: false;
      code: GuardFail["code"] | "WORK" | "IDEA_GONE" | "BRAND_RULES" | "BUSY";
      message: string;
      flags?: BrandFlag[];
    }
  | { ok: false; code: "STALE"; message: string; suggestion?: SlotSuggestion };

export type MoveSlotResult =
  | { ok: true; date: string; time: string }
  | {
      ok: false;
      code: GuardFail["code"] | "WORK" | "LOCKED" | "BUSY";
      message: string;
    }
  | { ok: false; code: "STALE"; message: string; suggestion?: SlotSuggestion };

export type RemoveSlotResult =
  | { ok: true }
  | {
      ok: false;
      code: "DISABLED" | "RATE" | "NOT_FOUND" | "WORK" | "LOCKED" | "FAILED";
      message: string;
    };

const SCHEDULE_BUCKET = { bucket: "slots", limit: 30 } as const;
const MOVABLE_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED"] as const;
const POST_OUT_MESSAGE =
  "Part of this post is already out, so it can't move.";
const TERMINAL_TASK_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const TOPIC_MAX = 120;
const CAPTION_MAX = 300;
const CARD_TITLE_MAX = 60;
const RAW_TEXT_MAX = 80;
const MATCHED_ECHO_MAX = 40;
const INVALID_MESSAGE = GUARD_MESSAGE.failed;

// Thrown inside a transaction so every write made so far rolls back.
class SlotTxRefusal extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "LOCKED" | "FAILED",
    message: string,
  ) {
    super(message);
  }
}

function isWriteConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2034"
  );
}

function planCardOf(parsedIntent: unknown): PlanCard | null {
  const card = (parsedIntent as { card?: unknown } | null)?.card as
    { kind?: unknown; items?: unknown } | null | undefined;
  return card && card.kind === "content-plan-draft" && Array.isArray(card.items)
    ? (card as PlanCard)
    : null;
}

// Best effort: a failure is logged and never undoes what was committed.
async function bestEffort(label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.error(
      `[works] ${label} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function freshSuggestion(
  projectId: string,
  channel: string,
): Promise<SlotSuggestion | undefined> {
  try {
    const result = await loadSuggestedSlots(projectId, { channel });
    const first = result.slots[0];
    return first ? { channel, date: first.date, time: first.time } : undefined;
  } catch {
    return undefined;
  }
}

function clockOf(timezone: string): { today: string; nowLocal: string } {
  const nowLocal = utcToZonedDateTimeLocal(new Date(), timezone);
  return { today: nowLocal.slice(0, 10), nowLocal };
}

// A Work another person completed, or one that is not this project's.
async function activeWork(projectId: string, workId: string) {
  const work = await WorkRepository.get(projectId, workId);
  if (!work) {
    return {
      ok: false as const,
      code: "NOT_FOUND" as const,
      message: GUARD_MESSAGE.failed,
    };
  }
  if (work.status !== "ACTIVE") {
    return {
      ok: false as const,
      code: "WORK" as const,
      message: GUARD_MESSAGE.completed,
    };
  }
  return { ok: true as const, work };
}

type RawTarget = {
  channel: string;
  formatKey?: string;
  date: string;
  time: string;
};

function parseTargets(value: unknown): RawTarget[] | null {
  if (!Array.isArray(value)) return null;
  const out: RawTarget[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { channel, formatKey, date, time } = entry as Record<string, unknown>;
    if (
      typeof channel !== "string" ||
      typeof date !== "string" ||
      typeof time !== "string" ||
      (formatKey !== undefined && typeof formatKey !== "string")
    ) {
      return null;
    }
    out.push({ channel, formatKey, date, time });
  }
  return out;
}

function formatKeyOf(target: RawTarget): string {
  if (target.formatKey) return target.formatKey;
  return isChannelKey(target.channel) ? defaultFormat(target.channel).key : "";
}

function channelLabel(channel: string): string {
  return isChannelKey(channel) ? CHANNELS[channel].label : channel;
}

// Channel labels, times and formats only: the click row is replayed to the
// model (rawText as a user message, replyText as its own words), so no idea
// text may ever reach it (review SC-7).
function clickRowOf(targets: readonly SlotTargetInput[]): {
  rawText: string;
  replyText: string;
} {
  const labels = [...new Set(targets.map((t) => channelLabel(t.channel)))];
  const rawText = sanitizeClickText(
    `Add to calendar on ${labels.join(" and ")}`,
    RAW_TEXT_MAX,
  );
  const replyText = targets
    .map((t) => {
      const format = isChannelKey(t.channel)
        ? resolveFormat(t.channel, t.formatKey)
        : undefined;
      return `Added an idea to your calendar for ${slotWhenLabel(t.date, t.time)} on ${channelLabel(t.channel)} (${format?.label ?? "Post"}). It is planned and has no content yet.`;
    })
    .join(" ");
  return { rawText, replyText };
}

export async function scheduleSlotsAction(
  projectId: string,
  workId: string,
  input: {
    ideaId: string;
    targets: {
      channel: string;
      formatKey?: string;
      date: string;
      time: string;
    }[];
    allowIssues?: boolean;
  },
): Promise<ScheduleSlotsResult> {
  return guardedAction(
    "schedule-slots",
    async (): Promise<ScheduleSlotsResult> => {
      // 1. Flag, session, project access, rate.
      const gate = await authorizeWorks(projectId, SCHEDULE_BUCKET);
      if (!gate.ok) return gate;
      const { auth } = gate;

      const workIdOk = idSchema.safeParse(workId);
      const ideaIdOk = idSchema.safeParse(input?.ideaId);
      const raw = parseTargets(input?.targets);
      if (!workIdOk.success || !ideaIdOk.success || !raw) {
        return { ok: false, code: "INVALID", message: INVALID_MESSAGE };
      }
      const allowIssues = input.allowIssues === true;

      // 2. The Work must exist in this project and be ACTIVE.
      const found = await activeWork(projectId, workIdOk.data);
      if (!found.ok) return found;
      const { work } = found;

      // 3. The idea, looked up with the project id; refused before any write.
      const idea = await IdeaRepository.findByIdInProject(
        ideaIdOk.data,
        projectId,
      );
      if (!idea) {
        return { ok: false, code: "NOT_FOUND", message: INVALID_MESSAGE };
      }
      if (idea.status === "REJECTED" || idea.status === "ARCHIVED") {
        return {
          ok: false,
          code: "IDEA_GONE",
          message: copyText("ideaOptions.gone"),
        };
      }

      // 4. Strict shape and lead time (no zone maths before this passes).
      const timezone = await getProjectTimezone(projectId);
      const targets: SlotTargetInput[] = raw.map((target) => ({
        channel: target.channel,
        formatKey: formatKeyOf(target),
        date: target.date,
        time: target.time,
      }));
      const verdict = validateSlotTargets({
        targets,
        ...clockOf(timezone),
      });
      if (!verdict.ok) {
        if (verdict.code === "PAST") {
          const channel = targets[verdict.suggestIndex ?? 0]?.channel ?? "";
          return {
            ok: false,
            code: "STALE",
            message: verdict.message,
            suggestion: await freshSuggestion(projectId, channel),
          };
        }
        return { ok: false, code: "INVALID", message: verdict.message };
      }

      // The same idea on the same channel and format is one slot.
      const seen = new Set<string>();
      const unique = targets.filter((target) => {
        const key = `${target.channel}:${target.formatKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // 5. Idea text is untrusted (a model or a scan wrote it): cleaned, with
      // neutral fallbacks so a hashtag or a link never fails the press.
      const fields = ideaTargetFields(idea);
      const topic =
        cleanWorksTextOrNull(fields.topic, TOPIC_MAX) ??
        cleanWorksTextOrNull(idea.title, TOPIC_MAX) ??
        NEUTRAL_IDEA_LABEL;
      const captionIdea =
        cleanWorksTextOrNull(fields.captionIdea, CAPTION_MAX) ?? topic;
      const cardTitle =
        cleanWorksTextOrNull(idea.title, CARD_TITLE_MAX) ?? NEUTRAL_IDEA_LABEL;

      // 6. Brand rules over the targets' text.
      const rules = await loadBrandRules({
        projectId,
        brandId: auth.defaultBrandId,
        language: await brandRuleLanguageOf(projectId),
      });
      const hits = checkItems(
        unique.map(() => ({ topic, captionIdea })),
        rules,
      );
      const blocks = blocksOf(hits);
      if (blocks.length > 0 && !allowIssues) {
        return {
          ok: false,
          code: "BRAND_RULES",
          message: copyText("brand.blockedSchedule"),
          flags: blocks.map((block) => block.flag),
        };
      }
      const matched =
        allowIssues && blocks.length > 0
          ? blocks.map((block) => block.flag.matched.slice(0, MATCHED_ECHO_MAX))
          : [];

      // 7. The click row carries no idea-derived text.
      const clickRow = clickRowOf(unique);
      const origin = { kind: "idea" as const, ref: ideaIdOk.data };
      const slotTargets: SlotTarget[] = unique.map((target, index) => {
        const flags = flagsForItem(hits, index);
        return {
          channel: target.channel,
          formatKey: target.formatKey,
          date: target.date,
          time: target.time,
          topic,
          captionIdea,
          origin,
          ideaId: ideaIdOk.data,
          ...(flags.length > 0 ? { brandFlags: flags } : {}),
        };
      });

      // 8. One creator for the slots; everything after it is best effort.
      const created = await createSlots({
        scope: {
          workspaceId: auth.workspaceId,
          projectId,
          brandId: auth.defaultBrandId,
          userId: auth.userId,
        },
        workId: work.id,
        timezone,
        via: "idea",
        cardTitle,
        rawText: clickRow.rawText,
        replyText: clickRow.replyText,
        targets: slotTargets,
        brandCheck: brandCheckOf(rules),
      });
      if (!created.ok) {
        return { ok: false, code: created.code, message: created.message };
      }

      // Also when alreadyScheduled: an earlier failed advance self-heals.
      let ideaStatus: IdeaStatus = idea.status;
      await bestEffort("advance idea", async () => {
        ideaStatus = await IdeaRepository.advanceForScheduling(
          ideaIdOk.data,
          projectId,
        );
      });
      await bestEffort("touch work", () =>
        WorkRepository.touch(projectId, work.id, {
          summary: workSummaryFrom(cardTitle),
        }),
      );
      if (!created.alreadyScheduled) {
        await bestEffort("audit slot.scheduled", () =>
          recordAudit(auth, projectId, {
            action: "slot.scheduled",
            entityType: "Command",
            entityId: created.commandId,
            metadata: {
              via: "idea",
              origin,
              channels: unique.map((t) => t.channel),
              dates: unique.map((t) => t.date),
              ...(matched.length > 0
                ? { allowIssues: true, matched, userId: auth.userId }
                : {}),
            },
          }),
        );
        await bestEffort("audit content_plan.saved", () =>
          recordAudit(auth, projectId, {
            action: "content_plan.saved",
            entityType: "Command",
            entityId: created.commandId,
            metadata:
              matched.length > 0
                ? {
                    items: created.created.length,
                    allowIssues: true,
                    matched,
                    userId: auth.userId,
                  }
                : { items: created.created.length },
          }),
        );
      }
      refreshWorkPages(projectId, [`/projects/${projectId}/takvim`]);

      return {
        ok: true,
        commandId: created.commandId,
        alreadyScheduled: created.alreadyScheduled,
        slots: [
          ...created.created.map((slot) => ({ ...slot, existed: false })),
          ...created.existing.map((slot) => ({
            channel: slot.channel,
            formatKey: slot.formatKey,
            date: slot.date,
            time: slot.time,
            creativeId: slot.creativeId,
            existed: true,
          })),
        ],
        ideaStatus,
        timezone,
      };
    },
  );
}

function recordAudit(
  auth: WorksAuth,
  projectId: string,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown>;
  },
) {
  return AuditLogRepository.record({
    workspaceId: auth.workspaceId,
    projectId,
    brandId: auth.defaultBrandId,
    actorType: "USER",
    actorId: auth.userId,
    ...entry,
  });
}

// The Creative (WITH projectId) must be a slot of a plan of THIS Work: a plan
// Command carrying the workId, a saved card that lists the Creative.
async function slotOfWork(
  projectId: string,
  workId: string,
  creativeId: string,
) {
  const creative = await prisma.creative.findFirst({
    where: { id: creativeId, projectId },
    select: {
      id: true,
      status: true,
      planId: true,
      currentVersionId: true,
      channel: true,
      formatKey: true,
    },
  });
  if (!creative?.planId) return null;
  const plan = await prisma.command.findFirst({
    where: { id: creative.planId, projectId, workId },
    select: { id: true, parsedIntent: true },
  });
  const card = plan ? planCardOf(plan.parsedIntent) : null;
  const ids = card?.savedCreativeIds;
  if (!plan || !card || !Array.isArray(ids) || !ids.includes(creativeId)) {
    return null;
  }
  return { creative, planId: plan.id, card };
}

// The other channels of a removed piece's post that have no content and no job
// are archived with it; once none of the post is left, the post is archived
// too. Returns the ids archived here.
async function removePostMatesInTx(
  tx: Prisma.TransactionClient,
  input: {
    creativeId: string;
    projectId: string;
    busy: (creativeId: string) => boolean;
  },
): Promise<string[]> {
  const self = await tx.creative.findUnique({
    where: { id: input.creativeId },
    select: { postId: true },
  });
  if (!self?.postId) return [];
  const mates = await tx.creative.findMany({
    where: {
      postId: self.postId,
      projectId: input.projectId,
      id: { not: input.creativeId },
      status: { not: "ARCHIVED" },
    },
    select: { id: true, status: true, currentVersionId: true },
  });
  const free = mates
    .filter(
      (mate) =>
        mate.status === "DRAFT" && !mate.currentVersionId && !input.busy(mate.id),
    )
    .map((mate) => mate.id);
  if (free.length > 0) {
    await tx.creative.updateMany({
      where: {
        id: { in: free },
        projectId: input.projectId,
        status: "DRAFT",
        currentVersionId: null,
      },
      data: { status: "ARCHIVED" },
    });
  }
  if (free.length === mates.length) {
    await tx.post.update({
      where: { id: self.postId },
      data: { archivedAt: new Date() },
    });
  }
  return free;
}

function taskTargets(payload: unknown, creativeId: string): boolean {
  return (
    (payload as { planCreativeId?: unknown } | null)?.planCreativeId ===
    creativeId
  );
}

export async function moveSlotAction(
  projectId: string,
  workId: string,
  creativeId: string,
  to: { date: string; time: string },
): Promise<MoveSlotResult> {
  return guardedAction("move-slot", async (): Promise<MoveSlotResult> => {
    const gate = await authorizeWorks(projectId, SCHEDULE_BUCKET);
    if (!gate.ok) return gate;
    const { auth } = gate;

    const workIdOk = idSchema.safeParse(workId);
    const creativeIdOk = idSchema.safeParse(creativeId);
    if (
      !workIdOk.success ||
      !creativeIdOk.success ||
      typeof to?.date !== "string" ||
      typeof to?.time !== "string"
    ) {
      return { ok: false, code: "INVALID", message: INVALID_MESSAGE };
    }

    const found = await activeWork(projectId, workIdOk.data);
    if (!found.ok) return found;

    const slot = await slotOfWork(projectId, workIdOk.data, creativeIdOk.data);
    if (!slot) {
      return { ok: false, code: "NOT_FOUND", message: INVALID_MESSAGE };
    }
    if (
      !(MOVABLE_STATUSES as readonly string[]).includes(slot.creative.status)
    ) {
      return { ok: false, code: "LOCKED", message: INVALID_MESSAGE };
    }

    // The card's own zone: the item times it shows are read in that zone.
    const index = slot.card.savedCreativeIds?.indexOf(creativeIdOk.data) ?? -1;
    const item = slot.card.items[index];
    const channel = item?.channel ?? slot.creative.channel ?? "";
    const formatKey =
      item?.formatKey ??
      slot.creative.formatKey ??
      (isChannelKey(channel) ? defaultFormat(channel).key : "");
    const timezone =
      slot.card.timezone || (await getProjectTimezone(projectId));
    const verdict = validateSlotTargets({
      targets: [{ channel, formatKey, date: to.date, time: to.time }],
      ...clockOf(timezone),
    });
    if (!verdict.ok) {
      if (verdict.code === "PAST") {
        return {
          ok: false,
          code: "STALE",
          message: verdict.message,
          suggestion: await freshSuggestion(projectId, channel),
        };
      }
      return { ok: false, code: "INVALID", message: verdict.message };
    }

    const scheduledFor = zonedDateTimeToUtc(`${to.date}T${to.time}`, timezone);
    try {
      // Creative and card item change together: production reads the
      // Creative, the card is what the person sees, they must never diverge.
      await prisma.$transaction(
        async (tx) => {
          const moved = await tx.creative.updateMany({
            where: {
              id: creativeIdOk.data,
              projectId,
              planId: slot.planId,
              status: { in: [...MOVABLE_STATUSES] },
            },
            data: { scheduledFor },
          });
          if (moved.count !== 1) {
            throw new SlotTxRefusal("LOCKED", INVALID_MESSAGE);
          }
          // The post moves as one: its other channels and its own time.
          const post = await movePostInTx(tx, {
            creativeId: creativeIdOk.data,
            projectId,
            scheduledFor,
            movable: MOVABLE_STATUSES,
          });
          if (!post.ok) throw new SlotTxRefusal("LOCKED", POST_OUT_MESSAGE);
          const movedIds = new Set([creativeIdOk.data, ...post.moved]);
          const written = await updateCardInTx(tx, {
            commandId: slot.planId,
            projectId,
            expectKinds: ["content-plan-draft"],
            requireActiveWork: true,
            update: (card) => {
              if (card.kind !== "content-plan-draft") {
                return { reject: INVALID_MESSAGE };
              }
              const at =
                card.savedCreativeIds?.indexOf(creativeIdOk.data) ?? -1;
              if (
                at < 0 ||
                !card.items[at] ||
                card.items[at]?.removed === true
              ) {
                return { reject: INVALID_MESSAGE };
              }
              const ids = card.savedCreativeIds ?? [];
              return {
                ...card,
                items: card.items.map((entry, i) =>
                  movedIds.has(ids[i] ?? "")
                    ? { ...entry, date: to.date, time: to.time }
                    : entry,
                ),
              };
            },
          });
          if (!written.ok) {
            throw new SlotTxRefusal(
              written.code === "WORK_INACTIVE" ? "LOCKED" : "NOT_FOUND",
              written.message,
            );
          }
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (error instanceof SlotTxRefusal) {
        return { ok: false, code: error.code, message: error.message };
      }
      if (isWriteConflict(error)) {
        return { ok: false, code: "BUSY", message: copyText("plan.saving") };
      }
      throw error;
    }

    await bestEffort("audit slot.moved", () =>
      recordAudit(auth, projectId, {
        action: "slot.moved",
        entityType: "Creative",
        entityId: creativeIdOk.data,
        metadata: { workId: workIdOk.data, date: to.date, time: to.time },
      }),
    );
    refreshWorkPages(projectId, [`/projects/${projectId}/takvim`]);
    return { ok: true, date: to.date, time: to.time };
  });
}

// The only archive path: a mis-tapped "Add to calendar" is undone here, and
// only while the piece has no content at all.
export async function removeSlotAction(
  projectId: string,
  workId: string,
  creativeId: string,
): Promise<RemoveSlotResult> {
  const result = await removeSlot(projectId, workId, creativeId);
  // The result type has no INVALID: a malformed id is a plain failure.
  if (result.ok) return result;
  return result.code === "INVALID"
    ? { ok: false, code: "FAILED", message: result.message }
    : { ok: false, code: result.code, message: result.message };
}

async function removeSlot(
  projectId: string,
  workId: string,
  creativeId: string,
) {
  return guardedAction("remove-slot", async (): Promise<RemoveSlotResult> => {
    const gate = await authorizeWorks(projectId, SCHEDULE_BUCKET);
    if (!gate.ok) {
      return gate.code === "DISABLED" || gate.code === "RATE"
        ? { ok: false, code: gate.code, message: gate.message }
        : { ok: false, code: "FAILED", message: gate.message };
    }
    const { auth } = gate;

    const workIdOk = idSchema.safeParse(workId);
    const creativeIdOk = idSchema.safeParse(creativeId);
    if (!workIdOk.success || !creativeIdOk.success) {
      return { ok: false, code: "FAILED", message: INVALID_MESSAGE };
    }

    const found = await activeWork(projectId, workIdOk.data);
    if (!found.ok) {
      return {
        ok: false,
        code: found.code === "WORK" ? "WORK" : "NOT_FOUND",
        message: found.message,
      };
    }

    const slot = await slotOfWork(projectId, workIdOk.data, creativeIdOk.data);
    if (!slot) {
      return { ok: false, code: "NOT_FOUND", message: INVALID_MESSAGE };
    }
    const locked = {
      ok: false as const,
      code: "LOCKED" as const,
      message: copyText("slot.removeLocked"),
    };
    // A second Remove (another tab, a double tap) on a slot that is already
    // archived AND marked removed on the card is a no-op, not a lock.
    if (slot.creative.status === "ARCHIVED") {
      const at = slot.card.savedCreativeIds?.indexOf(creativeIdOk.data) ?? -1;
      if (at >= 0 && slot.card.items[at]?.removed === true) return { ok: true };
    }
    if (slot.creative.status !== "DRAFT" || slot.creative.currentVersionId) {
      return locked;
    }

    try {
      await prisma.$transaction(
        async (tx) => {
          // A running or waiting job of this slot would write into it.
          const tasks = await tx.task.findMany({
            where: {
              projectId,
              commandId: slot.planId,
              status: { notIn: [...TERMINAL_TASK_STATUSES] },
            },
            select: { payload: true },
          });
          if (
            tasks.some((task) => taskTargets(task.payload, creativeIdOk.data))
          ) {
            throw new SlotTxRefusal("LOCKED", locked.message);
          }
          const archived = await tx.creative.updateMany({
            where: {
              id: creativeIdOk.data,
              projectId,
              status: "DRAFT",
              currentVersionId: null,
            },
            data: { status: "ARCHIVED" },
          });
          if (archived.count !== 1) {
            throw new SlotTxRefusal("LOCKED", locked.message);
          }
          // The post goes as one: its other channels without content go too,
          // and a post with nothing left is archived.
          const removedIds = new Set([
            creativeIdOk.data,
            ...(await removePostMatesInTx(tx, {
              creativeId: creativeIdOk.data,
              projectId,
              busy: (id) => tasks.some((task) => taskTargets(task.payload, id)),
            })),
          ]);
          const written = await updateCardInTx(tx, {
            commandId: slot.planId,
            projectId,
            expectKinds: ["content-plan-draft"],
            requireActiveWork: true,
            update: (card) => {
              if (card.kind !== "content-plan-draft") {
                return { reject: INVALID_MESSAGE };
              }
              const ids = card.savedCreativeIds ?? [];
              const at = ids.indexOf(creativeIdOk.data);
              if (at < 0 || !card.items[at]) return { reject: INVALID_MESSAGE };
              // A production run holds this slot (it creates the Task only
              // after claiming): removing now would let the render write into
              // an archived Creative.
              const production = card.production;
              if (
                production?.state === "running" &&
                Date.now() - Date.parse(production.startedAt) <
                  RUN_CLAIM_TTL_MS &&
                production.creativeIds.some((id) => removedIds.has(id))
              ) {
                return { reject: locked.message };
              }
              return {
                ...card,
                items: card.items.map((entry, i) =>
                  removedIds.has(ids[i] ?? "") ? { ...entry, removed: true } : entry,
                ),
              };
            },
          });
          if (!written.ok) {
            throw new SlotTxRefusal(
              written.code === "WORK_INACTIVE" ||
              written.message === locked.message
                ? "LOCKED"
                : "NOT_FOUND",
              written.message,
            );
          }
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (error instanceof SlotTxRefusal) {
        return { ok: false, code: error.code, message: error.message };
      }
      if (isWriteConflict(error)) {
        return { ok: false, code: "FAILED", message: copyText("plan.saving") };
      }
      throw error;
    }

    await bestEffort("audit slot.removed", () =>
      recordAudit(auth, projectId, {
        action: "slot.removed",
        entityType: "Creative",
        entityId: creativeIdOk.data,
        metadata: { workId: workIdOk.data },
      }),
    );
    refreshWorkPages(projectId, [`/projects/${projectId}/takvim`]);
    return { ok: true };
  });
}
