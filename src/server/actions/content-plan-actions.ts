"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/server/actions/agency-config-actions";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { savePlanSlotsInTx } from "@/server/chat/save-plan-core";
import { markIdeasPlanned } from "@/server/chat/idea-pool";
import { copyText } from "@/lib/works/copy";
import { isWorksEnabled } from "@/server/works/flag";
import { assertPlanSaveable } from "@/server/works/plan-save-guards";

type SaveOutcome =
  { ok: true; count: number; ideaIds: string[] } | { ok: false; error: string };

type PlanCardView = {
  timezone: string;
  items: { date: string; topic?: string; captionIdea?: string }[];
};

// Narrow the stored card without trusting its shape.
function planCardOf(parsedIntent: unknown): PlanCardView | null {
  const card = (parsedIntent as { card?: unknown } | null)?.card as
    { kind?: unknown; timezone?: unknown; items?: unknown } | undefined;
  if (!card || card.kind !== "content-plan-draft") return null;
  if (typeof card.timezone !== "string" || !Array.isArray(card.items))
    return null;
  return { timezone: card.timezone, items: card.items };
}

// "Save plan" on a content-plan-draft chat card (see propose_content_plan in
// src/server/chat/tools.ts): stores each slot as a dated DRAFT creative so it
// shows on the content calendar, tagged with its channel, format and the
// plan's goal (Creative.channel/formatKey/goal) and grouped by planId (the
// drafting Command). Deliberately NOT generating images — the client asked
// for the plan to be saved, and creative production stays their explicit
// next step.
// Works guards (stale dates, brand rules) run only for a Command that belongs
// to a Work; `allowIssues` bypasses the brand check, never the date check.
export async function saveContentPlanAction(
  commandId: string,
  options?: { allowIssues?: boolean },
): Promise<ActionResult & { saved?: number; code?: "STALE" | "BRAND_RULES" }> {
  // Set once the Works branch is taken, so the catch can tell the two apart.
  let inWork = false;
  const matchedTerms: string[] = [];
  try {
    const { userId } = await requireUser();

    const command = await prisma.command.findUnique({
      where: { id: commandId },
      select: { projectId: true },
    });
    if (!command?.projectId) return { ok: false, message: "Plan not found." };
    const access = await requireProjectAccess(userId, command.projectId);

    if (isWorksEnabled()) {
      const extra = await prisma.command.findUnique({
        where: { id: commandId },
        select: { workId: true, parsedIntent: true },
      });
      if (extra?.workId) {
        inWork = true;
        const card = planCardOf(extra.parsedIntent);
        if (card) {
          // Same guards a SYSTEM save runs (plan-save-guards.ts); this caller
          // keeps today's behavior exactly: rules that can't be loaded let the
          // save through (there is someone here to warn with "Save anyway" if
          // a rule DOES fire, so "couldn't check" is not treated as blocked).
          const guard = await assertPlanSaveable({
            projectId: command.projectId,
            brandId: access.defaultBrandId,
            workId: extra.workId,
            card,
            allowIssues: options?.allowIssues,
          });
          if (!guard.ok) {
            return {
              ok: false,
              code:
                guard.code === "STALE" || guard.code === "BRAND_RULES"
                  ? guard.code
                  : undefined,
              message: guard.message,
            };
          }
          matchedTerms.push(...guard.matchedTerms);
        }
      }
    }

    // Serializable: two quick clicks (or two tabs) on Save must not both pass
    // the state check and create the calendar entries twice.
    const saved = await prisma.$transaction(
      async (tx): Promise<SaveOutcome> => {
        const outcome = await savePlanSlotsInTx(
          tx,
          {
            workspaceId: access.workspaceId,
            projectId: command.projectId!,
            brandId: access.defaultBrandId,
          },
          commandId,
        );
        return outcome.ok
          ? { ok: true, count: outcome.count, ideaIds: outcome.ideaIds }
          : { ok: false, error: outcome.error };
      },
      { isolationLevel: "Serializable" },
    );

    if (!saved.ok) return { ok: false, message: saved.error };

    // The posts built from pool ideas take those ideas out of the pool.
    await markIdeasPlanned(command.projectId!, saved.ideaIds);

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: command.projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "content_plan.saved",
      entityType: "Command",
      entityId: commandId,
      metadata:
        options?.allowIssues && matchedTerms.length > 0
          ? {
              items: saved.count,
              allowIssues: true,
              matched: matchedTerms,
              userId,
            }
          : { items: saved.count },
    }).catch(() => undefined);

    revalidatePath(`/projects/${command.projectId}`);
    revalidatePath(`/projects/${command.projectId}/takvim`);
    return { ok: true, saved: saved.count };
  } catch (error) {
    if (inWork) {
      const code = (error as { code?: unknown } | null)?.code;
      return {
        ok: false,
        message:
          code === "P2034" ? copyText("plan.saving") : copyText("kit.failed"),
      };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save plan",
    };
  }
}
