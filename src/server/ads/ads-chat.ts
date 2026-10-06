import "server-only";

import { adsWorkId } from "@/lib/ads/digest";
import { prisma } from "@/lib/prisma";
import { isUniqueViolation } from "@/server/guided-setup/store";
import { createWorkInTx } from "@/server/works/draft-plan-work";

// Projenin Ads sohbetine SYSTEM mesajı (K24): module "ads" olan en yeni
// Work; yoksa ads_<projectId> açılır. Komut kimliği sabittir (gün / hafta /
// ay başına tek mesaj); ikinci yazma P2002 ile düşer. Recents'te öne çıkar.

export async function postToAdsChat(input: {
  projectId: string;
  brandId: string;
  commandId: string;
  text: string;
  summary: string;
  now: Date;
}): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { workspaceId: true },
  });
  if (!project) return false;
  const work = await prisma.work.findFirst({
    where: { projectId: input.projectId, module: "ads", status: "ACTIVE" },
    orderBy: { lastActivityAt: "desc" },
    select: { id: true },
  });
  try {
    await prisma.$transaction(async (tx) => {
      let workId = work?.id;
      if (!workId) {
        workId = adsWorkId(input.projectId);
        const existing = await tx.work.findUnique({
          where: { id: workId },
          select: { id: true },
        });
        if (!existing) {
          await createWorkInTx(tx, {
            workId,
            workspaceId: project.workspaceId,
            projectId: input.projectId,
            title: "Ads",
            module: "ads",
            now: input.now,
          });
        }
      }
      await tx.command.create({
        data: {
          id: input.commandId,
          workspaceId: project.workspaceId,
          projectId: input.projectId,
          brandId: input.brandId,
          workId,
          source: "SYSTEM",
          rawText: "",
          replyText: input.text,
          replyStatus: "ANSWERED",
        },
      });
      await tx.work.update({
        where: { id: workId },
        data: { lastActivityAt: input.now, summary: input.summary },
      });
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function commandExists(id: string): Promise<boolean> {
  const row = await prisma.command.findUnique({ where: { id }, select: { id: true } });
  return Boolean(row);
}
