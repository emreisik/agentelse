import "server-only";

import type { FactClassification, FindingSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  FindingRepository,
  type CreateFindingInput,
} from "@/server/repositories/finding.repository";
import { HubConnectError } from "@/server/security/errors";

export type FindingDraft = {
  sourceType: FindingSourceType;
  sourceTaskId?: string;
  signalId?: string;
  category?: string;
  statement: string;
  details?: unknown;
  classification: FactClassification;
  confidence?: number;
  // Either an existing Evidence id, or a sourceUrl from which an Evidence row
  // will be created. VERIFIED_FACT requires one of the two — enforced here.
  evidenceId?: string;
  sourceUrl?: string;
  isMock?: boolean;
};

export const FindingWriter = {
  // The single write path for research findings. Rule (spec section 10):
  // no VERIFIED_FACT without evidence.
  async writeMany(
    scope: { workspaceId: string; projectId: string; brandId: string },
    drafts: FindingDraft[],
  ) {
    // Evidence rows for URL-backed drafts are independent — create in parallel.
    const evidenceIds = await Promise.all(
      drafts.map(async (draft) => {
        if (draft.evidenceId || !draft.sourceUrl) return draft.evidenceId;
        const evidence = await prisma.evidence.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            brandId: scope.brandId,
            sourceType: "WEB_PAGE",
            sourceUrl: draft.sourceUrl,
            statement: draft.statement,
            confidenceScore: draft.isMock ? 0.5 : (draft.confidence ?? null),
            accessedAt: new Date(),
          },
        });
        return evidence.id;
      }),
    );

    const inputs: CreateFindingInput[] = [];

    for (const [index, draft] of drafts.entries()) {
      const evidenceId = evidenceIds[index];

      if (draft.classification === "VERIFIED_FACT" && !evidenceId) {
        throw new HubConnectError(
          "INVALID_PROVIDER_RESULT",
          `VERIFIED_FACT finding without evidence: "${draft.statement.slice(0, 80)}"`,
        );
      }

      inputs.push({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        sourceType: draft.sourceType,
        sourceTaskId: draft.sourceTaskId,
        signalId: draft.signalId,
        category: draft.category,
        statement: draft.statement,
        details: draft.details,
        classification: draft.classification,
        confidence: draft.confidence,
        evidenceId,
        isMock: draft.isMock,
      });
    }

    return FindingRepository.createMany(inputs);
  },
};
