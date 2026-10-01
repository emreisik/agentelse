"use server";

import { prisma } from "@/lib/prisma";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import { describePublishLine } from "@/lib/works/publish-guard";
import { parseAlternatives } from "@/lib/works/variants";
import {
  loadLiveCreativeRows,
  loadLiveInputs,
} from "@/server/agency/journey/live-creative-state";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  assertWorkActive,
  authorizeWorks,
  guardedAction,
  refreshWorkPages,
  validId,
  type GuardFail,
} from "@/server/works/guard";

// Approves the pieces a Work's "Approve n" step SHOWED (spec 3.6.3). It never
// decides a piece the person did not see: when more approvals are pending than
// were shown, nothing is approved and the caller is told to review first.

export type ApprovePlansResult =
  | {
      ok: true;
      approved: number;
      failed: number;
      held: number;
      locked: number;
    }
  | { ok: false; code: "CHANGED"; message: string }
  | GuardFail;

const BUCKET = { bucket: "approve-plans", limit: 20 } as const;
const MAX_PLANS = 12;
const MAX_PIECES = 100;

function uniqueIds(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validId))].slice(0, cap);
}

export async function approvePlansAction(
  projectId: string,
  input: { planIds: string[]; creativeIds: string[] },
): Promise<ApprovePlansResult> {
  return guardedAction(
    "approve-plans",
    async (): Promise<ApprovePlansResult> => {
      const gate = await authorizeWorks(projectId, BUCKET);
      if (!gate.ok) return gate;
      const { auth } = gate;

      const planIds = uniqueIds(input?.planIds, MAX_PLANS);
      const creativeIds = uniqueIds(input?.creativeIds, MAX_PIECES);
      if (planIds.length === 0 || creativeIds.length === 0) {
        return { ok: false, code: "NOT_FOUND", message: "Nothing to approve." };
      }

      // Tenant-scoped: plan ids of another project never match.
      const commands = await prisma.command.findMany({
        where: { id: { in: planIds }, projectId },
        select: { id: true, workId: true, parsedIntent: true },
      });

      let locked = 0;
      const slotIds = new Set<string>();
      for (const command of commands) {
        const card = (command.parsedIntent as { card?: unknown } | null)?.card;
        if (!isIdeaEventCardData(card) || card.kind !== "content-plan-draft") {
          continue;
        }
        const active = await assertWorkActive(prisma, {
          workId: command.workId,
          projectId,
        });
        if (!active.ok) {
          locked += 1;
          continue;
        }
        for (const id of card.savedCreativeIds ?? []) slotIds.add(id);
      }

      const allPending =
        slotIds.size === 0
          ? []
          : await prisma.approval.findMany({
              where: {
                projectId,
                entityType: "Creative",
                entityId: { in: [...slotIds] },
                status: "PENDING",
              },
              orderBy: { createdAt: "asc" },
            });

      // A piece with alternatives stays for one-by-one review: a bulk Approve
      // would lock its current picture before the person chose. The server
      // decides this itself (the page's filter only trims the button label and
      // sees at most the cards on screen); such a piece is neither approved
      // nor counted as "unseen".
      const withAlternatives = new Set<string>();
      if (allPending.length > 0) {
        const firstVersions = await prisma.creativeVersion.findMany({
          where: {
            creativeId: { in: allPending.map((a) => a.entityId) },
            version: 1,
            creative: { projectId },
          },
          select: { creativeId: true, generationMetadata: true },
        });
        for (const v of firstVersions) {
          if (parseAlternatives(v.generationMetadata).length > 0) {
            withAlternatives.add(v.creativeId);
          }
        }
      }
      const pending = allPending.filter(
        (a) => !withAlternatives.has(a.entityId),
      );

      const shown = new Set(creativeIds);
      const unseen = new Set(
        pending.map((a) => a.entityId).filter((id) => !shown.has(id)),
      );
      if (unseen.size > 0) {
        return {
          ok: false,
          code: "CHANGED",
          message: `${unseen.size} more pieces are ready. Review them first.`,
        };
      }

      // One after another through the same path a single Approve takes, so what
      // approving does is exactly what it does for one piece.
      let approved = 0;
      let failed = 0;
      const approvedIds: string[] = [];
      for (const approval of pending) {
        try {
          await applyApprovalDecision({
            approval,
            to: "APPROVED",
            reviewedByUserId: auth.userId,
            actorType: "USER",
          });
          approved += 1;
          approvedIds.push(approval.entityId);
        } catch (error) {
          // Another tab or Telegram decided this piece between our read and
          // our claim: skipped, not a failure (it was not left undecided).
          if (
            (error as { code?: unknown } | null)?.code ===
            "INVALID_STATE_TRANSITION"
          ) {
            continue;
          }
          failed += 1;
          console.error(
            "[works] approve-plans piece failed:",
            error instanceof Error ? error.message : error,
          );
        }
      }

      let held = 0;
      if (approvedIds.length > 0) {
        const [rows, inputs] = await Promise.all([
          loadLiveCreativeRows(projectId, approvedIds),
          loadLiveInputs(projectId),
        ]);
        for (const row of rows.values()) {
          if (row.status !== "APPROVED") continue;
          // A legacy piece follows the legacy publish rule, never the hold.
          if (row.owned === false) continue;
          const line = describePublishLine({
            stage: "APPROVED",
            facts: {
              status: row.status,
              platform: row.platform,
              formatKey: row.formatKey,
              hasAsset: Boolean(row.version?.assetId),
              scheduledFor: row.scheduledFor,
              connectedPlatforms: inputs.connectedPlatforms,
              channel: row.channel,
              scheduleEnabled: inputs.scheduleEnabled,
            },
            now: inputs.now,
          });
          if (line?.kind === "held") held += 1;
        }
      }

      await AuditLogRepository.record({
        workspaceId: auth.workspaceId,
        projectId,
        brandId: auth.defaultBrandId,
        actorType: "USER",
        actorId: auth.userId,
        action: "content_plan.approved_plans",
        entityType: "Project",
        entityId: projectId,
        metadata: { plans: commands.length, approved, failed, held, locked },
      }).catch(() => undefined);

      refreshWorkPages(projectId, [
        `/projects/${projectId}/takvim`,
        "/dashboard",
      ]);
      return { ok: true, approved, failed, held, locked };
    },
  );
}
