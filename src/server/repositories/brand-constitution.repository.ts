import "server-only";

import { prisma } from "@/lib/prisma";

export type CreateConstitutionInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  payload: unknown;
  summary?: string;
  sourceFindingIds?: string[];
  isMock?: boolean;
};

export const BrandConstitutionRepository = {
  getActive(brandId: string) {
    return prisma.brandConstitution.findFirst({
      where: { brandId, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
  },

  // Creates the next version as DRAFT; activation is a separate explicit step
  // so a half-written constitution can never silently become the active one.
  async createNextVersion(input: CreateConstitutionInput) {
    const latest = await prisma.brandConstitution.findFirst({
      where: { brandId: input.brandId },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    return prisma.brandConstitution.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        version: (latest?.version ?? 0) + 1,
        status: "DRAFT",
        payload: input.payload as never,
        summary: input.summary,
        sourceFindingIds: input.sourceFindingIds ?? [],
        isMock: input.isMock ?? false,
      },
    });
  },

  // Atomically supersedes the previous ACTIVE version and activates this one.
  activate(id: string, brandId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.brandConstitution.updateMany({
        where: { brandId, status: "ACTIVE" },
        data: { status: "SUPERSEDED" },
      });
      return tx.brandConstitution.update({
        where: { id },
        data: { status: "ACTIVE" },
      });
    });
  },
};
