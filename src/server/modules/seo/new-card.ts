import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { newModuleFlowCard } from "@/lib/module-flows/card";
import {
  serializeSeoState,
  type SeoMode,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import type { SeoScope } from "@/server/modules/seo/context";
import { createWorkInTx } from "@/server/works/draft-plan-work";

// SEO Manager'ın yeni bir kartı (docs/search-actions.md "SEO Manager"): "Write
// another", kip seçimi ve Fix this buradan kart açar. Work yeniyse onunla
// birlikte, değilse var olan etkin Work'ün içine tek işlemde yazılır; Command
// satırı writePlanDraftWork'ünkiyle aynıdır (SYSTEM, cevaplanmış, kart).

export const SEO_MODE_TITLE: Readonly<Record<SeoMode, string>> = {
  article: "SEO Manager",
  refresh: "Refresh a page",
  snippet: "Fix the snippet",
};

const REPLY: Readonly<Record<SeoMode, string>> = {
  article: "SEO Manager",
  refresh: "Refresh a page",
  snippet: "Fix the snippet",
};

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export type NewSeoCardResult = {
  workId: string;
  commandId: string;
  created: boolean;
};

export async function createSeoManagerCard(input: {
  scope: SeoScope;
  userId: string;
  mode: SeoMode;
  work: { id: string; title: string } | { existingId: string };
  commandId?: string;
  state?: Partial<SeoState>;
  now?: Date;
}): Promise<NewSeoCardResult> {
  const { scope } = input;
  const now = input.now ?? new Date();
  const commandId = input.commandId ?? randomUUID();
  const existingWorkId =
    "existingId" in input.work ? input.work.existingId : null;

  // Kip ve kart özellikleri damgalanır: arayüz karardan bu damgaya bakar, bayrak
  // sonradan kapansa da kart aynen çizilir.
  const data = serializeSeoState({
    mode: input.mode,
    features: {
      modes: SeoActionFlags.loop() && seoActionsAllowedFor(scope.projectId),
      live: true,
    },
    ...input.state,
  });
  const card = {
    ...newModuleFlowCard("seo", SEO_MODE_TITLE[input.mode]),
    data,
  };

  try {
    const workId = await prisma.$transaction(async (tx) => {
      let workId: string;
      if (existingWorkId) {
        const work = await tx.work.findFirst({
          where: { id: existingWorkId, projectId: scope.projectId },
          select: { id: true, status: true },
        });
        if (!work || work.status !== "ACTIVE") {
          throw new Error("The Work for this card is missing or completed.");
        }
        workId = work.id;
      } else if ("id" in input.work) {
        workId = input.work.id;
        await createWorkInTx(tx, {
          workId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          title: input.work.title,
          module: "seo",
          createdByUserId: input.userId,
          now,
        });
      } else {
        throw new Error("A Work is required.");
      }
      await tx.command.create({
        data: {
          id: commandId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          brandId: scope.brandId,
          workId,
          source: "SYSTEM",
          rawText: "",
          replyText: REPLY[input.mode],
          replyStatus: "ANSWERED",
          parsedIntent: { card } as unknown as Prisma.InputJsonValue,
        },
      });
      return workId;
    });
    return { workId, commandId, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Aynı kimliklerle ikinci yazma (çift dokunuş): ilk yazılan kartı döndür.
    const existing = await prisma.command.findFirst({
      where: { id: commandId, projectId: scope.projectId },
      select: { id: true, workId: true },
    });
    if (existing?.workId) {
      return {
        workId: existing.workId,
        commandId: existing.id,
        created: false,
      };
    }
    // Work kimliği sabitse çakışma Work'ten gelmiş olabilir: o Work'ün SEO kartı.
    if ("id" in input.work) {
      const inWork = await prisma.command.findFirst({
        where: {
          projectId: scope.projectId,
          workId: input.work.id,
          parsedIntent: { path: ["card", "module"], equals: "seo" },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, workId: true },
      });
      if (inWork?.workId) {
        return { workId: inWork.workId, commandId: inWork.id, created: false };
      }
    }
    throw error;
  }
}
