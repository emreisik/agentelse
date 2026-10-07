"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { parseIdeaConcept } from "@/lib/ideas/concept";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import {
  isFlowModuleKey,
  newModuleFlowCard,
  type FlowModuleKey,
} from "@/lib/module-flows/card";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
} from "@/server/works/guard";

// Starting a module flow (docs/modules.md): Ads Manager, Analytics and SEO
// Manager each run on one card in the Work's chat. A tap on the module's start
// writes that card (its brief step) as the Work's first row and names the Work
// after the module; a second tap (another tab, a double tap) finds the card
// that is already there instead of writing another.

const BUCKET = { bucket: "module-flow", limit: 60 } as const;

const TITLE: Record<FlowModuleKey, string> = {
  ads: "Ads Manager",
  analytics: "Analytics",
  seo: "SEO Manager",
};

export type StartModuleFlowResult =
  | { ok: true; commandId: string }
  | { ok: false; message: string };

// What the place the flow was opened from already knows: "Boost with an ad" on
// a post names that post. Kept on the card for the module's Brief to read
// (card.data.hint); never trusted beyond an id shape.
export type ModuleFlowHint = {
  sourceCreativeId?: string | null;
  // An idea from the Ideas board ("Write this article", docs/ideas.md): its
  // topic is read here, from the idea itself, never from the URL.
  sourceIdeaId?: string | null;
};

// The SEO idea an article starts from: its id and its working title.
async function seoIdeaHint(
  projectId: string,
  ideaId: string | null | undefined,
): Promise<{ ideaId: string; topic: string } | null> {
  const id = idSchema.safeParse(ideaId);
  if (!id.success) return null;
  const row = await prisma.idea.findFirst({
    where: { id: id.data, projectId },
    select: { id: true, concept: true },
  });
  const concept = parseIdeaConcept(row?.concept);
  return row && concept?.module === "seo"
    ? { ideaId: row.id, topic: concept.draft.title }
    : null;
}

export async function startModuleFlowAction(
  projectId: string,
  workId: string,
  module: string,
  hint?: ModuleFlowHint,
): Promise<StartModuleFlowResult> {
  const result = await guardedAction(
    "module-flow-start",
    async (): Promise<StartModuleFlowResult> => {
      const gate = await authorizeWorks(projectId, BUCKET);
      if (!gate.ok) return { ok: false, message: gate.message };
      const workIdOk = idSchema.safeParse(workId);
      if (!workIdOk.success || !isFlowModuleKey(module)) {
        return { ok: false, message: GUARD_MESSAGE.failed };
      }
      const work = await WorkRepository.get(projectId, workIdOk.data);
      if (!work) return { ok: false, message: GUARD_MESSAGE.failed };
      if (work.status !== "ACTIVE") {
        return { ok: false, message: GUARD_MESSAGE.completed };
      }

      const existing = await prisma.command.findFirst({
        where: {
          projectId,
          workId: work.id,
          AND: [
            { parsedIntent: { path: ["card", "kind"], equals: "module-flow" } },
            { parsedIntent: { path: ["card", "module"], equals: module } },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (existing) return { ok: true, commandId: existing.id };

      const title = TITLE[module];
      const source = idSchema.safeParse(hint?.sourceCreativeId);
      const ideaHint =
        module === "seo" ? await seoIdeaHint(projectId, hint?.sourceIdeaId) : null;
      const card = newModuleFlowCard(module, title);
      const data = {
        ...(source.success ? { sourceCreativeId: source.data } : {}),
        ...(ideaHint ?? {}),
      };
      // SEO_ACTIONS açıkken SEO kartı oluşurken damgalanır; arayüz karardan bu
      // damgaya bakar (bayrak kapalıyken kart bugünküyle aynıdır).
      const features =
        module === "seo" && SeoActionFlags.manager()
          ? {
              features: {
                modes:
                  SeoActionFlags.loop() && seoActionsAllowedFor(projectId),
                live: true,
              },
            }
          : {};
      const cardData: Record<string, unknown> = {
        ...(Object.keys(data).length > 0 ? { hint: data } : {}),
        ...features,
      };
      const row = await IdeaChatRepository.postSystemMessage({
        workspaceId: gate.auth.workspaceId,
        projectId,
        ideaId: null,
        workId: work.id,
        text: title,
        card: Object.keys(cardData).length > 0 ? { ...card, data: cardData } : card,
      });
      await WorkRepository.touch(projectId, work.id, {
        summary: title,
        titleIfDefault: title,
      });
      revalidatePath(`/projects/${projectId}`);
      return { ok: true, commandId: row.id };
    },
  );
  return result.ok ? result : { ok: false, message: result.message };
}
