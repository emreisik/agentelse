import "server-only";

import type { Prisma } from "@prisma/client";

import {
  brandCheckOf,
  checkItems,
  type BrandRuleSet,
} from "@/lib/works/brand-rules";
import type { ContentPlanCard } from "@/server/chat/content-plan";

// A plan card written straight into a chat (Work) of its own, with no model
// turn: the weekly plan draft (weekly-plan-draft.ts) writes a draft card here;
// an idea made into a post from the Ideas board (src/server/ideas/idea-post.ts)
// opens its chat with createWorkInTx and puts the post on the calendar
// (schedule-slots.ts createSlots). The cards are the ones the chat's planner
// writes, so Save, Prepare content and the plan pane work on them unchanged.

// The card with each post's brand-rule flags and the check's state, as the
// planner's own cards carry them.
export function withBrandFlags(
  card: ContentPlanCard,
  rules: BrandRuleSet | null,
): ContentPlanCard {
  const flags = checkItems(card.items, rules);
  return {
    ...card,
    items: card.items.map((item, index) => {
      const own = flags
        .filter((entry) => entry.index === index)
        .map((entry) => entry.flag);
      return own.length > 0 ? { ...item, brandFlags: own } : item;
    }),
    brandCheck: brandCheckOf(rules),
  };
}

export type NewWorkInput = {
  workId: string;
  workspaceId: string;
  projectId: string;
  title: string;
  module?: string | null;
  channels?: readonly string[];
  createdByUserId?: string | null;
  now: Date;
};

// A chat (Work) of its own, inside the caller's transaction. The caller names
// the id (a fixed id makes a second write fail with P2002).
export async function createWorkInTx(
  tx: Prisma.TransactionClient,
  input: NewWorkInput,
): Promise<void> {
  await tx.work.create({
    data: {
      id: input.workId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      title: input.title,
      channels: [...(input.channels ?? [])],
      acknowledgedUnconnected: [],
      lastActivityAt: input.now,
      ...(input.module ? { module: input.module } : {}),
      ...(input.createdByUserId
        ? { createdByUserId: input.createdByUserId }
        : {}),
    },
  });
}

// The Work and its SYSTEM row holding the card, inside the caller's
// transaction. The caller names both ids (a fixed id makes a second write fail
// with P2002), so nothing here depends on what the writes return.
export async function writePlanDraftWork(
  tx: Prisma.TransactionClient,
  input: {
    workId: string;
    commandId: string;
    workspaceId: string;
    projectId: string;
    brandId: string;
    title: string;
    module?: string | null;
    channels?: readonly string[];
    createdByUserId?: string | null;
    reply: string;
    card: ContentPlanCard;
    now: Date;
  },
): Promise<{ workId: string; commandId: string }> {
  await createWorkInTx(tx, input);
  await tx.command.create({
    data: {
      id: input.commandId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      workId: input.workId,
      source: "SYSTEM",
      rawText: "",
      replyText: input.reply,
      replyStatus: "ANSWERED",
      parsedIntent: { card: input.card } as unknown as Prisma.InputJsonValue,
    },
  });
  return { workId: input.workId, commandId: input.commandId };
}
