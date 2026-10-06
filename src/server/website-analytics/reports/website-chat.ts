import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  WEBSITE_WORK_MODULE,
  WEBSITE_WORK_TITLE,
  websiteWorkId,
} from "@/lib/website-analytics/reports/ids";
import type {
  ReportStepResult,
  WebsiteReportCardData,
} from "@/lib/website-analytics/reports/types";
import { isUniqueViolation } from "@/server/guided-setup/store";
import { createWorkInTx } from "@/server/works/draft-plan-work";

// Projenin "Website analytics" sohbetine rapor kartı (GA-F5, plan GK9): Work
// kimliği sabittir (wkga_<projectId>); ilk kart yazılırken aynı işlemde
// açılır. Başka bir Analytics Work'üne asla yazılmaz (kullanıcının kendi
// Analytics sohbetleri ayrı kalır). Komut kimliği sabittir; ikinci yazma P2002
// ile "exists" döner. Kart parsedIntent.card altında saklanır.

export type WebsiteChatPostResult =
  "posted" | "exists" | "closed" | "gone" | "no_project";

class GoneError extends Error {}
class ClosedError extends Error {}

export async function postToWebsiteChat(input: {
  projectId: string;
  linkId: string;
  commandId: string;
  card: WebsiteReportCardData;
  text: string;
  summary: string;
  reopen: boolean;
  now: Date;
}): Promise<WebsiteChatPostResult> {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { workspaceId: true },
  });
  if (!project) return "no_project";
  const brand = await prisma.brand.findFirst({
    where: { projectId: input.projectId, isDefault: true },
    select: { id: true },
  });
  const workId = websiteWorkId(input.projectId);
  try {
    await prisma.$transaction(async (tx) => {
      // Bağ kopmuşsa (Disconnect yarışı) hiçbir şey yazılmaz.
      const link = await tx.gaPropertyLink.findUnique({
        where: { id: input.linkId },
        select: { id: true },
      });
      if (!link) throw new GoneError();
      const work = await tx.work.findUnique({
        where: { id: workId },
        select: { status: true },
      });
      if (!work) {
        await createWorkInTx(tx, {
          workId,
          workspaceId: project.workspaceId,
          projectId: input.projectId,
          title: WEBSITE_WORK_TITLE,
          module: WEBSITE_WORK_MODULE,
          now: input.now,
        });
      } else if (work.status !== "ACTIVE") {
        if (!input.reopen) throw new ClosedError();
        await tx.work.update({
          where: { id: workId },
          data: { status: "ACTIVE" },
        });
      }
      await tx.command.create({
        data: {
          id: input.commandId,
          workspaceId: project.workspaceId,
          projectId: input.projectId,
          brandId: brand?.id ?? null,
          workId,
          source: "SYSTEM",
          rawText: "",
          replyText: input.text,
          replyStatus: "ANSWERED",
          parsedIntent: { card: input.card } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.work.update({
        where: { id: workId },
        data: { lastActivityAt: input.now, summary: input.summary },
      });
    });
    return "posted";
  } catch (error) {
    if (error instanceof GoneError) return "gone";
    if (error instanceof ClosedError) return "closed";
    if (isUniqueViolation(error)) return "exists";
    throw error;
  }
}

export async function websiteReportExists(commandId: string): Promise<boolean> {
  const row = await prisma.command.findUnique({
    where: { id: commandId },
    select: { id: true },
  });
  return Boolean(row);
}

export function stepResultOf(post: WebsiteChatPostResult): ReportStepResult {
  switch (post) {
    case "posted":
      return "posted";
    case "exists":
      return "exists";
    case "closed":
      return "closed";
    case "gone":
    case "no_project":
      return "gone";
  }
}
