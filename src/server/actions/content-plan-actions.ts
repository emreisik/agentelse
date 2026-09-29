"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { CHANNELS, resolvePlanItem } from "@/lib/content-channels";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import type { ActionResult } from "@/server/actions/agency-config-actions";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import type { SocialPlatform } from "@prisma/client";

type SaveOutcome = { ok: true; count: number } | { ok: false; error: string };

// "Save plan" on a content-plan-draft chat card (see propose_content_plan in
// src/server/chat/tools.ts): stores each slot as a dated DRAFT creative so it
// shows on the content calendar, tagged with its channel, format and the
// plan's goal (Creative.channel/formatKey/goal) and grouped by planId (the
// drafting Command). Deliberately NOT generating images — the client asked
// for the plan to be saved, and creative production stays their explicit
// next step.
export async function saveContentPlanAction(
  commandId: string,
): Promise<ActionResult & { saved?: number }> {
  try {
    const { userId } = await requireUser();

    const command = await prisma.command.findUnique({
      where: { id: commandId },
      select: { projectId: true },
    });
    if (!command?.projectId) return { ok: false, message: "Plan not found." };
    const access = await requireProjectAccess(userId, command.projectId);

    // Serializable: two quick clicks (or two tabs) on Save must not both pass
    // the state check and create the calendar entries twice.
    const saved = await prisma.$transaction(
      async (tx): Promise<SaveOutcome> => {
        const row = await tx.command.findUnique({
          where: { id: commandId },
          select: { parsedIntent: true, projectId: true },
        });
        const intent = row?.parsedIntent as { card?: unknown } | null;
        const card = intent?.card;
        if (
          row?.projectId !== command.projectId ||
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

        const creativeIds: string[] = [];
        for (const item of card.items) {
          const resolved = resolvePlanItem(item);
          // Catalog channels carry their own type/platform; a platform the
          // catalog does not know (Facebook, YouTube...) keeps the old
          // shape, with its free-text format folded into the brief.
          const platform = resolved
            ? CHANNELS[resolved.channel].platform
            : (item.platform as SocialPlatform | undefined);
          const brief =
            !resolved && item.format
              ? `[${item.format}] ${item.captionIdea}`
              : item.captionIdea;
          const creative = await tx.creative.create({
            data: {
              workspaceId: access.workspaceId,
              projectId: command.projectId!,
              brandId: access.defaultBrandId,
              type: resolved?.format.creativeType ?? "SOCIAL_POST",
              platform,
              channel: resolved?.channel,
              formatKey: resolved?.format.key,
              goal: card.goal,
              planId: commandId,
              title: item.topic,
              brief,
              status: "DRAFT",
              scheduledFor: zonedDateTimeToUtc(
                `${item.date}T${item.time}`,
                card.timezone,
              ),
            },
            select: { id: true },
          });
          creativeIds.push(creative.id);
        }

        await tx.command.update({
          where: { id: commandId },
          data: {
            parsedIntent: {
              ...intent,
              card: { ...card, state: "saved", savedCreativeIds: creativeIds },
            } as never,
          },
        });
        return { ok: true, count: creativeIds.length };
      },
      { isolationLevel: "Serializable" },
    );

    if (!saved.ok) return { ok: false, message: saved.error };

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: command.projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "content_plan.saved",
      entityType: "Command",
      entityId: commandId,
      metadata: { items: saved.count },
    }).catch(() => undefined);

    revalidatePath(`/projects/${command.projectId}`);
    revalidatePath(`/projects/${command.projectId}/takvim`);
    return { ok: true, saved: saved.count };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save plan",
    };
  }
}
