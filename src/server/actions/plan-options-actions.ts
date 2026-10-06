"use server";

import { Prisma } from "@prisma/client";

import { CHANNELS, isChannelKey, isPlanGoal } from "@/lib/content-channels";
import type { ChannelConnections } from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import {
  blocksOf,
  brandCheckOf,
  checkItems,
  flagsForItem,
  type BrandFlag,
  type BrandRuleSet,
} from "@/lib/works/brand-rules";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import { copyText } from "@/lib/works/copy";
import {
  PLAN_ALTERNATIVES_PER_SLOT,
  alternativesFromOptions,
  canSwapSlot,
  swapItem,
  type PlanAlternative,
  type SwapSlotState,
} from "@/lib/works/plan-alternatives";
import { creativeFieldsOfPlanItem } from "@/lib/works/plan-item-fields";
import { deliveriesOfCard } from "@/lib/works/plan-layout";
import { postKeyOf } from "@/lib/works/plan-platforms";
import {
  optionItems,
  type PlanOptionsCardData,
} from "@/lib/works/plan-options";
import { updateCardInTx, updateCommandCard } from "@/server/chat/card-store";
import { markIdeasPlanned } from "@/server/chat/idea-pool";
import {
  buildPlanCard,
  supersedeOpenPlanCards,
} from "@/server/chat/content-plan";
import { RUN_CLAIM_TTL_MS } from "@/server/chat/plan-run";
import { planCreativeIdOf } from "@/server/execution/plan-creative-link";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import { isAgentelseError } from "@/server/security/errors";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { isWorksEnabled } from "@/server/works/flag";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
  refreshWorkPages,
} from "@/server/works/guard";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Server Actions of the plan directions card (spec 3.2.4 and 3.3.3): pick one
// direction and swap one post's idea for an alternative. DB only, no model
// call: the other directions' ideas already sit next to every post. Every
// card write goes through the atomic card writer with requireActiveWork, so a
// direct POST cannot change a completed Work. The client does not call
// router.refresh() after success: the action response carries the new page.

type PlanDraft = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanDraft["items"][number];

export type PickPlanOptionResult =
  | { ok: true; alreadyPicked?: boolean; title: string }
  | {
      ok: false;
      code:
        | "DISABLED"
        | "RATE"
        | "NOT_FOUND"
        | "STATE"
        | "PICKED"
        | "WORK"
        | "FAILED";
      message: string;
    };

export type SwapPlanItemResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "DISABLED"
        | "RATE"
        | "NOT_FOUND"
        | "STALE"
        | "RANGE"
        | "LOCKED"
        | "WORK"
        | "FAILED";
      message: string;
    };

const PICK_BUCKET = { bucket: "plan-pick", limit: 30 } as const;
const SWAP_BUCKET = { bucket: "plan-swap", limit: 60 } as const;

const TITLE_MAX = 90;
const TOPIC_MAX = 120;
const BRIEF_MAX = 300;
const MAX_TX_ATTEMPTS = 3;
const TERMINAL_TASK = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const NOT_FOUND_MESSAGE = "Plan not found.";

const FAILED_MESSAGE = GUARD_MESSAGE.failed;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : text;
}

// "Instagram", "Instagram and LinkedIn", "Instagram, LinkedIn and X".
function channelLabels(channels: readonly string[]): string {
  const labels = [
    ...new Set(
      channels.map((key) => (isChannelKey(key) ? CHANNELS[key].label : key)),
    ),
  ];
  if (labels.length <= 1) return labels[0] ?? "your channels";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function isWriteConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2034"
  );
}

type Looked =
  | { ok: true; projectId: string }
  | { ok: false; code: "NOT_FOUND"; message: string };

// The Command is looked up first only to learn its project; every later read
// and write compares that project again (a foreign id is NOT_FOUND).
async function projectOfCommand(commandId: unknown): Promise<Looked> {
  const parsed = idSchema.safeParse(commandId);
  if (!parsed.success) {
    return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
  }
  const row = await prisma.command.findUnique({
    where: { id: parsed.data },
    select: { projectId: true },
  });
  if (!row?.projectId) {
    return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
  }
  return { ok: true, projectId: row.projectId };
}

// Access refusals are not told apart from a missing card.
async function authorizeFor(
  projectId: string,
  opts: { bucket: string; limit: number },
) {
  try {
    return await authorizeWorks(projectId, opts);
  } catch (error) {
    if (isAgentelseError(error)) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        message: NOT_FOUND_MESSAGE,
      };
    }
    throw error;
  }
}

function brandFlagsOf(
  items: readonly { topic: string; captionIdea: string }[],
  rules: BrandRuleSet | null,
): BrandFlag[][] {
  const all = checkItems(items, rules);
  return items.map((_, index) => flagsForItem(all, index));
}

// A direction's idea that breaks a brand rule outright is never offered.
function withoutBlocked(
  alternatives: readonly PlanAlternative[],
  rules: BrandRuleSet | null,
): PlanAlternative[] {
  return alternatives.filter(
    (alt) => blocksOf(checkItems([alt], rules)).length === 0,
  );
}

export async function pickPlanOptionAction(
  commandId: string,
  optionId: string,
): Promise<PickPlanOptionResult> {
  const result = await guardedAction("plan-pick", async (): Promise<PickPlanOptionResult> => {
    if (!isWorksEnabled()) {
      return { ok: false, code: "DISABLED", message: GUARD_MESSAGE.disabled };
    }
    const looked = await projectOfCommand(commandId);
    if (!looked.ok) return looked;
    const option = idSchema.safeParse(optionId);
    if (!option.success) {
      return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
    }
    const { projectId } = looked;
    const gate = await authorizeFor(projectId, PICK_BUCKET);
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.code === "INVALID" ? "FAILED" : gate.code,
        message: gate.message,
      };
    }

    // IO before the transaction: it only does card work.
    const [rules, connections] = await Promise.all([
      loadBrandRules({
        projectId,
        brandId: gate.auth.defaultBrandId,
        language: await brandRuleLanguageOf(projectId),
      }),
      getChannelConnections(projectId).catch(
        (): ChannelConnections | undefined => undefined,
      ),
    ]);

    let refusal: {
      code: "STATE" | "PICKED" | "FAILED";
      message: string;
    } | null = null;
    let alreadyPicked = false;
    let workId: string | null = null;
    let draftTitle = "";

    const refuse = (
      code: "STATE" | "PICKED" | "FAILED",
      message: string,
    ): { reject: string } => {
      refusal = { code, message };
      return { reject: message };
    };

    const result = await updateCommandCard({
      commandId,
      projectId,
      expectKinds: ["content-plan-options", "content-plan-draft"],
      requireActiveWork: true,
      update: (card, row) => {
        workId = row.workId;
        if (card.kind === "content-plan-draft") {
          const picked = (card as PlanDraft).fromOption;
          if (!picked)
            return refuse("STATE", copyText("planOptions.pickFailed"));
          if (picked.id === option.data) {
            // Replay: the same direction is already the plan.
            alreadyPicked = true;
            draftTitle = card.title;
            return null;
          }
          return refuse("PICKED", copyText("planOptions.alreadyPicked"));
        }
        if (card.kind !== "content-plan-options") {
          return refuse("STATE", copyText("planOptions.pickFailed"));
        }
        const options = card as unknown as PlanOptionsCardData;
        if (options.state !== "open") {
          return refuse("STATE", copyText("planOptions.replaced"));
        }
        const pickedIndex = options.options.findIndex(
          (candidate) => candidate.id === option.data,
        );
        const picked = options.options[pickedIndex];
        const source = optionItems(options, option.data);
        if (!picked || !source) {
          return refuse("FAILED", copyText("planOptions.pickFailed"));
        }

        // A corrupt stored channel must not become a plan.
        if (source.some((item) => !isChannelKey(item.channel))) {
          return refuse("FAILED", copyText("planOptions.pickFailed"));
        }
        const draft = buildPlanCard(
          {
            title: clip(`${options.title} · ${picked.label}`, TITLE_MAX),
            goal: isPlanGoal(options.goal) ? options.goal : undefined,
            items: source.flatMap((item) =>
              isChannelKey(item.channel)
                ? [
                    {
                      date: item.date,
                      time: item.time,
                      channel: item.channel,
                      formatKey: item.formatKey,
                      topic: item.topic,
                      captionIdea: item.captionIdea,
                    },
                  ]
                : [],
            ),
          },
          options.timezone,
          connections,
        );

        // buildPlanCard drops unknown item fields and stable-sorts by date and
        // time: rebuild its order so the extras land on the right built item
        // (the layout is already sorted, so this is the identity).
        const order = source
          .map((item, index) => ({ key: `${item.date}T${item.time}`, index }))
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((entry) => entry.index);

        const flags = brandFlagsOf(draft.items, rules);
        const optionsForAlt = options.options.map((candidate) => ({
          label: candidate.label,
          ideas: candidate.ideas,
        }));
        const items: PlanItem[] = draft.items.map((built, position) => {
          const slotIndex = order[position] ?? position;
          const extra: PlanItem = { ...built, from: picked.label };
          const itemFlags = flags[position] ?? [];
          if (itemFlags.length > 0) extra.brandFlags = itemFlags;
          const alternatives = withoutBlocked(
            alternativesFromOptions(optionsForAlt, pickedIndex, slotIndex),
            rules,
          ).slice(0, PLAN_ALTERNATIVES_PER_SLOT);
          if (alternatives.length > 0) extra.alternatives = alternatives;
          return extra;
        });

        // The brief's platforms and Story switch ride on the directions card
        // (propose_plan_options): the plan's items are posts, and saving makes
        // each one per platform (piecesOfPlan).
        const deliveries = deliveriesOfCard(options);
        const next: PlanDraft = {
          ...draft,
          items,
          ...deliveries,
          fromOption: { id: picked.id, label: picked.label },
          via: "options",
          alternativesMeta: { runs: 0 },
          brandCheck: brandCheckOf(rules),
        };
        draftTitle = next.title;
        const count = items.length;
        return {
          card: next,
          // The stored reply must not keep saying "Showed 3 plan directions".
          replyText: `Picked the direction "${picked.label}": ${count} ${
            count === 1 ? "post" : "posts"
          } across ${channelLabels([
            ...(deliveries.platforms ?? []),
            ...items.map((item) => item.channel ?? ""),
          ])}.`,
        };
      },
    });

    if (!result.ok) {
      switch (result.code) {
        case "NOT_FOUND":
          return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
        case "WORK_INACTIVE":
          return { ok: false, code: "WORK", message: GUARD_MESSAGE.completed };
        case "WRONG_KIND":
          return {
            ok: false,
            code: "STATE",
            message: copyText("planOptions.pickFailed"),
          };
        case "REJECTED": {
          const reason = refusal as {
            code: "STATE" | "PICKED" | "FAILED";
            message: string;
          } | null;
          return {
            ok: false,
            code: reason?.code ?? "STATE",
            message: reason?.message ?? result.message,
          };
        }
        default:
          return { ok: false, code: "FAILED", message: result.message };
      }
    }

    if (result.changed && workId) {
      // Other open plan cards of THIS Work only; never fails the pick.
      await supersedeOpenPlanCards({
        projectId,
        exceptCommandId: commandId,
        workId,
        kinds: ["content-plan-draft", "content-plan-options"],
      }).catch(() => undefined);
      await WorkRepository.touch(projectId, workId, {
        summary: draftTitle,
      }).catch(() => undefined);
    }
    refreshWorkPages(projectId);
    return alreadyPicked
      ? { ok: true, alreadyPicked: true, title: draftTitle }
      : { ok: true, title: draftTitle };
  });
  return result.ok
    ? result
    : {
        ok: false,
        code: result.code === "INVALID" ? "FAILED" : result.code,
        message: result.message,
      };
}

// Thrown inside the swap transaction to roll the card write back when the slot
// Creative turned out to be taken.
class SlotLockedError extends Error {}

type SwapRefusal = {
  code: "STALE" | "RANGE" | "LOCKED" | "FAILED";
  message: string;
};

type SwapTxOutcome =
  // ideaId: the pool idea a saved post took (it is marked planned).
  | { ok: true; saved: boolean; ideaId?: string | null }
  | {
      ok: false;
      code: "WORK" | "NOT_FOUND" | "LOCKED" | "FAILED" | SwapRefusal["code"];
      message: string;
    };

export async function swapPlanItemAction(
  commandId: string,
  index: number,
  altIndex: number,
  expectTopic: string,
): Promise<SwapPlanItemResult> {
  const result = await guardedAction("plan-swap", async (): Promise<SwapPlanItemResult> => {
    if (!isWorksEnabled()) {
      return { ok: false, code: "DISABLED", message: GUARD_MESSAGE.disabled };
    }
    const looked = await projectOfCommand(commandId);
    if (!looked.ok) return looked;
    const { projectId } = looked;
    const gate = await authorizeFor(projectId, SWAP_BUCKET);
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.code === "INVALID" ? "FAILED" : gate.code,
        message: gate.message,
      };
    }
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      !Number.isInteger(altIndex) ||
      altIndex < 0
    ) {
      return { ok: false, code: "RANGE", message: copyText("planAlt.stale") };
    }
    if (typeof expectTopic !== "string") {
      return { ok: false, code: "STALE", message: copyText("planAlt.stale") };
    }

    const rules = await loadBrandRules({
      projectId,
      brandId: gate.auth.defaultBrandId,
      language: await brandRuleLanguageOf(projectId),
    });

    let outcome: SwapTxOutcome | null = null;
    for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS && !outcome; attempt++) {
      try {
        outcome = await prisma.$transaction(
          (tx) =>
            swapInTx(tx, {
              commandId,
              projectId,
              index,
              altIndex,
              expectTopic,
              rules,
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (error instanceof SlotLockedError) {
          outcome = {
            ok: false,
            code: "LOCKED",
            message: copyText("planAlt.locked"),
          };
        } else if (!isWriteConflict(error)) {
          throw error;
        }
      }
    }
    if (!outcome) {
      return {
        ok: false,
        code: "FAILED",
        message: "This card changed at the same time. Try again.",
      };
    }
    if (!outcome.ok) {
      return outcome as SwapPlanItemResult;
    }

    await AuditLogRepository.record({
      workspaceId: gate.auth.workspaceId,
      projectId,
      brandId: gate.auth.defaultBrandId,
      actorType: "USER",
      actorId: gate.auth.userId,
      action: "content_plan.slot_swapped",
      entityType: "Command",
      entityId: commandId,
      metadata: { index, altIndex, saved: outcome.saved },
    }).catch(() => undefined);

    // A saved post took a pool idea: it leaves the pool now ("Planned"), as
    // it would have when the plan was saved.
    if (outcome.saved && outcome.ideaId) {
      await markIdeasPlanned(projectId, [outcome.ideaId]);
    }

    refreshWorkPages(
      projectId,
      outcome.saved ? [`/projects/${projectId}/takvim`] : [],
    );
    return { ok: true };
  });
  return result.ok
    ? result
    : {
        ok: false,
        code: result.code === "INVALID" ? "FAILED" : result.code,
        message: result.message,
      };
}

async function swapInTx(
  tx: Prisma.TransactionClient,
  input: {
    commandId: string;
    projectId: string;
    index: number;
    altIndex: number;
    expectTopic: string;
    rules: BrandRuleSet | null;
  },
): Promise<SwapTxOutcome> {
  const { commandId, projectId, index, altIndex, expectTopic, rules } = input;

  // Pre-read (same Serializable transaction, so the card cannot move under
  // us): which slot Creative and which Tasks the card guards.
  const peek = await tx.command.findUnique({
    where: { id: commandId },
    select: { parsedIntent: true, projectId: true },
  });
  const peekCard = (
    peek?.parsedIntent as {
      card?: { kind?: string; savedCreativeIds?: unknown };
    } | null
  )?.card;
  const slotCreativeId =
    peek?.projectId === projectId &&
    peekCard?.kind === "content-plan-draft" &&
    Array.isArray(peekCard.savedCreativeIds)
      ? (peekCard.savedCreativeIds as unknown[])[index]
      : undefined;

  // One idea, one post (docs/works.md "Posts"): a new idea is the post's, so
  // it goes to every channel delivery of the post, and only while none of
  // them has content or a job yet.
  let slotState: SwapSlotState = null;
  let postId: string | null = null;
  let postCreativeIds: string[] = [];
  if (typeof slotCreativeId === "string") {
    const [creative, tasks] = await Promise.all([
      tx.creative.findFirst({
        where: { id: slotCreativeId, projectId, planId: commandId },
        select: { status: true, currentVersionId: true, postId: true },
      }),
      tx.task.findMany({
        where: {
          projectId,
          commandId,
          status: { notIn: [...TERMINAL_TASK] },
        },
        select: { payload: true },
      }),
    ]);
    if (creative) {
      postId = creative.postId;
      const deliveries = creative.postId
        ? await tx.creative.findMany({
            where: {
              postId: creative.postId,
              projectId,
              planId: commandId,
              status: { not: "ARCHIVED" },
            },
            select: { id: true, status: true, currentVersionId: true },
          })
        : [{ id: slotCreativeId, ...creative }];
      postCreativeIds = deliveries.map((delivery) => delivery.id);
      const busy = deliveries.find((delivery) => delivery.status !== "DRAFT");
      slotState = {
        status: busy?.status ?? "DRAFT",
        hasVersion: deliveries.some((d) => d.currentVersionId !== null),
        liveTask: tasks.some((task) =>
          postCreativeIds.includes(planCreativeIdOf(task.payload) ?? ""),
        ),
        // Filled from the card inside the callback.
        inRunningClaim: false,
      };
    }
  }

  let refusal: SwapRefusal | null = null;
  const creativeWrites: { id: string; title: string; brief: string }[] = [];
  let postWrite: { topic: string; idea: string; ideaId: string | null } | null =
    null;
  let isSaved = false;
  const reject = (code: SwapRefusal["code"], message: string) => {
    refusal = { code, message };
    return { reject: message };
  };

  const result = await updateCardInTx(tx, {
    commandId,
    projectId,
    expectKinds: ["content-plan-draft"],
    requireActiveWork: true,
    update: (card) => {
      const plan = card as PlanDraft;
      isSaved = plan.state === "saved";
      const items = plan.items;
      if (plan.state === "superseded") {
        const check = canSwapSlot("superseded", null);
        return reject("LOCKED", check.ok ? copyText("planAlt.locked") : check.message);
      }
      const item = items[index];
      if (!item) return reject("RANGE", copyText("planAlt.stale"));
      if (item.removed || item.topic !== expectTopic) {
        return reject("STALE", copyText("planAlt.stale"));
      }
      if (!item.alternatives?.[altIndex]) {
        return reject("RANGE", copyText("planAlt.stale"));
      }

      if (plan.state === "saved") {
        const production = plan.production;
        const claimed =
          production?.state === "running" &&
          Date.now() - Date.parse(production.startedAt) < RUN_CLAIM_TTL_MS &&
          production.creativeIds.some((id) => postCreativeIds.includes(id));
        const check = canSwapSlot(
          "saved",
          slotState ? { ...slotState, inRunningClaim: claimed } : null,
        );
        if (!check.ok) return reject("LOCKED", copyText("planAlt.locked"));
      }

      const next = swapItem(item, altIndex);
      if (!next) return reject("RANGE", copyText("planAlt.stale"));
      const flags = brandFlagsOf([next], rules)[0] ?? [];
      if (flags.length > 0) next.brandFlags = flags;

      // The post's other channel items (same day, time and idea on the card,
      // or the same Post once saved) take the same idea.
      const ids = plan.savedCreativeIds ?? [];
      const key = postKeyOf(item);
      const mates = new Set(
        items.flatMap((entry, i) =>
          i !== index &&
          !entry.removed &&
          (postKeyOf(entry) === key ||
            (plan.state === "saved" && postCreativeIds.includes(ids[i] ?? "")))
            ? [i]
            : [],
        ),
      );
      const nextItems = items.map((existing, i) =>
        i === index ? next : mates.has(i) ? withIdeaOf(existing, next) : existing,
      );

      if (plan.state === "saved") {
        // Production reads the Creative row, and every writer of a Creative
        // title is a path into brand memory: clean again.
        for (const at of [index, ...mates]) {
          const id = ids[at];
          const entry = nextItems[at];
          if (typeof id !== "string" || !entry) continue;
          const fields = creativeFieldsOfPlanItem(entry);
          const title = cleanWorksTextOrNull(fields.title, TOPIC_MAX);
          const brief = cleanWorksTextOrNull(fields.brief, BRIEF_MAX);
          if (!title || !brief) return reject("FAILED", FAILED_MESSAGE);
          creativeWrites.push({ id, title, brief });
        }
        postWrite = {
          topic: next.topic,
          idea: next.captionIdea,
          ideaId: next.ideaId ?? null,
        };
      }
      return { ...plan, items: nextItems };
    },
  });

  if (!result.ok) {
    switch (result.code) {
      case "NOT_FOUND":
        return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
      case "WORK_INACTIVE":
        return { ok: false, code: "WORK", message: GUARD_MESSAGE.completed };
      case "WRONG_KIND":
        return { ok: false, code: "NOT_FOUND", message: NOT_FOUND_MESSAGE };
      case "REJECTED": {
        const reason = refusal as SwapRefusal | null;
        return {
          ok: false,
          code: reason?.code ?? "FAILED",
          message: reason?.message ?? result.message,
        };
      }
      default:
        return { ok: false, code: "FAILED", message: result.message };
    }
  }

  if (isSaved) {
    // Same transaction as the card: a taken slot rolls the card back too.
    for (const write of creativeWrites) {
      const updated = await tx.creative.updateMany({
        where: {
          id: write.id,
          projectId,
          planId: commandId,
          status: "DRAFT",
          currentVersionId: null,
        },
        data: { title: write.title, brief: write.brief },
      });
      if (updated.count !== 1) throw new SlotLockedError();
    }
    const idea = postWrite as {
      topic: string;
      idea: string;
      ideaId: string | null;
    } | null;
    if (postId && idea) {
      await tx.post.update({ where: { id: postId }, data: idea });
    }
  }
  const written = postWrite as { ideaId: string | null } | null;
  return {
    ok: true,
    saved: isSaved,
    ...(isSaved && written ? { ideaId: written.ideaId } : {}),
  };
}

// The idea fields of `next` on another channel item of the same post: its
// channel, format and time stay its own.
const IDEA_FIELDS = [
  "topic",
  "captionIdea",
  "from",
  "ideaId",
  "origin",
  "alternatives",
  "brandFlags",
] as const;

function withIdeaOf<T extends object>(item: T, next: T): T {
  const out = { ...item } as unknown as Record<string, unknown>;
  for (const key of IDEA_FIELDS) {
    if (key in next) out[key] = (next as unknown as Record<string, unknown>)[key];
    else delete out[key];
  }
  return out as T;
}
