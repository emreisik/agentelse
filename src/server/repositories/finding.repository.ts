import "server-only";

import type { FactClassification, FindingSourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type CreateFindingInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  sourceType: FindingSourceType;
  sourceTaskId?: string;
  signalId?: string;
  category?: string;
  statement: string;
  details?: unknown;
  classification: FactClassification;
  confidence?: number;
  evidenceId?: string;
  isMock?: boolean;
};

export const FindingRepository = {
  createMany(inputs: CreateFindingInput[]) {
    return prisma.finding.createManyAndReturn({
      data: inputs.map((input) => ({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        sourceType: input.sourceType,
        sourceTaskId: input.sourceTaskId,
        signalId: input.signalId,
        category: input.category,
        statement: input.statement,
        details: input.details as never,
        classification: input.classification,
        confidence: input.confidence,
        evidenceId: input.evidenceId,
        isMock: input.isMock ?? false,
      })),
    });
  },

  listForProject(
    projectId: string,
    filter?: {
      classification?: FactClassification;
      sourceType?: FindingSourceType;
      limit?: number;
    },
  ) {
    return prisma.finding.findMany({
      where: {
        projectId,
        ...(filter?.classification
          ? { classification: filter.classification }
          : {}),
        ...(filter?.sourceType ? { sourceType: filter.sourceType } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 200,
    });
  },

  listByIds(ids: string[]) {
    return prisma.finding.findMany({ where: { id: { in: ids } } });
  },

  countForProject(projectId: string) {
    return prisma.finding.count({ where: { projectId } });
  },
};
