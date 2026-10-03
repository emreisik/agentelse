"use server";

import { prisma } from "@/lib/prisma";
import { normalizePieceText, pieceTextField } from "@/lib/works/piece-text";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import {
  GUARD_MESSAGE,
  authorizeWorks,
  guardedAction,
  idSchema,
  refreshWorkPages,
} from "@/server/works/guard";

// The social media plan pane's text edit: the person rewrites a produced piece
// in place, before it is approved. The words become a NEW version of the piece
// (its picture and what the version carries stay), so the history keeps what
// the model wrote. The Creative (WITH the project id) must be a slot of a plan of
// THIS Work, still waiting for a decision.

export type SlotTextResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "DISABLED"
        | "RATE"
        | "NOT_FOUND"
        | "INVALID"
        | "FAILED"
        | "WORK"
        | "LOCKED"
        | "EMPTY";
      message: string;
    };

const TEXT_BUCKET = { bucket: "slot-text", limit: 60 } as const;
// Before a decision: after approval the words are what was approved.
const EDITABLE_STATUSES = ["DRAFT", "IN_REVIEW"] as const;

const MESSAGE = {
  empty: "The text can't be empty or this long.",
  locked: "This piece is already approved, so its text can't change.",
  missing: "That piece isn't in this plan.",
} as const;

class TextTxRefusal extends Error {
  constructor(
    readonly code: "LOCKED" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

function isWriteConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2034"
  );
}

export async function updateSlotTextAction(
  projectId: string,
  workId: string,
  creativeId: string,
  text: string,
): Promise<SlotTextResult> {
  const result = await guardedAction(
    "slot-text",
    async (): Promise<SlotTextResult> => {
      const gate = await authorizeWorks(projectId, TEXT_BUCKET);
      if (!gate.ok) return gate;
      const { auth } = gate;

      const workIdOk = idSchema.safeParse(workId);
      const creativeIdOk = idSchema.safeParse(creativeId);
      if (!workIdOk.success || !creativeIdOk.success) {
        return { ok: false, code: "INVALID", message: GUARD_MESSAGE.failed };
      }
      const clean = normalizePieceText(text);
      if (!clean) return { ok: false, code: "EMPTY", message: MESSAGE.empty };

      const work = await WorkRepository.get(projectId, workIdOk.data);
      if (!work) {
        return { ok: false, code: "NOT_FOUND", message: MESSAGE.missing };
      }
      if (work.status !== "ACTIVE") {
        return { ok: false, code: "WORK", message: GUARD_MESSAGE.completed };
      }

      try {
        await prisma.$transaction(
          async (tx) => {
            const creative = await tx.creative.findFirst({
              where: { id: creativeIdOk.data, projectId },
              select: {
                id: true,
                status: true,
                planId: true,
                versions: {
                  orderBy: { version: "desc" },
                  take: 1,
                  select: {
                    version: true,
                    assetId: true,
                    caption: true,
                    copy: true,
                    contentFormat: true,
                    generationProvider: true,
                    generationMetadata: true,
                  },
                },
              },
            });
            const current = creative?.versions[0];
            if (!creative?.planId || !current) {
              throw new TextTxRefusal("NOT_FOUND", MESSAGE.missing);
            }
            const plan = await tx.command.findFirst({
              where: {
                id: creative.planId,
                projectId,
                workId: workIdOk.data,
              },
              select: { parsedIntent: true },
            });
            const card = (plan?.parsedIntent as { card?: unknown } | null)
              ?.card as
              { kind?: unknown; savedCreativeIds?: unknown } | undefined;
            if (
              card?.kind !== "content-plan-draft" ||
              !Array.isArray(card.savedCreativeIds) ||
              !card.savedCreativeIds.includes(creativeIdOk.data)
            ) {
              throw new TextTxRefusal("NOT_FOUND", MESSAGE.missing);
            }
            if (
              !(EDITABLE_STATUSES as readonly string[]).includes(
                creative.status,
              )
            ) {
              throw new TextTxRefusal("LOCKED", MESSAGE.locked);
            }

            const field = pieceTextField(current);
            const version = await tx.creativeVersion.create({
              data: {
                creativeId: creative.id,
                version: current.version + 1,
                assetId: current.assetId,
                caption: field === "caption" ? clean : current.caption,
                copy: field === "copy" ? clean : current.copy,
                contentFormat: current.contentFormat,
                generationProvider: current.generationProvider,
                generationMetadata: (current.generationMetadata ??
                  undefined) as never,
                revisionReason: "Edited by you",
              },
              select: { id: true },
            });
            // The status guard again inside the write: a decision made a
            // moment ago must not be rewritten under the person's feet.
            const moved = await tx.creative.updateMany({
              where: {
                id: creative.id,
                projectId,
                status: { in: [...EDITABLE_STATUSES] },
              },
              data: { currentVersionId: version.id },
            });
            if (moved.count !== 1) {
              throw new TextTxRefusal("LOCKED", MESSAGE.locked);
            }
          },
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (error instanceof TextTxRefusal) {
          return { ok: false, code: error.code, message: error.message };
        }
        if (isWriteConflict(error)) {
          return { ok: false, code: "FAILED", message: GUARD_MESSAGE.failed };
        }
        throw error;
      }

      await AuditLogRepository.record({
        workspaceId: auth.workspaceId,
        projectId,
        brandId: auth.defaultBrandId,
        actorType: "USER",
        actorId: auth.userId,
        action: "slot.text_edited",
        entityType: "Creative",
        entityId: creativeIdOk.data,
        metadata: { workId: workIdOk.data, length: clean.length },
      }).catch(() => undefined);
      refreshWorkPages(projectId, [`/projects/${projectId}/takvim`]);
      return { ok: true };
    },
  );
  return result.ok
    ? result
    : {
        ok: false,
        code: result.code,
        message: result.message,
      };
}
