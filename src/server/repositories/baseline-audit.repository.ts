import "server-only";

import type { DepartmentKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type BaselineAuditInput = {
  department: DepartmentKey;
  score: number;
  summary: string;
  strengths: unknown;
  weaknesses: unknown;
  risks: unknown;
  potentialOpportunities: unknown;
  findingIds?: string[];
  isMock?: boolean;
};

export const BaselineAuditRepository = {
  upsertMany(
    scope: { workspaceId: string; projectId: string; brandId: string },
    audits: BaselineAuditInput[],
  ) {
    return prisma.$transaction(
      audits.map((audit) =>
        prisma.baselineAudit.upsert({
          where: {
            projectId_department: {
              projectId: scope.projectId,
              department: audit.department,
            },
          },
          create: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            brandId: scope.brandId,
            department: audit.department,
            score: audit.score,
            summary: audit.summary,
            strengths: audit.strengths as never,
            weaknesses: audit.weaknesses as never,
            risks: audit.risks as never,
            potentialOpportunities: audit.potentialOpportunities as never,
            findingIds: audit.findingIds ?? [],
            isMock: audit.isMock ?? false,
          },
          update: {
            score: audit.score,
            summary: audit.summary,
            strengths: audit.strengths as never,
            weaknesses: audit.weaknesses as never,
            risks: audit.risks as never,
            potentialOpportunities: audit.potentialOpportunities as never,
            findingIds: audit.findingIds ?? [],
            isMock: audit.isMock ?? false,
          },
        }),
      ),
    );
  },

  listForProject(projectId: string) {
    return prisma.baselineAudit.findMany({
      where: { projectId },
      orderBy: { department: "asc" },
    });
  },
};
