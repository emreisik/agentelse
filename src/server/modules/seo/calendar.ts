import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { parseSettings } from "@/lib/seo/content-plan/cap";
import { SEO_CAP_MESSAGE } from "@/lib/seo/content-plan/copy";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { monthOf } from "@/lib/seo/content-plan/schedule";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import type {
  SeoArticle,
  SeoBrief,
  SeoPlan,
} from "@/lib/module-flows/seo/state";
import { createPostsInTx } from "@/server/chat/save-plan-core";
import { countSeoPiecesInMonth } from "@/server/seo/content-plan/pieces";
import { withSerializableRetry } from "@/server/seo/content-plan/serializable";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { primaryGscLink } from "@/server/seo/store";

// The SEO article on the Content Calendar (docs/modules.md "SEO Manager",
// Publish): ONE Post with ONE Blog/SEO delivery, made by the same writer as a
// saved social plan (createPostsInTx), so the calendar and Outputs show it
// like any other piece. The article was reviewed on the card, so it lands
// APPROVED: "Post manually" on its day, then "Mark as posted" (the existing
// manual-publish path). Idempotent per card: the card's Command is the post's
// planId, and a second call finds the first one's piece instead of adding one.
//
// SC-F7 (SEO_CONTENT_PLAN, docs/search-content-plan.md): aylık plandan kalan,
// dokunulmamış slot (Post.ideaId ile bulunur) yeni parça açmak yerine tüketilir
// (planId kartın Command'ı olur) ve aylık sınır burada uygulanır. Bayrak kapalıyken
// ya da projenin birincil Search Console bağı yokken kod yolu eskisiyle aynıdır.
// APPROVED yazan TEK yer burasıdır ve yalnız CreativeVersion 1'den sonra.

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

// Aylık sınıra takılan yerleştirme (SC-F7, docs/search-content-plan.md): ayın
// SEO makale sayısı sınıra ulaşmış. İşlem geri alınır, hiçbir şey yazılmaz.
export class SeoMonthlyCapError extends Error {
  readonly cap: number;

  constructor(cap: number) {
    super(SEO_CAP_MESSAGE(cap));
    this.name = "SeoMonthlyCapError";
    this.cap = cap;
  }
}

type PlaceInput = {
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
  // The Ideas board's article idea it was written from (docs/ideas.md).
  ideaId?: string | null;
  // "Mark as published" (an article already live) is never capped.
  capExempt?: boolean;
};

type Tx = Prisma.TransactionClient;

// Yalnız SC-F7 etkinken ve projenin birincil Search Console bağı varken: sınırın
// kontrolü Search sayfasında durur, bu yüzden bağsız proje hiç sınırlanmaz.
async function planGuardActive(projectId: string): Promise<boolean> {
  if (!seoContentPlanActiveFor(projectId)) return false;
  return (await primaryGscLink(projectId)) !== null;
}

// Aylık plandan kalan, dokunulmamış slot (Post.ideaId ile bulunur): DRAFT,
// sürümsüz, planId'siz seo.article parçası.
async function findFreeSlot(tx: Tx, projectId: string, ideaId: string) {
  const slot = await tx.creative.findFirst({
    where: {
      projectId,
      formatKey: SEO_FORMAT_KEY,
      status: "DRAFT",
      planId: null,
      excludedAt: null,
      versions: { none: {} },
      post: { ideaId },
    },
    select: { id: true, postId: true, scheduledFor: true },
  });
  return slot && slot.postId
    ? { id: slot.id, postId: slot.postId, scheduledFor: slot.scheduledFor }
    : null;
}

async function placeInTx(
  tx: Tx,
  input: PlaceInput,
  guarded: boolean,
): Promise<SeoPlacement> {
  const { scope, article } = input;
  const [date, time] = input.when.split("T") as [string, string];

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

  // Aynı kartın tekrarı yukarıda döndü; sınır yalnız yeni yerleştirmede.
  const slot =
    guarded && input.ideaId
      ? await findFreeSlot(tx, scope.projectId, input.ideaId)
      : null;
  if (guarded && !input.capExempt) {
    const month = monthOf(date);
    // Slot kendi planlandığı ayda tüketiliyorsa o ay planlanırken bütçelendi
    // (kullanıcı sınırı sonradan düşürmüş olsa da).
    const ownMonth =
      slot?.scheduledFor != null &&
      monthOf(dayKeyInTimezone(slot.scheduledFor, input.timezone)) === month;
    if (!ownMonth) {
      const setting = await tx.seoContentSetting.findUnique({
        where: { projectId: scope.projectId },
      });
      const { monthlyCap } = parseSettings(setting);
      const used = await countSeoPiecesInMonth(tx, {
        projectId: scope.projectId,
        month,
        timezone: input.timezone,
        excludeCreativeId: slot?.id,
      });
      if (used >= monthlyCap) throw new SeoMonthlyCapError(monthlyCap);
    }
  }

  let creativeId: string;
  let postId: string;
  let scheduledFor: Date;
  if (slot) {
    // Slot tüketimi: yeni Post/Creative yok, mevcut parça kartın makalesini
    // alır; planId kartın Command'ı olur (idempotans araması buna bakar).
    scheduledFor = zonedDateTimeToUtc(input.when, input.timezone);
    const brief = article.metaDescription || article.title;
    await tx.post.update({
      where: { id: slot.postId },
      data: {
        topic: article.title,
        idea: brief,
        planId: input.commandId,
        workId: input.workId,
        scheduledFor,
        timezone: input.timezone,
      },
    });
    await tx.creative.update({
      where: { id: slot.id },
      data: {
        planId: input.commandId,
        title: article.title,
        brief,
        scheduledFor,
        goal: SEO_GOAL,
      },
    });
    creativeId = slot.id;
    postId = slot.postId;
  } else {
    const [createdId] = await createPostsInTx(tx, scope, {
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
          ...(input.ideaId ? { ideaId: input.ideaId } : {}),
        },
      ],
    });
    if (!createdId) throw new Error("The calendar piece was not created.");
    creativeId = createdId;

    const created = await tx.creative.findUniqueOrThrow({
      where: { id: creativeId },
      select: { postId: true, scheduledFor: true },
    });
    if (!created.postId || !created.scheduledFor) {
      throw new Error("The calendar piece has no post or time.");
    }
    postId = created.postId;
    scheduledFor = created.scheduledFor;
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
}

const SERIALIZABLE = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

export async function placeSeoArticle(
  input: PlaceInput,
): Promise<SeoPlacement> {
  // Bayrak kapalıyken (ya da bağsız projede) kod yolu ve sorgular eskisiyle
  // aynıdır: ek sorgu, sınır ve yeniden deneme yok.
  if (!(await planGuardActive(input.scope.projectId))) {
    return prisma.$transaction(
      (tx) => placeInTx(tx, input, false),
      SERIALIZABLE,
    );
  }
  try {
    return await withSerializableRetry(() =>
      prisma.$transaction((tx) => placeInTx(tx, input, true), SERIALIZABLE),
    );
  } catch (error) {
    if (error instanceof SeoMonthlyCapError) {
      // İşlem geri alındıktan sonra, en iyi çabayla (denetim yazılamasa da
      // kullanıcı sınır mesajını görür).
      await AuditLogRepository.record({
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        brandId: input.scope.brandId,
        actorType: "USER",
        actorId: input.userId,
        action: "seo_content_plan.cap_blocked",
        entityType: "Project",
        entityId: input.scope.projectId,
        metadata: { cap: error.cap },
      }).catch(() => undefined);
    }
    throw error;
  }
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
