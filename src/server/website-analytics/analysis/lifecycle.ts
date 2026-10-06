import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gaInsightsModeFor } from "@/lib/website-analytics/analysis/flags";
import {
  nextFindingStatus,
  type GaFindingAction,
} from "@/lib/website-analytics/analysis/lifecycle";
import {
  isEvaluable,
  isGaRuleKey,
} from "@/lib/website-analytics/analysis/registry";
import { GA_EVALUATE_AFTER_DAYS } from "@/lib/website-analytics/analysis/schedule";
import { parseGaFindingEvidence } from "@/lib/website-analytics/analysis/stored";
import type {
  GaFindingStatus,
  GaReviewVerdict,
} from "@/lib/website-analytics/analysis/types";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// GA-F4 kullanıcı eylemleri (docs/website-insights.md "Yaşam döngüsü"):
// Accept / Dismiss / Mark done yalnız canlı satırda; gölge satır "invalid".
// Her yazım mevcut duruma CAS'tır. Dismiss kapanıştır (closedAt). Done
// değerlendirmeyi doneAt + 36 güne kurar. Operatörün gölge incelemesi
// (review) her modda çalışır; çağıran isPlatformOperator ve proje erişimini
// zaten denetledi. Denetim kaydı yalnız kural anahtarını taşır, sayı değil.

export type GaFindingActionResult = "ok" | "not_found" | "invalid" | "off";

type ActionInput = {
  projectId: string;
  findingId: string;
  userId: string;
  now?: Date;
};

const DAY_MS = 86_400_000;

const AUDIT_ACTIONS: Record<GaFindingAction | "review", string> = {
  accept: "ga_finding.accepted",
  dismiss: "ga_finding.dismissed",
  done: "ga_finding.done",
  review: "ga_finding.reviewed",
};

async function findOwn(projectId: string, findingId: string) {
  return prisma.gaFinding.findFirst({
    where: { id: findingId, projectId },
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      ruleKey: true,
      status: true,
      mode: true,
      evidence: true,
    },
  });
}

async function audit(
  row: { id: string; workspaceId: string; projectId: string; ruleKey: string },
  userId: string,
  action: GaFindingAction | "review",
): Promise<void> {
  await AuditLogRepository.record({
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    actorType: "USER",
    actorId: userId,
    action: AUDIT_ACTIONS[action],
    entityType: "GaFinding",
    entityId: row.id,
    metadata: { ruleKey: row.ruleKey },
  });
}

function dataFor(
  action: GaFindingAction,
  userId: string,
  now: Date,
): Prisma.GaFindingUpdateManyMutationInput {
  switch (action) {
    case "accept":
      return { status: "ACCEPTED", acceptedAt: now, acceptedByUserId: userId };
    case "dismiss":
      return {
        status: "DISMISSED",
        dismissedAt: now,
        dismissedByUserId: userId,
        closedAt: now,
        closedReason: "dismissed",
      };
    case "done":
      return {
        status: "DONE",
        doneAt: now,
        evaluateAfter: new Date(
          now.getTime() + GA_EVALUATE_AFTER_DAYS * DAY_MS,
        ),
      };
  }
}

async function act(
  input: ActionInput,
  action: GaFindingAction,
): Promise<GaFindingActionResult> {
  if (gaInsightsModeFor(input.projectId) === "off") return "off";
  const row = await findOwn(input.projectId, input.findingId);
  if (!row) return "not_found";
  if (row.mode !== "live" || !isGaRuleKey(row.ruleKey)) return "invalid";
  const evidence = parseGaFindingEvidence(row.evidence);
  const evaluable = evidence ? isEvaluable(row.ruleKey, evidence) : false;
  const next = nextFindingStatus(
    row.status as GaFindingStatus,
    action,
    evaluable,
  );
  if (!next) return "invalid";
  const now = input.now ?? new Date();
  const updated = await prisma.gaFinding.updateMany({
    where: { id: row.id, status: row.status },
    data: { ...dataFor(action, input.userId, now), status: next },
  });
  if (updated.count !== 1) return "invalid";
  await audit(row, input.userId, action);
  return "ok";
}

export const GaFindingActions = {
  accept(input: ActionInput): Promise<GaFindingActionResult> {
    return act(input, "accept");
  },

  dismiss(input: ActionInput): Promise<GaFindingActionResult> {
    return act(input, "dismiss");
  },

  markDone(input: ActionInput): Promise<GaFindingActionResult> {
    return act(input, "done");
  },

  async review(
    input: ActionInput & { verdict: GaReviewVerdict },
  ): Promise<GaFindingActionResult> {
    if (gaInsightsModeFor(input.projectId) === "off") return "off";
    if (input.verdict !== "USEFUL" && input.verdict !== "NOT_USEFUL") {
      return "invalid";
    }
    const row = await findOwn(input.projectId, input.findingId);
    if (!row) return "not_found";
    const now = input.now ?? new Date();
    await prisma.gaFinding.update({
      where: { id: row.id },
      data: {
        reviewVerdict: input.verdict,
        reviewedAt: now,
        reviewedByUserId: input.userId,
      },
    });
    await audit(row, input.userId, "review");
    return "ok";
  },
};
