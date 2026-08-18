import "server-only";

import type {
  CreativeStatus,
  CreativeType,
  SocialPlatform,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HubConnectError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export const CreativeRepository = {
  listForProject(projectId: string) {
    return prisma.creative.findMany({
      where: { projectId },
      include: { versions: { orderBy: { version: "desc" } } },
      orderBy: { createdAt: "desc" },
    });
  },

  findByIdInProject(id: string, projectId: string) {
    return prisma.creative.findFirst({
      where: { id, projectId },
      include: { versions: { orderBy: { version: "desc" } } },
    });
  },

  create(input: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    type: CreativeType;
    platform?: SocialPlatform;
    title?: string;
    brief?: string;
    createdByTaskId?: string;
  }) {
    return prisma.creative.create({ data: { ...input, status: "DRAFT" } });
  },

  // Creative revisions never overwrite prior versions — the previous
  // CreativeVersion row is left untouched, and this always increments.
  async addVersion(
    creativeId: string,
    projectId: string,
    input: {
      assetId?: string;
      caption?: string;
      copy?: string;
      generationProvider?: string;
      generationMetadata?: unknown;
      revisionReason?: string;
    },
  ) {
    const creative = await prisma.creative.findFirst({
      where: { id: creativeId, projectId },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!creative)
      throw new HubConnectError(
        "NOT_FOUND",
        `Creative ${creativeId} not found in project ${projectId}`,
      );

    const nextVersion = (creative.versions[0]?.version ?? 0) + 1;

    const version = await prisma.creativeVersion.create({
      data: {
        creativeId,
        version: nextVersion,
        assetId: input.assetId,
        caption: input.caption,
        copy: input.copy,
        generationProvider: input.generationProvider,
        generationMetadata: input.generationMetadata as never,
        revisionReason: input.revisionReason,
      },
    });

    await prisma.creative.update({
      where: { id: creativeId },
      data: { currentVersionId: version.id },
    });

    return version;
  },

  async transition(id: string, projectId: string, to: CreativeStatus) {
    const creative = await prisma.creative.findFirst({
      where: { id, projectId },
    });
    if (!creative)
      throw new HubConnectError(
        "NOT_FOUND",
        `Creative ${id} not found in project ${projectId}`,
      );

    StateMachine.assertCreativeTransition(creative.status, to);

    return prisma.creative.update({ where: { id }, data: { status: to } });
  },
};
