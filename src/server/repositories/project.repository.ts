import "server-only";

import type { Prisma, ProjectStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreateProjectInput = {
  workspaceId: string;
  name: string;
  slug: string;
  domain?: string;
  brandName?: string;
  language: string;
  country: string;
  // ALL target markets selected in the setup wizard; `country` is the
  // first/primary one (all reasoning/prompt chokepoints still read only
  // that — see schema.prisma). If empty, it's equivalent to [country].
  countries?: string[];
};

// Proje + varsayılan marka: create ve createWithinLimit aynı veriyi kullanır.
function projectCreateData(input: CreateProjectInput) {
  return {
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
  };
}

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

  create(input: CreateProjectInput) {
    return prisma.project.create({
      data: projectCreateData(input),
      include: { brands: true },
    });
  },

  // Faturalama marka limiti (docs/billing-quota.md): sayma ve oluşturma TEK
  // işlemde, workspace başına danışma (advisory) kilidi altında; eşzamanlı N
  // istek limiti aşamaz. Sayım durumdan bağımsızdır (PAUSED/CLOSED dahil: yer
  // açmanın yolu silmek ya da yükseltmektir). limit 0 "sınırsız" DEĞİL, "yasak"tır.
  async createWithinLimit(
    input: CreateProjectInput,
    limit: number,
  ): Promise<
    | {
        ok: true;
        project: Prisma.ProjectGetPayload<{ include: { brands: true } }>;
      }
    | { ok: false; limit: number; current: number }
  > {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brand-limit:${input.workspaceId}`}, 0))`;
        const current = await tx.project.count({
          where: { workspaceId: input.workspaceId },
        });
        if (current >= limit) return { ok: false as const, limit, current };
        const project = await tx.project.create({
          data: projectCreateData(input),
          include: { brands: true },
        });
        return { ok: true as const, project };
      },
      { maxWait: 10_000, timeout: 15_000 },
    );
  },

  async transition(id: string, workspaceId: string, to: ProjectStatus) {
    const project = await prisma.project.findFirst({
      where: { id, workspaceId },
    });
    if (!project)
      throw new AgentelseError(
        "NOT_FOUND",
        `Project ${id} not found in workspace ${workspaceId}`,
      );

    StateMachine.assertProjectTransition(project.status, to);

    return prisma.project.update({ where: { id }, data: { status: to } });
  },
};
