import "server-only";

import type {
  CreativeContentFormat,
  CreativeStatus,
  CreativeType,
  Prisma,
  SocialPlatform,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { StateMachine } from "@/server/state-machine/transitions";

export type CreativeVersionInput = {
  assetId?: string;
  caption?: string;
  copy?: string;
  contentFormat?: CreativeContentFormat;
  generationProvider?: string;
  generationMetadata?: unknown;
  revisionReason?: string;
};

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

  // Content calendar's data source (spec: takvim): every creative that
  // either has a scheduledFor day inside [from, to], OR has no day
  // assigned yet but is still a live candidate for one (the "Unscheduled"
  // tray — draft/in-review/approved, platform-bound; a creative with no
  // platform can't be scheduled to publish anywhere, and
  // rejected/archived/published ones don't belong in a forward-looking
  // planning view). Only the latest version + its asset is needed for a
  // calendar thumbnail, unlike listForProject's full version history.
  listForCalendarRange(projectId: string, range: { from: Date; to: Date }) {
    return prisma.creative.findMany({
      where: {
        projectId,
        OR: [
          { scheduledFor: { gte: range.from, lte: range.to } },
          {
            scheduledFor: null,
            platform: { not: null },
            status: { in: ["DRAFT", "IN_REVIEW", "APPROVED"] },
          },
        ],
      },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { asset: true },
        },
      },
      orderBy: [
        { scheduledFor: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
      ],
    });
  },

  // Content Calendar panosu: aralıktaki her parça (arşivlenmişler hariç; geçmiş
  // yayınlar ve reddedilenler de görünür, durumları takvimin işi) + günü henüz
  // atanmamış ama planlanabilir olanlar. Plan parçası olan Blog/Ads gibi
  // platformsuz kanallar da "atanmamış" tepsisine girer (channel dolu).
  listForCalendarBoard(projectId: string, range: { from: Date; to: Date }) {
    return prisma.creative.findMany({
      where: {
        projectId,
        status: { not: "ARCHIVED" },
        OR: [
          { scheduledFor: { gte: range.from, lte: range.to } },
          {
            scheduledFor: null,
            status: { in: ["DRAFT", "IN_REVIEW", "APPROVED"] },
            OR: [{ platform: { not: null } }, { channel: { not: null } }],
          },
        ],
      },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { asset: true },
        },
      },
      orderBy: [
        { scheduledFor: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
      ],
      take: 400,
    });
  },

  // Slim occupancy read for slot suggestion: no versions/assets join (unlike
  // listForCalendarRange), bounded, and dead creatives never occupy a slot.
  listScheduledInRange(projectId: string, range: { from: Date; to: Date }) {
    return prisma.creative.findMany({
      where: {
        projectId,
        scheduledFor: { gte: range.from, lte: range.to },
        status: { notIn: ["ARCHIVED", "REJECTED"] },
      },
      orderBy: { scheduledFor: "asc" },
      take: 500,
      select: {
        id: true,
        scheduledFor: true,
        channel: true,
        platform: true,
        status: true,
      },
    });
  },

  // Brand Workspace's Outputs tab (spec: workspace-right-panel) — a flat
  // "most recent creatives" feed across every status/platform, unlike
  // listForCalendarRange's forward-looking scheduling window. Same
  // "latest version + asset only" include shape, since the tab only needs
  // a thumbnail, not full version history.
  listRecentForPanel(projectId: string, limit = 24) {
    return prisma.creative.findMany({
      where: { projectId },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          include: { asset: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  setScheduledFor(id: string, projectId: string, date: Date | null) {
    return prisma.creative.updateMany({
      where: { id, projectId },
      data: { scheduledFor: date },
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
      contentFormat?: CreativeContentFormat;
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
      throw new AgentelseError(
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
        contentFormat: input.contentFormat,
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

  // The body of addVersion over a caller-owned transaction (the variant adopt
  // runs it Serializable). addVersion stays as it is.
  async appendVersionTx(
    tx: Prisma.TransactionClient,
    creativeId: string,
    projectId: string,
    input: CreativeVersionInput,
  ) {
    const creative = await tx.creative.findFirst({
      where: { id: creativeId, projectId },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!creative)
      throw new AgentelseError(
        "NOT_FOUND",
        `Creative ${creativeId} not found in project ${projectId}`,
      );
    const nextVersion = (creative.versions[0]?.version ?? 0) + 1;

    const version = await tx.creativeVersion.create({
      data: {
        creativeId,
        version: nextVersion,
        assetId: input.assetId,
        caption: input.caption,
        copy: input.copy,
        contentFormat: input.contentFormat,
        generationProvider: input.generationProvider,
        generationMetadata: input.generationMetadata as never,
        revisionReason: input.revisionReason,
      },
    });

    await tx.creative.update({
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
      throw new AgentelseError(
        "NOT_FOUND",
        `Creative ${id} not found in project ${projectId}`,
      );

    StateMachine.assertCreativeTransition(creative.status, to);

    return prisma.creative.update({ where: { id }, data: { status: to } });
  },
};
