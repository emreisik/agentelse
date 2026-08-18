import "server-only";

import type { DepartmentKey, DepartmentMode } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type DepartmentConfigInput = {
  department: DepartmentKey;
  mode: DepartmentMode;
  recommendedMode?: DepartmentMode;
  recommendationRationale?: string;
  config?: unknown;
};

export const ProjectDepartmentRepository = {
  upsertMany(
    scope: { workspaceId: string; projectId: string; brandId: string },
    departments: DepartmentConfigInput[],
  ) {
    return prisma.$transaction(
      departments.map((dept) =>
        prisma.projectDepartment.upsert({
          where: {
            projectId_department: {
              projectId: scope.projectId,
              department: dept.department,
            },
          },
          create: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            brandId: scope.brandId,
            department: dept.department,
            mode: dept.mode,
            recommendedMode: dept.recommendedMode,
            recommendationRationale: dept.recommendationRationale,
            config: dept.config as never,
          },
          update: {
            recommendedMode: dept.recommendedMode,
            recommendationRationale: dept.recommendationRationale,
          },
        }),
      ),
    );
  },

  listForProject(projectId: string) {
    return prisma.projectDepartment.findMany({
      where: { projectId },
      orderBy: { department: "asc" },
    });
  },

  get(projectId: string, department: DepartmentKey) {
    return prisma.projectDepartment.findUnique({
      where: { projectId_department: { projectId, department } },
    });
  },

  setMode(projectId: string, department: DepartmentKey, mode: DepartmentMode) {
    return prisma.projectDepartment.update({
      where: { projectId_department: { projectId, department } },
      data: { mode },
    });
  },
};
