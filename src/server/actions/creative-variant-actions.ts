"use server";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { parseAlternatives } from "@/lib/works/variants";
import { updateCommandCard } from "@/server/chat/card-store";
import {
  swapCurrentPicture,
  type CardPicture,
} from "@/server/execution/variant-card";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  assertWorkActive,
  authorizeWorks,
  GUARD_MESSAGE,
  guardedAction,
  refreshWorkPages,
  validId,
  type GuardFail,
} from "@/server/works/guard";
import { isWorksEnabled } from "@/server/works/flag";
import { workOwnershipOf } from "@/server/works/work-owned";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Swaps the current picture of a piece for one of its stored alternatives
// (spec 3.10.4). It appends a NEW version, never overwrites one, and never
// creates an Approval. Residual, documented and NOT fixed here: the approval
// path is read-committed with no version pin, so an approver who taps Approve
// in the same instant another tab adopts a different picture approves the
// piece with the picture current at commit (applyApprovalDecision is
// deliberately untouched, decision D6).

export type AdoptVariantResult =
  | { ok: true; alreadyCurrent?: boolean; versionNumber: number }
  | {
      ok: false;
      code:
        | "NOT_FOUND"
        | "LOCKED"
        | "FOREIGN_ASSET"
        | "CONFLICT"
        | "WORK"
        | "FAILED";
      message: string;
    }
  | GuardFail;

const BUCKET = { bucket: "variant-adopt", limit: 30 } as const;
const LOCKED_MESSAGE =
  "Approved, so the picture can't change. Ask for a change instead.";
const CONFLICT_MESSAGE = "Already updated.";
const MAX_CARD_ROWS = 5;

type TxOutcome =
  | {
      ok: true;
      alreadyCurrent: boolean;
      versionNumber: number;
      workspaceId: string;
      assetId: string;
      // The picture that was current before this adopt (null when none).
      previousAssetId: string | null;
      fromVersion: number;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "LOCKED" | "FOREIGN_ASSET" | "CONFLICT" | "WORK";
      message: string;
    };

function isTxConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002" || code === "P2034";
}

export async function adoptCreativeVariantAction(
  creativeId: string,
  assetId: string,
): Promise<AdoptVariantResult> {
  return guardedAction(
    "variant-adopt",
    async (): Promise<AdoptVariantResult> => {
      if (!validId(creativeId) || !validId(assetId)) {
        return {
          ok: false,
          code: "INVALID",
          message: "That didn't work. Try again.",
        };
      }
      if (!isWorksEnabled()) {
        return { ok: false, code: "DISABLED", message: GUARD_MESSAGE.disabled };
      }
      const { userId } = await requireUser();

      // The creative's project comes from its own row; the caller's access is
      // checked against THAT project, never against a client-sent one.
      const own = await prisma.creative.findUnique({
        where: { id: creativeId },
        select: { projectId: true },
      });
      if (!own) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "That piece no longer exists.",
        };
      }
      const projectId = own.projectId;
      try {
        await requireProjectAccess(userId, projectId);
      } catch {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: "That piece no longer exists.",
        };
      }
      const gate = await authorizeWorks(projectId, BUCKET);
      if (!gate.ok) return gate;
      const { auth } = gate;

      const ownership = await workOwnershipOf(creativeId);

      let outcome: TxOutcome;
      try {
        outcome = await prisma.$transaction(
          async (tx): Promise<TxOutcome> => {
            if (ownership.workId) {
              const active = await assertWorkActive(tx, {
                workId: ownership.workId,
                projectId,
              });
              if (!active.ok)
                return { ok: false, code: "WORK", message: active.message };
            }

            const creative = await tx.creative.findFirst({
              where: { id: creativeId, projectId },
              include: { versions: { orderBy: { version: "desc" } } },
            });
            if (!creative) {
              return {
                ok: false,
                code: "NOT_FOUND",
                message: "That piece no longer exists.",
              };
            }
            const versions = creative.versions;
            const latest =
              versions.find((v) => v.id === creative.currentVersionId) ??
              versions[0];
            const reviewable =
              creative.status === "IN_REVIEW" ||
              (creative.status === "DRAFT" && versions.length > 0);
            if (!reviewable || !latest) {
              return { ok: false, code: "LOCKED", message: LOCKED_MESSAGE };
            }

            // Never trust the client: the asset must already belong to the piece.
            const first = versions[versions.length - 1];
            const allowed =
              versions.some((v) => v.assetId === assetId) ||
              parseAlternatives(first?.generationMetadata).some(
                (alt) => alt.assetId === assetId,
              );
            if (!allowed) {
              return {
                ok: false,
                code: "FOREIGN_ASSET",
                message: "That picture isn't one of this piece's options.",
              };
            }

            if (latest.assetId === assetId) {
              return {
                ok: true,
                alreadyCurrent: true,
                versionNumber: latest.version,
                workspaceId: creative.workspaceId,
                assetId,
                previousAssetId: latest.assetId ?? null,
                fromVersion: latest.version,
              };
            }

            // Compare-and-set against a concurrent approval or adopt: the
            // approval path is read-committed, so only a write that pins the
            // status and the version we read can see it. Nothing is appended
            // when it matches no row.
            const pinned = await tx.creative.updateMany({
              where: {
                id: creativeId,
                projectId,
                status: { in: ["IN_REVIEW", "DRAFT"] },
                currentVersionId: creative.currentVersionId,
              },
              data: { currentVersionId: creative.currentVersionId },
            });
            if (pinned.count === 0) {
              return { ok: false, code: "CONFLICT", message: CONFLICT_MESSAGE };
            }

            const next = await CreativeRepository.appendVersionTx(
              tx,
              creativeId,
              projectId,
              {
                assetId,
                caption: latest.caption ?? undefined,
                copy: latest.copy ?? undefined,
                contentFormat: latest.contentFormat ?? undefined,
                generationProvider: latest.generationProvider ?? undefined,
                generationMetadata: {
                  source: "variant-swap",
                  fromVersion: latest.version,
                  assetId,
                },
                revisionReason: "Picked another picture",
              },
            );
            return {
              ok: true,
              alreadyCurrent: false,
              versionNumber: next.version,
              workspaceId: creative.workspaceId,
              assetId,
              previousAssetId: latest.assetId ?? null,
              fromVersion: latest.version,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isTxConflict(error)) {
          return { ok: false, code: "CONFLICT", message: CONFLICT_MESSAGE };
        }
        throw error;
      }

      if (!outcome.ok) return outcome;
      if (outcome.alreadyCurrent) {
        return {
          ok: true,
          alreadyCurrent: true,
          versionNumber: outcome.versionNumber,
        };
      }

      // Best effort from here: the stored version is authoritative.
      try {
        const asset = await prisma.asset.findFirst({
          where: { id: outcome.assetId, projectId },
          select: { width: true, height: true },
        });
        const rows = await prisma.command.findMany({
          where: {
            projectId,
            AND: [
              {
                parsedIntent: {
                  path: ["card", "creativeId"],
                  equals: creativeId,
                },
              },
              {
                parsedIntent: {
                  path: ["card", "kind"],
                  equals: "creative-ready",
                },
              },
            ],
          },
          select: { id: true },
          take: MAX_CARD_ROWS,
        });
        for (const row of rows) {
          await updateCommandCard({
            commandId: row.id,
            projectId,
            expectKinds: ["creative-ready"],
            update: (card) => {
              const stored = card as unknown as {
                assetId?: string;
                assetWidth?: number;
                assetHeight?: number;
                alternatives?: CardPicture[];
              };
              // The displaced picture takes the adopted one's place in the
              // list, so the strip keeps showing every picture exactly once.
              const alternatives = stored.alternatives
                ? swapCurrentPicture(
                    stored,
                    outcome.assetId,
                    outcome.previousAssetId ?? undefined,
                  )
                : undefined;
              return {
                ...card,
                assetId: outcome.assetId,
                versionNumber: outcome.versionNumber,
                ...(asset?.width ? { assetWidth: asset.width } : {}),
                ...(asset?.height ? { assetHeight: asset.height } : {}),
                ...(alternatives ? { alternatives } : {}),
              } as unknown as IdeaEventCardData;
            },
          });
        }
      } catch (error) {
        console.error(
          "[works] variant card patch failed:",
          error instanceof Error ? error.message : error,
        );
      }

      await AuditLogRepository.record({
        workspaceId: outcome.workspaceId,
        projectId,
        actorType: "USER",
        actorId: auth.userId,
        action: "creative.variant_adopted",
        entityType: "Creative",
        entityId: creativeId,
        metadata: {
          assetId: outcome.assetId,
          fromVersion: outcome.fromVersion,
          versionNumber: outcome.versionNumber,
        },
      });

      refreshWorkPages(projectId);
      return { ok: true, versionNumber: outcome.versionNumber };
    },
  );
}
