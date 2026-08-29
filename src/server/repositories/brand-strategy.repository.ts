import "server-only";

import { prisma } from "@/lib/prisma";

export type CreateStrategyVersionInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  payload: unknown;
  summary?: string;
  createdByUserId?: string;
};

export const BrandStrategyRepository = {
  getLatest(brandId: string) {
    return prisma.brandStrategyVersion.findFirst({
      where: { brandId },
      orderBy: { version: "desc" },
    });
  },

  async createNextVersion(input: CreateStrategyVersionInput) {
    const latest = await prisma.brandStrategyVersion.findFirst({
      where: { brandId: input.brandId },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    return prisma.brandStrategyVersion.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        version: (latest?.version ?? 0) + 1,
        payload: input.payload as never,
        summary: input.summary,
        createdByUserId: input.createdByUserId,
      },
    });
  },

  // Unlike BrandConstitution, BrandStrategyVersion has no DRAFT/ACTIVE
  // status of its own — "current" is a pointer on BrandDossier. The dossier
  // may not exist yet the first time this runs (it's created on demand via
  // brand-dossier edit actions, not during setup), so this upserts it with
  // only the fields this call owns.
  setCurrentVersion(
    scope: { workspaceId: string; projectId: string; brandId: string },
    versionId: string,
  ) {
    return prisma.brandDossier.upsert({
      where: { brandId: scope.brandId },
      create: { ...scope, currentStrategyVersionId: versionId },
      update: { currentStrategyVersionId: versionId },
    });
  },
};
