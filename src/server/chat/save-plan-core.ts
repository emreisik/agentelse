import "server-only";

import type { Prisma } from "@prisma/client";

import { creativeFieldsOfPlanItem } from "@/lib/works/plan-item-fields";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { isIdeaEventCardData } from "@/types/idea-event-card";

export type SavePlanScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type SavePlanOutcome =
  | { ok: true; count: number; creativeIds: string[] }
  | { ok: false; error: string };

// The transaction body of "Save plan", moved out of saveContentPlanAction so
// other callers can run the very same write inside their own transaction.
// The caller owns auth, the Serializable transaction, audit and revalidation.
export async function savePlanSlotsInTx(
  tx: Prisma.TransactionClient,
  scope: SavePlanScope,
  commandId: string,
): Promise<SavePlanOutcome> {
  const row = await tx.command.findUnique({
    where: { id: commandId },
    select: { parsedIntent: true, projectId: true },
  });
  const intent = row?.parsedIntent as { card?: unknown } | null;
  const card = intent?.card;
  if (
    row?.projectId !== scope.projectId ||
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
    const fields = creativeFieldsOfPlanItem(item);
    const creative = await tx.creative.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        type: fields.type,
        platform: fields.platform,
        channel: fields.channel,
        formatKey: fields.formatKey,
        goal: card.goal,
        planId: commandId,
        title: fields.title,
        brief: fields.brief,
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
  return { ok: true, count: creativeIds.length, creativeIds };
}
