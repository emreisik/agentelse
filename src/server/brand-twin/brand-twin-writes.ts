import "server-only";

import type {
  LearningPolarity,
  Prisma,
  UserDecisionType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

// The write side of BrandTwin (docs/brand-workspace-migration.md §7 Phase
// 3) — the Conversation Orchestrator (Phase 4) calls these instead of
// writing BrandLearning/UserDecision rows itself, so the "don't turn one
// observation into a permanent rule" and "keep the raw message" rules
// (spec: CREATIVE MEMORY, USER DECISIONS) live in exactly one place.

// A materially-similar insight reinforces the existing row (evidenceCount
// +1) instead of inserting a duplicate — this is deliberately a plain
// case-insensitive exact match, not semantic similarity: real fuzzy/
// embedding-based matching is "Repetition Control", a later, separate
// phase (docs/brand-workspace-migration.md). Exact-match reinforcement is
// the safe default until that lands — it never OVER-merges two distinct
// insights into one.
export async function recordCreativeMemory(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  insight: string;
  polarity: LearningPolarity;
  sourceType?: string;
  sourceRef?: string;
  confidence?: number;
}) {
  const insight = input.insight.trim();
  const existing = await prisma.brandLearning.findFirst({
    where: {
      brandId: input.brandId,
      polarity: input.polarity,
      insight: { equals: insight, mode: "insensitive" },
    },
  });

  if (existing) {
    return prisma.brandLearning.update({
      where: { id: existing.id },
      data: {
        evidenceCount: { increment: 1 },
        lastReinforcedAt: new Date(),
        // A later, higher-confidence observation is allowed to raise (but
        // never lower) the stored confidence.
        confidence:
          input.confidence != null &&
          (existing.confidence == null ||
            input.confidence > existing.confidence)
            ? input.confidence
            : undefined,
      },
    });
  }

  return prisma.brandLearning.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      insight,
      polarity: input.polarity,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      confidence: input.confidence,
    },
  });
}

// Per spec (USER DECISIONS): "Keep the raw conversation message too" —
// rawMessage is stored alongside the structured value, never instead of it.
export function recordUserDecision(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  type: UserDecisionType;
  scope: string;
  value: unknown;
  rawMessage?: string;
  sourceCommandId?: string;
  createdByUserId?: string;
}) {
  return prisma.userDecision.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      type: input.type,
      scope: input.scope,
      value: input.value as Prisma.InputJsonValue,
      rawMessage: input.rawMessage,
      sourceCommandId: input.sourceCommandId,
      createdByUserId: input.createdByUserId,
    },
  });
}
