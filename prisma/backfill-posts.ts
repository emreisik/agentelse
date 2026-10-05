// Posts for plans saved before posts existed (docs/works.md "Posts"): each
// saved content plan's pieces that share a day, a time and an idea become ONE
// Post, and every piece of it points at that Post (Creative.postId). Pieces
// outside a saved plan keep postId null and count as a post of one.
//
//   npm run db:backfill:posts            -> dry run: prints what it would do
//   npm run db:backfill:posts -- --apply -> writes
//
// Safe to run again: a piece that already has a post is never touched, and a
// plan whose pieces all have one is skipped. One transaction per plan. Run it
// after `prisma migrate deploy` has added the Post table.

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

import { PrismaClient } from "@prisma/client";

import { postGroupsOf } from "../src/lib/works/post-groups";

const prisma = new PrismaClient();

type PlanItem = {
  date: string;
  time: string;
  topic: string;
  captionIdea: string;
  removed?: boolean;
  ideaId?: string;
};

type SavedPlan = {
  kind: "content-plan-draft";
  state: string;
  timezone?: string;
  goal?: string;
  items: PlanItem[];
  savedCreativeIds?: string[];
};

function savedPlanOf(parsedIntent: unknown): SavedPlan | null {
  const card = (parsedIntent as { card?: unknown } | null)?.card as
    Partial<SavedPlan> | undefined;
  if (
    card?.kind !== "content-plan-draft" ||
    card.state !== "saved" ||
    !Array.isArray(card.items) ||
    !Array.isArray(card.savedCreativeIds)
  ) {
    return null;
  }
  return card as SavedPlan;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const commands = await prisma.command.findMany({
    where: {
      parsedIntent: { path: ["card", "kind"], equals: "content-plan-draft" },
    },
    select: { id: true, projectId: true, workId: true, parsedIntent: true },
  });

  let plans = 0;
  let posts = 0;
  let pieces = 0;
  for (const command of commands) {
    const plan = savedPlanOf(command.parsedIntent);
    if (!plan || !command.projectId) continue;
    const ids = plan.savedCreativeIds ?? [];
    const creatives = await prisma.creative.findMany({
      where: { id: { in: ids }, projectId: command.projectId, postId: null },
      select: {
        id: true,
        workspaceId: true,
        brandId: true,
        scheduledFor: true,
        currentVersionId: true,
      },
    });
    if (creatives.length === 0) continue;
    const byId = new Map(creatives.map((creative) => [creative.id, creative]));
    const versionIds = creatives.flatMap((c) =>
      c.currentVersionId ? [c.currentVersionId] : [],
    );
    const versions = await prisma.creativeVersion.findMany({
      where: { id: { in: versionIds } },
      select: { id: true, assetId: true },
    });
    const assetOf = new Map(versions.map((v) => [v.id, v.assetId]));

    // Only the items that still line up with a piece to backfill.
    const groups = postGroupsOf(plan.items)
      .map((group) =>
        group.flatMap((index) => {
          const creative = byId.get(ids[index] ?? "");
          const item = plan.items[index];
          return creative && item ? [{ item, creative }] : [];
        }),
      )
      .filter((group) => group.length > 0);
    if (groups.length === 0) continue;

    plans += 1;
    posts += groups.length;
    pieces += groups.reduce((n, group) => n + group.length, 0);
    console.log(
      `${apply ? "write" : "would write"} plan ${command.id}: ${groups.length} post(s) from ${creatives.length} piece(s)`,
    );
    if (!apply) continue;

    await prisma.$transaction(async (tx) => {
      for (const group of groups) {
        const lead = group[0]!;
        const times = group
          .map(({ creative }) => creative.scheduledFor?.getTime())
          .filter((time): time is number => time !== undefined);
        const picture = group
          .map(({ creative }) =>
            creative.currentVersionId
              ? assetOf.get(creative.currentVersionId)
              : undefined,
          )
          .find((assetId): assetId is string => Boolean(assetId));
        const post = await tx.post.create({
          data: {
            workspaceId: lead.creative.workspaceId,
            projectId: command.projectId!,
            brandId: lead.creative.brandId,
            workId: command.workId,
            planId: command.id,
            ideaId: lead.item.ideaId,
            topic: lead.item.topic,
            idea: lead.item.captionIdea,
            goal: plan.goal,
            scheduledFor: times.length ? new Date(Math.min(...times)) : null,
            timezone: plan.timezone,
            pictureAssetId: picture ?? null,
          },
          select: { id: true },
        });
        await tx.creative.updateMany({
          where: {
            id: { in: group.map(({ creative }) => creative.id) },
            postId: null,
          },
          data: { postId: post.id },
        });
      }
    });
  }

  console.log(
    `${apply ? "Done" : "Dry run"}: ${plans} plan(s), ${posts} post(s), ${pieces} piece(s).${apply ? "" : " Run again with --apply to write."}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
