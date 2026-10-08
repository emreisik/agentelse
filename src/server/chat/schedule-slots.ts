import "server-only";

import type { Prisma } from "@prisma/client";

import { isChannelKey, type ChannelKey } from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import type { BrandCheckState, BrandFlag } from "@/lib/works/brand-rules";
import { copyText } from "@/lib/works/copy";
import {
  isSlotOrigin,
  slotOriginKey,
  type SlotOrigin,
} from "@/lib/works/slot-origin";
import { sanitizeClickText } from "@/lib/works/slot-rules";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import { createWorkInTx, type NewWorkInput } from "@/server/works/draft-plan-work";

import { buildPlanCard } from "./content-plan";
import { createPostsInTx, savePlanSlotsInTx } from "./save-plan-core";

// The ONE place that writes Creative.planId for Works (spec 3.4.2, 3.5.3):
// buttons get a synthetic plan row (createSlots), the agent writes the card on
// its own turn row (writeSlotsOnCommandInTx) or appends to it
// (appendSlotInTx). All of them end in savePlanSlotsInTx or its field mapping.

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];
type PlanVia = NonNullable<PlanCard["via"]>;

export type SlotScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
};

export type SlotTarget = {
  channel: string;
  formatKey: string;
  date: string;
  time: string;
  topic: string;
  captionIdea: string;
  origin: SlotOrigin;
  ideaId?: string;
  // The brand's own photos the post is made from (docs/brand-media.md).
  photoAssetIds?: string[];
  brandFlags?: BrandFlag[];
};

export type ExistingSlot = {
  key: string;
  commandId: string;
  creativeId: string;
  channel: string;
  formatKey: string;
  date: string;
  time: string;
  scheduledFor: Date | null;
};

export type CreatedSlot = {
  creativeId: string;
  channel: string;
  formatKey: string;
  date: string;
  time: string;
};

export type CreateSlotsInput = {
  scope: SlotScope;
  workId: string;
  // The chat to open with the slots (an idea made into a post from the Ideas
  // board): created as `workId` in the same transaction, only when there is
  // something to put on the calendar. Without it the Work already exists.
  newWork?: Omit<NewWorkInput, "workId" | "workspaceId" | "projectId">;
  timezone: string;
  via: PlanVia;
  cardTitle: string;
  // Both texts are replayed to the model (as a user message and as its own
  // words), so the caller passes channel labels, times and format labels
  // only, never idea text (review SC-7).
  rawText: string;
  replyText: string;
  targets: readonly SlotTarget[];
  goal?: string;
  brandCheck?: BrandCheckState;
};

export type CreateSlotsResult =
  | {
      ok: true;
      commandId: string;
      created: CreatedSlot[];
      existing: ExistingSlot[];
      alreadyScheduled: boolean;
    }
  | { ok: false; code: "BUSY" | "FAILED"; message: string };

type Db = Prisma.TransactionClient;

type SlotKeyInput = { origin: SlotOrigin; channel: string; formatKey: string };

const RAW_TEXT_MAX = 80;
const REPLY_TEXT_MAX = 800;
const FALLBACK_RAW_TEXT = "Add to calendar";
// Safety bound of the origin lookup, never a correctness limit: the database
// only returns Commands that really hold the origin.
const EXISTING_LOOKUP_LIMIT = 20;
const DEAD_STATUSES = ["ARCHIVED", "REJECTED"] as const;

// Thrown inside a transaction so everything written so far rolls back.
class SlotWriteError extends Error {}

function isWriteConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2034"
  );
}

function cardOf(parsedIntent: unknown): unknown {
  return (parsedIntent as { card?: unknown } | null)?.card;
}

function isPlanCard(card: unknown): card is PlanCard {
  return (
    typeof card === "object" &&
    card !== null &&
    (card as { kind?: unknown }).kind === "content-plan-draft" &&
    Array.isArray((card as { items?: unknown }).items)
  );
}

// Same comparator as buildPlanCard's sort, so presorting keeps the order and
// the by-index zip of origin / ideaId onto the built items stays aligned.
function bySlotTime(a: SlotTarget, b: SlotTarget): number {
  return `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`);
}

function buildSlotItems(
  title: string,
  timezone: string,
  targets: readonly SlotTarget[],
): PlanItem[] {
  const sorted = [...targets].sort(bySlotTime);
  const channels = sorted.map((target) => {
    if (!isChannelKey(target.channel)) {
      throw new SlotWriteError(`Unknown channel ${target.channel}.`);
    }
    return target.channel as ChannelKey;
  });
  const built = buildPlanCard(
    {
      title,
      items: sorted.map((target, index) => ({
        date: target.date,
        time: target.time,
        channel: channels[index],
        formatKey: target.formatKey,
        topic: target.topic,
        captionIdea: target.captionIdea,
      })),
    },
    timezone,
  );
  return built.items.map((item, index) => {
    const target = sorted[index];
    if (!target) throw new SlotWriteError("Plan items are out of step.");
    return {
      ...item,
      origin: target.origin,
      ...(target.ideaId ? { ideaId: target.ideaId } : {}),
      ...(target.photoAssetIds && target.photoAssetIds.length > 0
        ? { photoAssetIds: target.photoAssetIds }
        : {}),
      ...(target.brandFlags && target.brandFlags.length > 0
        ? { brandFlags: target.brandFlags }
        : {}),
    };
  });
}

function draftCard(args: {
  title: string;
  timezone: string;
  via: PlanVia;
  items: PlanItem[];
  goal?: string;
  brandCheck?: BrandCheckState;
}): PlanCard {
  return {
    kind: "content-plan-draft",
    title: args.title.trim(),
    timezone: args.timezone,
    state: "draft",
    ...(args.goal ? { goal: args.goal } : {}),
    ...(args.brandCheck ? { brandCheck: args.brandCheck } : {}),
    via: args.via,
    items: args.items,
  };
}

// Which of the wanted keys already hold a LIVE slot in this project.
// De-duplication is project-wide on purpose (spec 3.4.2).
export async function findExistingSlots(
  db: Db,
  projectId: string,
  keys: readonly SlotKeyInput[],
): Promise<ExistingSlot[]> {
  if (keys.length === 0) return [];
  const wanted = new Set(
    keys.map((k) => slotOriginKey(k.origin, k.channel, k.formatKey)),
  );
  const origins = new Map<string, SlotOrigin>();
  for (const { origin } of keys) {
    origins.set(`${origin.kind}:${origin.ref}`, origin);
  }

  // Database-side filter (jsonb @>): only Commands that really hold one of
  // the origins come back, so no card JSON is scanned in memory (review SC-12).
  const rows = await db.command.findMany({
    where: {
      projectId,
      AND: [
        {
          parsedIntent: {
            path: ["card", "kind"],
            equals: "content-plan-draft",
          },
        },
        {
          OR: [...origins.values()].map((o) => ({
            parsedIntent: {
              path: ["card", "items"],
              array_contains: [{ origin: { kind: o.kind, ref: o.ref } }],
            },
          })),
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: EXISTING_LOOKUP_LIMIT,
    select: { id: true, parsedIntent: true },
  });

  type Candidate = Omit<ExistingSlot, "scheduledFor">;
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const card = cardOf(row.parsedIntent);
    if (!isPlanCard(card) || card.state !== "saved") continue;
    const ids = card.savedCreativeIds;
    if (!Array.isArray(ids)) continue;
    card.items.forEach((item, index) => {
      const creativeId = ids[index];
      if (
        typeof creativeId !== "string" ||
        item.removed === true ||
        !isSlotOrigin(item.origin) ||
        typeof item.channel !== "string" ||
        typeof item.formatKey !== "string"
      ) {
        return;
      }
      const key = slotOriginKey(item.origin, item.channel, item.formatKey);
      if (!wanted.has(key)) return;
      candidates.push({
        key,
        commandId: row.id,
        creativeId,
        channel: item.channel,
        formatKey: item.formatKey,
        date: item.date,
        time: item.time,
      });
    });
  }
  if (candidates.length === 0) return [];

  // A slot whose Creative is archived or rejected no longer counts.
  const alive = await db.creative.findMany({
    where: {
      id: { in: candidates.map((c) => c.creativeId) },
      projectId,
      status: { notIn: [...DEAD_STATUSES] },
    },
    select: { id: true, scheduledFor: true },
  });
  const scheduled = new Map(alive.map((c) => [c.id, c.scheduledFor]));

  const found = new Map<string, ExistingSlot>();
  for (const candidate of candidates) {
    if (found.has(candidate.key) || !scheduled.has(candidate.creativeId))
      continue;
    found.set(candidate.key, {
      ...candidate,
      scheduledFor: scheduled.get(candidate.creativeId) ?? null,
    });
  }
  return [...found.values()];
}

// One more slot on a saved card: a post of its own (one delivery).
async function createSlotCreative(
  tx: Db,
  scope: SlotScope,
  commandId: string,
  card: Pick<PlanCard, "goal" | "timezone">,
  item: PlanItem,
  workId: string | null,
): Promise<string> {
  const [creativeId] = await createPostsInTx(tx, scope, {
    commandId,
    workId,
    goal: card.goal,
    timezone: card.timezone,
    items: [item],
  });
  return creativeId!;
}

async function createSlotsOnce(
  input: CreateSlotsInput,
): Promise<CreateSlotsResult> {
  const { scope } = input;
  const targets = [...input.targets].sort(bySlotTime);

  return prisma.$transaction(
    async (tx): Promise<CreateSlotsResult> => {
      const existing = await findExistingSlots(
        tx,
        scope.projectId,
        targets.map((t) => ({
          origin: t.origin,
          channel: t.channel,
          formatKey: t.formatKey,
        })),
      );
      const existingKeys = new Set(existing.map((slot) => slot.key));
      const missing = targets.filter(
        (t) =>
          !existingKeys.has(slotOriginKey(t.origin, t.channel, t.formatKey)),
      );

      const first = existing[0];
      if (missing.length === 0 && first) {
        // Hand back the plan that already holds the slot, so a retried
        // "Add & produce" can still start production (review SC-31).
        return {
          ok: true,
          commandId: first.commandId,
          created: [],
          existing,
          alreadyScheduled: true,
        };
      }

      const card = draftCard({
        title: input.cardTitle,
        timezone: input.timezone,
        via: input.via,
        items: buildSlotItems(input.cardTitle, input.timezone, missing),
        goal: input.goal,
        brandCheck: input.brandCheck,
      });
      if (input.newWork) {
        await createWorkInTx(tx, {
          ...input.newWork,
          workId: input.workId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        });
      }
      const rawText =
        sanitizeClickText(input.rawText, RAW_TEXT_MAX) || FALLBACK_RAW_TEXT;
      // ideaId and topic stay unset: a set ideaId would hide the row from the
      // Work and divert its production cards to the idea thread.
      const command = await tx.command.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          brandId: scope.brandId,
          workId: input.workId,
          source: "WEB",
          rawText,
          replyText: sanitizeClickText(input.replyText, REPLY_TEXT_MAX),
          replyStatus: "ANSWERED",
          parsedIntent: { card } as unknown as Prisma.InputJsonValue,
          createdByUserId: scope.userId,
        },
        select: { id: true },
      });
      const saved = await savePlanSlotsInTx(tx, scope, command.id);
      if (!saved.ok) throw new SlotWriteError(saved.error);

      return {
        ok: true,
        commandId: command.id,
        created: card.items.map((item, index) => ({
          creativeId: saved.creativeIds[index] ?? "",
          channel: item.channel ?? "",
          formatKey: item.formatKey ?? "",
          date: item.date,
          time: item.time,
        })),
        existing,
        alreadyScheduled: false,
      };
    },
    { isolationLevel: "Serializable" },
  );
}

// A button press: finds what is already on the calendar, creates the rest as
// ONE synthetic WEB plan row (never the Command first, never without its
// Creatives). A race (P2034) is re-looked-up once, then reported as BUSY.
export async function createSlots(
  input: CreateSlotsInput,
): Promise<CreateSlotsResult> {
  if (input.targets.length === 0) {
    return { ok: false, code: "FAILED", message: copyText("kit.failed") };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await createSlotsOnce(input);
    } catch (error) {
      if (error instanceof SlotWriteError) {
        return { ok: false, code: "FAILED", message: copyText("kit.failed") };
      }
      // The second run sees the winner's rows and answers alreadyScheduled.
      if (!isWriteConflict(error)) throw error;
    }
  }
  return { ok: false, code: "BUSY", message: copyText("plan.saving") };
}

// Slot-first: the agent's own turn row gets the plan card, then the very same
// save core runs. The row must not hold a card yet; throws (so the caller's
// transaction rolls back) on anything else.
export async function writeSlotsOnCommandInTx(
  tx: Db,
  scope: SlotScope,
  commandId: string,
  draft: {
    title: string;
    timezone: string;
    via: PlanVia;
    items: readonly SlotTarget[];
    brandCheck?: BrandCheckState;
  },
): Promise<{ creativeIds: string[] }> {
  const row = await tx.command.findUnique({
    where: { id: commandId },
    select: { parsedIntent: true, projectId: true },
  });
  if (!row || row.projectId !== scope.projectId) {
    throw new SlotWriteError(copyText("plan.notFound"));
  }
  const intent = row.parsedIntent as Record<string, unknown> | null;
  if (cardOf(intent) !== undefined && cardOf(intent) !== null) {
    throw new SlotWriteError("This message already has a card.");
  }
  const card = draftCard({
    title: draft.title,
    timezone: draft.timezone,
    via: draft.via,
    items: buildSlotItems(draft.title, draft.timezone, draft.items),
    brandCheck: draft.brandCheck,
  });
  await tx.command.update({
    where: { id: commandId },
    data: {
      parsedIntent: { ...intent, card } as unknown as Prisma.InputJsonValue,
    },
  });
  const saved = await savePlanSlotsInTx(tx, scope, commandId);
  if (!saved.ok) throw new SlotWriteError(saved.error);
  return { creativeIds: saved.creativeIds };
}

// Work sessions: the 2nd..6th slot-first call of a turn appends to the same
// saved "generate" card. Any other card (a plan, options, master) is never
// touched; throws so the caller's transaction rolls back.
export async function appendSlotInTx(
  tx: Db,
  scope: SlotScope,
  commandId: string,
  target: SlotTarget,
): Promise<{ creativeId: string }> {
  const row = await tx.command.findUnique({
    where: { id: commandId },
    select: { parsedIntent: true, projectId: true, workId: true },
  });
  const intent = row?.parsedIntent as
    Record<string, unknown> | null | undefined;
  const card = cardOf(intent);
  if (
    !row ||
    row.projectId !== scope.projectId ||
    !isPlanCard(card) ||
    card.state !== "saved" ||
    card.via !== "generate"
  ) {
    throw new SlotWriteError("Only a generated plan can take another slot.");
  }
  const ids = card.savedCreativeIds;
  if (!Array.isArray(ids) || ids.length !== card.items.length) {
    throw new SlotWriteError("This plan is out of step with its slots.");
  }

  const [item] = buildSlotItems(card.title, card.timezone, [target]);
  if (!item) throw new SlotWriteError("Could not build the slot.");
  const creativeId = await createSlotCreative(
    tx,
    scope,
    commandId,
    card,
    item,
    row.workId,
  );
  await tx.command.update({
    where: { id: commandId },
    data: {
      parsedIntent: {
        ...intent,
        card: {
          ...card,
          items: [...card.items, item],
          savedCreativeIds: [...ids, creativeId],
        },
      } as unknown as Prisma.InputJsonValue,
    },
  });
  return { creativeId };
}
