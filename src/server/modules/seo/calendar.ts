import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type {
  SeoArticle,
  SeoBrief,
  SeoPlan,
} from "@/lib/module-flows/seo/state";
import { createPostsInTx } from "@/server/chat/save-plan-core";

// The SEO article on the Content Calendar (docs/modules.md "SEO Manager",
// Publish): ONE Post with ONE Blog/SEO delivery, made by the same writer as a
// saved social plan (createPostsInTx), so the calendar and Outputs show it
// like any other piece. The article was reviewed on the card, so it lands
// APPROVED: "Post manually" on its day, then "Mark as posted" (the existing
// manual-publish path). Idempotent per card: the card's Command is the post's
// planId, and a second call finds the first one's piece instead of adding one.

export const SEO_FORMAT_KEY = "seo.article";
const SEO_CHANNEL = "seo";
// A Blog/SEO article is there to bring visitors to the site (PLAN_GOALS).
const SEO_GOAL = "traffic";

export type SeoPlacement = {
  postId: string;
  creativeId: string;
  scheduledFor: Date;
  // The piece already existed (an earlier attempt whose card write failed).
  reused: boolean;
};

export async function placeSeoArticle(input: {
  scope: { workspaceId: string; projectId: string; brandId: string };
  userId: string;
  commandId: string;
  workId: string | null;
  timezone: string;
  // "YYYY-MM-DDTHH:mm", wall-clock time in `timezone`.
  when: string;
  article: SeoArticle;
  plan?: SeoPlan;
  brief?: SeoBrief;
}): Promise<SeoPlacement> {
  const { scope, article } = input;
  const [date, time] = input.when.split("T") as [string, string];

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.creative.findFirst({
        where: {
          projectId: scope.projectId,
          planId: input.commandId,
          formatKey: SEO_FORMAT_KEY,
          status: { not: "ARCHIVED" },
        },
        select: { id: true, postId: true, scheduledFor: true },
      });
      if (existing?.postId && existing.scheduledFor) {
        return {
          postId: existing.postId,
          creativeId: existing.id,
          scheduledFor: existing.scheduledFor,
          reused: true,
        };
      }

      const [creativeId] = await createPostsInTx(tx, scope, {
        commandId: input.commandId,
        workId: input.workId,
        goal: SEO_GOAL,
        timezone: input.timezone,
        items: [
          {
            date,
            time,
            channel: SEO_CHANNEL,
            formatKey: SEO_FORMAT_KEY,
            topic: article.title,
            captionIdea: article.metaDescription || article.title,
          },
        ],
      });
      if (!creativeId) throw new Error("The calendar piece was not created.");

      const created = await tx.creative.findUniqueOrThrow({
        where: { id: creativeId },
        select: { postId: true, scheduledFor: true },
      });
      const { postId, scheduledFor } = created;
      if (!postId || !scheduledFor) {
        throw new Error("The calendar piece has no post or time.");
      }
      const version = await tx.creativeVersion.create({
        data: {
          creativeId,
          version: 1,
          copy: article.markdown,
          generationProvider: "seo-manager",
          generationMetadata: {
            title: article.title,
            metaDescription: article.metaDescription,
            primaryKeyword: input.plan?.primaryKeyword ?? null,
            secondaryKeywords: input.plan?.secondaryKeywords ?? [],
            language: input.brief?.language ?? null,
            siteUrl: input.brief?.siteUrl || null,
          },
        },
        select: { id: true },
      });
      const approvedAt = new Date();
      await tx.creative.update({
        where: { id: creativeId },
        data: { status: "APPROVED", currentVersionId: version.id },
      });
      await tx.post.update({
        where: { id: postId },
        data: { approvedAt, approvedByUserId: input.userId },
      });
      return { postId, creativeId, scheduledFor, reused: false };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

// The calendar piece's status as it is now ("PUBLISHED" once someone marked it
// posted on the calendar), or null when it is gone.
export async function seoPieceStatus(
  projectId: string,
  creativeId: string,
): Promise<string | null> {
  const creative = await prisma.creative.findFirst({
    where: { id: creativeId, projectId },
    select: { status: true },
  });
  return creative && creative.status !== "ARCHIVED" ? creative.status : null;
}
