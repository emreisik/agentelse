import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SeoReportCardData } from "@/lib/seo/reports/card";
import { seoWorkId } from "@/lib/seo/reports/ids";
import { isUniqueViolation } from "@/server/guided-setup/store";
import { createWorkInTx } from "@/server/works/draft-plan-work";

// "Search & SEO" sohbeti (docs/search-reports.md "Sohbet"): proje başına tek,
// belirlenimci Work (wkseo_<projectId>, module "seo"); ilk kart yazılırken
// aynı işlemde açılır. SEO Manager sohbetleri de "seo" modülünü paylaştığı
// için "en yeni seo Work'ü"ne ASLA yazılmaz. Komut kimliği sabittir (bağ
// kimliğine bağlı); ikinci yazma P2002 ile false döner. Kart yalnız rapora
// işaret eder (Google sayısı taşımaz) ve parsedIntent.card altında saklanır.

export const SEO_CHAT_TITLE = "Search & SEO";
const SEO_WORK_MODULE = "seo";

export async function postSeoReportCard(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  commandId: string;
  card: SeoReportCardData;
  reply: string;
  summary: string;
  // Nabız kartları sohbeti Recents'te öne çıkarmaz.
  bump: boolean;
  now: Date;
}): Promise<boolean> {
  const workId = seoWorkId(input.projectId);
  try {
    await prisma.$transaction(async (tx) => {
      const work = await tx.work.findUnique({
        where: { id: workId },
        select: { status: true },
      });
      if (!work) {
        await createWorkInTx(tx, {
          workId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          title: SEO_CHAT_TITLE,
          module: SEO_WORK_MODULE,
          now: input.now,
        });
      }
      await tx.command.create({
        data: {
          id: input.commandId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
          workId,
          source: "SYSTEM",
          rawText: "",
          replyText: input.reply,
          replyStatus: "ANSWERED",
          parsedIntent: {
            card: input.card,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      // Arşivlenmiş sohbet yeniden öne çıkarılmaz; kart yine de yazılır.
      if (input.bump && (!work || work.status === "ACTIVE")) {
        await tx.work.update({
          where: { id: workId },
          data: { lastActivityAt: input.now, summary: input.summary },
        });
      }
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function commandExists(commandId: string): Promise<boolean> {
  const row = await prisma.command.findUnique({
    where: { id: commandId },
    select: { id: true },
  });
  return Boolean(row);
}

// Sohbetin adresi; Work henüz açılmadıysa null. Adres, istemci modülünden
// (work-list.tsx workHref) içe aktarılmadan aynı biçimde kurulur: sunucu
// dosyası "use client" dosyasındaki işlevi çağıramaz.
export async function seoChatHref(projectId: string): Promise<string | null> {
  const workId = seoWorkId(projectId);
  const work = await prisma.work.findUnique({
    where: { id: workId },
    select: { id: true },
  });
  return work
    ? `/projects/${projectId}?work=${encodeURIComponent(workId)}`
    : null;
}
