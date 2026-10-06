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
import { parseIdeaConcept } from "@/lib/ideas/concept";
import { MAX_POSTS_PER_RUN } from "@/lib/journey";
import { postKeyOf } from "@/lib/works/plan-platforms";
import {
  capPosts,
  leadsToLookUp,
  pictureSources,
  wholePosts,
  type PictureSlot,
  type PictureSource,
} from "@/lib/works/shared-picture";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { isDepartmentInFocus } from "@/server/agency/agency-focus";
import {
  selectProductionBatch,
  toJourneyItem,
  type PlanTaskRow,
} from "@/server/agency/journey/plan-progress";
import { IMAGE_PIECE_COST_USD } from "@/lib/works/cost";
import { planCreativeIdOf } from "@/server/execution/plan-creative-link";
import { ensureProjectActive } from "@/server/projects/activation";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { worksProductionGate } from "@/server/works/production-gate";

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
  // Where its picture comes from: absent = it renders its own (or is text).
  // The other pieces of a post adapt the post's one picture (shared-picture.ts).
  picture?: Exclude<PictureSource, { kind: "render" | "skip" }>;
  // The post layout of the pool idea the post was made from (docs/ideas.md),
  // for the piece that renders the post's own picture: what the Ideas board
  // showed is what is made. Adapting pieces take their own format's layout.
  layoutId?: string;
};

export type PlanClaimResult =
  | { ok: true; slots: ClaimedSlot[]; startedAt: string }
  | { ok: false; message: string };

// Same numbers the plan pane's cost note shows, keyed by the claimed slot's
// own production shape (not formatKey/channel, which a ClaimedSlot does not
// carry) — only the unattended path (runPlan, input.userId === null) spends
// against this.
function slotCostUsd(slot: ClaimedSlot): number {
  if (!slot.production.image) return 0;
  return slot.production.contentFormat === "STORY"
    ? IMAGE_PIECE_COST_USD.story
    : IMAGE_PIECE_COST_USD.post;
}

// postId -> the post layout of the typed pool idea it was made from.
async function ideaLayoutsOf(
  tx: Prisma.TransactionClient,
  postIds: readonly string[],
): Promise<Map<string, string>> {
  const layouts = new Map<string, string>();
  if (postIds.length === 0) return layouts;
  const posts = await tx.post.findMany({
    where: { id: { in: [...new Set(postIds)] }, ideaId: { not: null } },
    select: { id: true, ideaId: true },
  });
  const ideaIds = [...new Set(posts.flatMap((post) => (post.ideaId ? [post.ideaId] : [])))];
  if (ideaIds.length === 0) return layouts;
  const ideas = await tx.idea.findMany({
    where: { id: { in: ideaIds } },
    select: { id: true, concept: true },
  });
  const byIdea = new Map<string, string>();
  for (const idea of ideas) {
    const concept = parseIdeaConcept(idea.concept);
    if (concept?.module === "social" && concept.draft.layoutId) {
      byIdea.set(idea.id, concept.draft.layoutId);
    }
  }
  for (const post of posts) {
    const layoutId = post.ideaId ? byIdea.get(post.ideaId) : undefined;
    if (layoutId) layouts.set(post.id, layoutId);
  }
  return layouts;
}

function slotRequest(input: {
  production: PlanProduction;
  title: string;
  idea: string | null;
  // The master message of a Works plan, so every channel's piece stays coherent.
  master?: string;
  goal?: string;
  plannedFor: string;
  timezone: string;
}): string {
  return [
    `${input.production.label}: ${input.title}`,
    input.idea ? `Idea: ${input.idea}` : undefined,
    input.master ? `Master message: ${input.master.slice(0, 400)}` : undefined,
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
  // "Make this post": every delivery of this one post that can be made now.
  onlyPostId?: string;
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
              postId: true,
              excludedAt: true,
            },
          }),
          tx.task.findMany({
            where: { projectId: input.projectId, commandId: input.commandId },
            select: { status: true, payload: true, updatedAt: true },
          }),
        ]);

        // Only the Work's state is checked here: a plan's pieces carry their
        // own channels (a chat is not bound to one).
        const gate = await worksProductionGate(tx, {
          projectId: input.projectId,
          commandId: input.commandId,
        });
        if (!gate.ok) return { ok: false, message: gate.message };

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
          // A channel left out of its post is never made.
          if (
            creative.excludedAt ||
            !production ||
            !isDepartmentInFocus(production.department)
          ) {
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

        let batch = input.onlyPostId
          ? journeyItems
              .filter(
                (item) =>
                  byId.get(item.id)?.row.postId === input.onlyPostId &&
                  (item.stage === "PLANNED" || item.stage === "FAILED"),
              )
              .map((item) => item.id)
          : selectProductionBatch(journeyItems, input.commandId);

        // One post, one picture: the batch takes whole posts, the post's first
        // image piece renders and the others adapt that picture. A piece whose
        // post picture another run is making waits for the next run.
        const slotsNow = pictureSlotsOf({
          slotIds,
          items: card.items,
          journeyItems,
          postIdOf: new Map(creatives.map((c) => [c.id, c.postId])),
          imageIds: new Set(
            [...byId].flatMap(([id, entry]) =>
              entry.production.image ? [id] : [],
            ),
          ),
        });
        batch = wholePosts(batch, slotsNow).filter((id) => byId.has(id));
        if (!input.onlyPostId) {
          batch = capPosts(batch, slotsNow, MAX_POSTS_PER_RUN);
        }
        const lookUp = new Set(leadsToLookUp(batch, slotsNow));
        const [pictures, postPictures] = await Promise.all([
          currentPicturesOf(
            tx,
            creatives.filter((creative) => lookUp.has(creative.id)),
          ),
          postPicturesOf(
            tx,
            creatives.flatMap((creative) =>
              creative.postId && batch.includes(creative.id)
                ? [creative.postId]
                : [],
            ),
          ),
        ]);
        const sources = pictureSources(
          batch,
          slotsNow.map((slot) =>
            pictures.has(slot.id)
              ? { ...slot, assetId: pictures.get(slot.id) }
              : slot,
          ),
          postPictures,
        );
        batch = batch.filter((id) => sources.get(id)?.kind !== "skip");
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

        const ideaLayouts = await ideaLayoutsOf(
          tx,
          batch.flatMap((id) => {
            const postId = byId.get(id)?.row.postId;
            return postId ? [postId] : [];
          }),
        );
        const slots = batch.map((id): ClaimedSlot => {
          const { production, row: creative } = byId.get(id)!;
          const layoutId =
            production.image && creative.postId
              ? ideaLayouts.get(creative.postId)
              : undefined;
          const plannedFor = creative.scheduledFor
            ? utcToZonedDateTimeLocal(creative.scheduledFor, card.timezone)
            : "";
          const title = creative.title?.trim() || production.label;
          const source = sources.get(id);
          const adapts = source?.kind === "wait" || source?.kind === "adapt";
          return {
            id,
            title,
            ...(adapts ? { picture: source } : {}),
            ...(layoutId && !adapts ? { layoutId } : {}),
            production,
            request: slotRequest({
              production,
              title,
              idea: creative.brief,
              master: card.master?.message,
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

// The plan's slots as the shared-picture rules see them, in the plan's order:
// slot i is item i of the saved card.
function pictureSlotsOf(input: {
  slotIds: readonly string[];
  items: readonly {
    date: string;
    time: string;
    topic: string;
    removed?: boolean;
  }[];
  journeyItems: readonly { id: string; stage: string }[];
  // The Post each piece belongs to (null on plans saved before posts).
  postIdOf: ReadonlyMap<string, string | null>;
  imageIds: ReadonlySet<string>;
}): PictureSlot[] {
  const stageOf = new Map(input.journeyItems.map((i) => [i.id, i.stage]));
  return input.slotIds.flatMap((id, index) => {
    const item = input.items[index];
    const stage = stageOf.get(id);
    if (!item || item.removed || stage === undefined) return [];
    return [
      {
        id,
        post: input.postIdOf.get(id) ?? postKeyOf(item),
        image: input.imageIds.has(id),
        producible: stage === "PLANNED" || stage === "FAILED",
        producing: stage === "PRODUCING",
      },
    ];
  });
}

// The picture each of these posts already has, by post id.
async function postPicturesOf(
  tx: Prisma.TransactionClient,
  postIds: readonly string[],
): Promise<Map<string, string>> {
  if (postIds.length === 0) return new Map();
  const posts = await tx.post.findMany({
    where: { id: { in: [...new Set(postIds)] } },
    select: { id: true, pictureAssetId: true },
  });
  return new Map(
    posts.flatMap((post) =>
      post.pictureAssetId ? [[post.id, post.pictureAssetId] as const] : [],
    ),
  );
}

// The current picture (asset id) of each of these pieces that has one.
async function currentPicturesOf(
  tx: Prisma.TransactionClient,
  creatives: readonly { id: string; currentVersionId: string | null }[],
): Promise<Map<string, string>> {
  const made = creatives.filter((creative) => creative.currentVersionId);
  if (made.length === 0) return new Map();
  const versions = await tx.creativeVersion.findMany({
    where: { id: { in: made.map((creative) => creative.currentVersionId!) } },
    select: { id: true, assetId: true },
  });
  const assetOf = new Map(versions.map((v) => [v.id, v.assetId]));
  return new Map(
    made.flatMap((creative) => {
      const assetId = assetOf.get(creative.currentVersionId!);
      return assetId ? [[creative.id, assetId] as const] : [];
    }),
  );
}

// The picture a finished piece ended with (its current version's asset).
async function currentPictureOf(
  creativeId: string,
): Promise<string | undefined> {
  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { currentVersionId: true },
  });
  if (!creative?.currentVersionId) return undefined;
  const version = await prisma.creativeVersion.findUnique({
    where: { id: creative.currentVersionId },
    select: { assetId: true },
  });
  return version?.assetId ?? undefined;
}

export type RunContentPlanInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  // null = run as SYSTEM (weekly-plan-produce.ts), no owner behind the run.
  userId: string | null;
  // The plan's own Command row.
  commandId: string;
  // How long to look for the final card of a job another process ran.
  finalCardPolls?: FinalCardPolls;
};

function specOf(
  slot: ClaimedSlot,
  // The post's picture this piece adapts to its own format.
  adaptFromAssetId?: string,
): ProductionSpec {
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
      // conversation (generate_image's default). One picture per job.
      ...(production.image
        ? {
            contentFormat: production.contentFormat,
            quality: "medium",
            // Not a new picture: the post's own, re-laid out for this format.
            ...(adaptFromAssetId ? { adaptFromAssetId } : {}),
            ...(slot.layoutId && !adaptFromAssetId
              ? { layoutId: slot.layoutId }
              : {}),
          }
        : {}),
    },
    logPrefix: `[plan-run] ${production.label}`,
  };
}

type RunMode = { onlyPostId?: string };

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

// Settles once: the first value wins.
function deferred<T>(): Deferred<T> {
  let settle!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (done) return;
      done = true;
      settle(value);
    },
  };
}

// The whole run as one event stream. The route serializes it onto SSE; it is
// consumed to the end even if the client disconnects (the slots are already
// claimed, so it must finish and persist its cards).
export async function* runContentPlan(
  input: RunContentPlanInput & { postId?: string },
): AsyncGenerator<ChatStreamEvent> {
  const { postId, ...rest } = input;
  yield* runPlan(rest, postId ? { onlyPostId: postId } : {});
}

async function* runPlan(
  input: RunContentPlanInput,
  mode: RunMode,
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

  const claim = await claimPlanProduction({ ...input, ...mode });
  if (!claim.ok) {
    yield { type: "error", code: "PLAN", message: claim.message };
    return;
  }

  // No owner clicked this: an unattended run (weekly-plan-produce.ts) is the
  // only caller with no session behind it, and the only one with no person
  // watching the daily spend. The manual path keeps costing nothing extra —
  // this reserves the batch's estimated dollars against the SAME cap Settings
  // already shows, and stops before any of it renders if that goes over.
  if (!input.userId) {
    const totalCostUsd = claim.slots.reduce(
      (sum, slot) => sum + slotCostUsd(slot),
      0,
    );
    try {
      await AutonomyPolicyRepository.checkAndIncrement(
        {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
        },
        "tasksCreated",
        claim.slots.length,
        totalCostUsd,
      );
    } catch {
      await patchCommandCard(input.commandId, { production: undefined }).catch(
        (error) => {
          console.error("[plan-run] release failed:", error);
        },
      );
      yield {
        type: "error",
        code: "PLAN",
        message:
          "This week's content hit the project's daily budget. The rest can be made from the plan pane.",
      };
      return;
    }
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
  // A post's lead hands its finished picture to the pieces that adapt it. The
  // leads go first, so a waiting piece never holds a place a lead needs.
  const leadPictures = new Map<string, Deferred<string | undefined>>();
  for (const slot of claim.slots) {
    if (
      slot.picture?.kind === "wait" &&
      !leadPictures.has(slot.picture.leadId)
    ) {
      leadPictures.set(slot.picture.leadId, deferred());
    }
  }
  const ordered = [
    ...claim.slots.filter((slot) => slot.picture?.kind !== "wait"),
    ...claim.slots.filter((slot) => slot.picture?.kind === "wait"),
  ];
  const work = forEachWithLimit(ordered, CONCURRENCY, async (slot) => {
    const handOff = leadPictures.get(slot.id);
    try {
      let adaptFrom =
        slot.picture?.kind === "adapt" ? slot.picture.assetId : undefined;
      if (slot.picture?.kind === "wait") {
        adaptFrom = await leadPictures.get(slot.picture.leadId)?.promise;
        if (!adaptFrom) {
          // No picture to adapt: making a different one would break "one
          // post, one picture", so this piece waits for the next run.
          channel.push({
            type: "item.done",
            itemId: slot.id,
            ok: false,
            reply: `The ${slot.production.label.toLowerCase()} waits for its post's picture. Try again.`,
          });
          outcomes.push({ itemId: slot.id, planned: false, ok: false });
          return;
        }
      }
      const outcome = await runProductionItem(
        specOf(slot, adaptFrom),
        input,
        channel.push,
      );
      outcomes.push(outcome);
      handOff?.resolve(
        outcome.ok
          ? await currentPictureOf(slot.id).catch(() => undefined)
          : undefined,
      );
    } finally {
      // Never leave a waiting piece hanging (a throw above resolves nothing).
      handOff?.resolve(undefined);
    }
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
      actorType: input.userId ? "USER" : "SYSTEM",
      actorId: input.userId ?? undefined,
      action: "content_plan.production_started",
      entityType: "Command",
      entityId: input.commandId,
      metadata: { items: planned, requested: claim.slots.length, failed },
    }).catch(() => undefined);
  }
  yield { type: "package.done", started: planned, failed };
}
