import "server-only";

import type { Prisma } from "@prisma/client";

import { creativeFieldsOfPlanItem } from "@/lib/works/plan-item-fields";
import { piecesOfPlan } from "@/lib/works/plan-platforms";
import { postGroupsOf } from "@/lib/works/post-groups";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import {
  isIdeaEventCardData,
  type IdeaEventCardData,
} from "@/types/idea-event-card";

export type SavePlanScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type SavePlanOutcome =
  // ideaIds: the pool ideas the saved posts were built from (the caller marks
  // them planned once the transaction has committed, see idea-pool.ts).
  | { ok: true; count: number; creativeIds: string[]; ideaIds: string[] }
  | { ok: false; error: string };

// The transaction body of "Save plan", moved out of saveContentPlanAction so
// other callers can run the very same write inside their own transaction.
// The caller owns auth, the Serializable transaction, audit and revalidation.
export async function savePlanSlotsInTx(
  tx: Prisma.TransactionClient,
  scope: SavePlanScope,
  commandId: string,
): Promise<SavePlanOutcome> {
  const row = await tx.command.findUnique({
    where: { id: commandId },
    select: { parsedIntent: true, projectId: true, workId: true },
  });
  const intent = row?.parsedIntent as { card?: unknown } | null;
  const card = intent?.card;
  if (
    row?.projectId !== scope.projectId ||
    !isIdeaEventCardData(card) ||
    card.kind !== "content-plan-draft"
  ) {
    return { ok: false, error: "Plan not found." };
  }
  if (card.state === "saved") {
    return { ok: false, error: "This plan is already saved." };
  }
  if (card.state === "superseded") {
    return {
      ok: false,
      error: "A newer version of this plan exists. Save that one instead.",
    };
  }

  // A social media plan (Works) is general: its items are posts and the card
  // names the platforms they go to, so each post becomes one piece per platform
  // (and an Instagram Story when the switch is on). The saved card keeps the
  // expanded items: slot i is item i.
  const items = piecesOfPlan({
    items: card.items,
    platforms: Array.isArray(card.platforms) ? card.platforms : undefined,
    instagramStory: card.instagramStory,
  });
  const creativeIds = await createPostsInTx(tx, scope, {
    commandId,
    workId: row.workId,
    goal: card.goal,
    timezone: card.timezone,
    items,
  });

  await tx.command.update({
    where: { id: commandId },
    data: {
      parsedIntent: {
        ...intent,
        card: { ...card, items, state: "saved", savedCreativeIds: creativeIds },
      } as never,
    },
  });
  const ideaIds = [
    ...new Set(
      card.items.flatMap((item) => (item.ideaId ? [item.ideaId] : [])),
    ),
  ];
  return { ok: true, count: creativeIds.length, creativeIds, ideaIds };
}

type PlanItem = Extract<
  IdeaEventCardData,
  { kind: "content-plan-draft" }
>["items"][number];

// One idea, one post (docs/works.md "Posts"): the items that share a day, a
// time and an idea become ONE Post, each item one channel delivery (a Creative
// with that postId). The deliveries are created in the items' own order, so
// the card's savedCreativeIds[i] still belongs to items[i].
export async function createPostsInTx(
  tx: Prisma.TransactionClient,
  scope: SavePlanScope,
  plan: {
    commandId: string;
    workId: string | null;
    goal?: string;
    timezone: string;
    items: readonly PlanItem[];
  },
): Promise<string[]> {
  const postOfItem = new Map<number, string>();
  for (const group of postGroupsOf(plan.items)) {
    const lead = plan.items[group[0]!]!;
    const post = await tx.post.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        workId: plan.workId,
        planId: plan.commandId,
        ideaId: lead.ideaId,
        topic: lead.topic,
        idea: lead.captionIdea,
        goal: plan.goal,
        scheduledFor: zonedDateTimeToUtc(
          `${lead.date}T${lead.time}`,
          plan.timezone,
        ),
        timezone: plan.timezone,
      },
      select: { id: true },
    });
    for (const index of group) postOfItem.set(index, post.id);
  }

  const creativeIds: string[] = [];
  for (const [index, item] of plan.items.entries()) {
    const fields = creativeFieldsOfPlanItem(item);
    const creative = await tx.creative.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        type: fields.type,
        platform: fields.platform,
        channel: fields.channel,
        formatKey: fields.formatKey,
        goal: plan.goal,
        planId: plan.commandId,
        postId: postOfItem.get(index),
        title: fields.title,
        brief: fields.brief,
        status: "DRAFT",
        scheduledFor: zonedDateTimeToUtc(
          `${item.date}T${item.time}`,
          plan.timezone,
        ),
      },
      select: { id: true },
    });
    creativeIds.push(creative.id);
  }
  return creativeIds;
}
