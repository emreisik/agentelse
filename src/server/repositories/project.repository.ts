import "server-only";

import type { ProjectStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export const ProjectRepository = {
  listForWorkspace(workspaceId: string) {
    return prisma.project.findMany({
      where: { workspaceId },
      include: { brands: true },
      orderBy: { createdAt: "desc" },
    });
  },

  // Always filter by workspaceId even though `id` is already globally unique —
  // this is the belt-and-suspenders check that stops a project fetched by a
  // guessed/leaked ID from resolving outside the caller's own workspace.
  findByIdInWorkspace(projectId: string, workspaceId: string) {
    return prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      include: { brands: true },
    });
  },

  create(input: {
    workspaceId: string;
    name: string;
    slug: string;
    domain?: string;
    brandName?: string;
    language: string;
    country: string;
    // Kurulum sihirbazında seçilen TÜM hedef pazarlar; `country` bunun
    // ilk/birincili (tüm reasoning/prompt chokepoint'leri hâlâ sadece onu
    // okur — bkz. schema.prisma). Boşsa [country] ile aynı anlama gelir.
    countries?: string[];
  }) {
    return prisma.project.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        slug: input.slug,
        domain: input.domain,
        language: input.language,
        country: input.country,
        countries: input.countries?.length ? input.countries : [input.country],
        brands: {
          create: {
            workspaceId: input.workspaceId,
            name: input.brandName ?? input.name,
            slug: "default",
            isDefault: true,
          },
        },
      },
      include: { brands: true },
    });
  },

  async transition(id: string, workspaceId: string, to: ProjectStatus) {
    const project = await prisma.project.findFirst({
      where: { id, workspaceId },
    });
    if (!project)
      throw new HubConnectError(
        "NOT_FOUND",
        `Project ${id} not found in workspace ${workspaceId}`,
      );

    StateMachine.assertProjectTransition(project.status, to);

    return prisma.project.update({ where: { id }, data: { status: to } });
  },
};
