import "server-only";

import { prisma } from "@/lib/prisma";
import { buildBrandKit, type BrandKit } from "@/lib/brand-kit";
import type { ChannelKey } from "@/lib/content-channels";
import type { BoardIdea, IdeaLink } from "@/lib/ideas/board";
import { channelOptions } from "@/lib/works/work";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { loadConnectedAccounts } from "@/server/integrations/connected-accounts";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";
import {
  ideaChannelsOf,
  readIdeaRows,
  type IdeaRow,
} from "@/server/ideas/idea-context";
import { IDEA_MADE_POST_ACTION } from "@/server/ideas/idea-post";
import { moduleIdeasAvailable } from "@/server/ideas/idea-modules";
import { lowWaterOf, poolHealth, refillDue } from "@/server/ideas/idea-refill";

// Everything the Ideas board shows (docs/ideas.md), read in one go on the
// server: the ideas with where each one went (the chat holding its post draft,
// its planned or published post), the brand kit its cards are drawn with, the
// account the posts go out as, and the pool's health.

export type IdeaBoardData = {
  projectId: string;
  ideas: BoardIdea[];
  kit: BrandKit | null;
  brandName: string;
  // "@handle" of the connected Instagram account, when there is one.
  handle: string | null;
  channels: ChannelKey[];
  health: {
    fresh: number;
    poolSize: number;
    lastRunAt: string | null;
    // The board tops the pool up once when it opens.
    due: boolean;
  };
  timezone: string;
  // The module lenses that can act on their ideas now (idea-modules.ts).
  modules: { seo: boolean; ads: boolean };
};

export function toBoardIdea(row: IdeaRow, link?: IdeaLink): BoardIdea {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    title: row.title,
    description: row.description,
    concept: row.concept,
    ...(link ? { link } : {}),
  };
}

async function linksOf(
  projectId: string,
  ideaIds: readonly string[],
): Promise<Map<string, IdeaLink>> {
  const links = new Map<string, IdeaLink>();
  if (ideaIds.length === 0) return links;
  const [made, posts] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        projectId,
        action: IDEA_MADE_POST_ACTION,
        entityType: "Idea",
        entityId: { in: [...ideaIds] },
      },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, metadata: true },
    }),
    prisma.post.findMany({
      where: { projectId, ideaId: { in: [...ideaIds] }, archivedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        ideaId: true,
        workId: true,
        scheduledFor: true,
        deliveries: { select: { status: true } },
      },
    }),
  ]);
  for (const row of made) {
    const workId = (row.metadata as { workId?: unknown } | null)?.workId;
    if (typeof workId === "string" && !links.has(row.entityId)) {
      links.set(row.entityId, { workId });
    }
  }
  for (const post of posts) {
    if (!post.ideaId) continue;
    const previous = links.get(post.ideaId) ?? {};
    links.set(post.ideaId, {
      ...previous,
      ...(post.workId ? { workId: post.workId } : {}),
      ...(post.scheduledFor
        ? { scheduledFor: post.scheduledFor.toISOString() }
        : {}),
      published: post.deliveries.some(
        (delivery) => delivery.status === "PUBLISHED",
      ),
    });
  }
  return links;
}

export async function loadIdeaBoard(
  projectId: string,
  now: Date = new Date(),
): Promise<IdeaBoardData> {
  const brandRow = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  const projectRow = await prisma.project.findUnique({
    where: { id: projectId },
    select: { domain: true },
  });
  const [rows, health, twin, style, accounts, connections, timezone, modules] =
    await Promise.all([
      readIdeaRows(projectId),
      poolHealth(projectId, now),
      getBrandTwin(projectId),
      brandRow ? resolveBrandStyleContext(brandRow.id).catch(() => null) : null,
      loadConnectedAccounts(projectId, projectRow?.domain ?? null).catch(
        () => [],
      ),
      getChannelConnections(projectId).catch(() => ({})),
      getProjectTimezone(projectId),
      moduleIdeasAvailable(projectId).catch(() => ({ seo: false, ads: false })),
    ]);
  const links = await linksOf(
    projectId,
    rows.map((row) => row.id),
  );

  const kit = twin
    ? buildBrandKit({
        legacyColors: twin.visualDNA.colors,
        fonts: twin.visualDNA.fonts,
        logoAssetId: style?.logoAssetId ?? twin.visualDNA.logoAssetId,
        darkLogoAssetId: style?.darkLogoAssetId ?? null,
        identity: style?.visualIdentity ?? null,
      })
    : null;
  const instagram = accounts.find(
    (account) => account.key === "instagram" && account.state === "connected",
  );
  const handle = instagram?.detail
    ? instagram.detail.startsWith("@")
      ? instagram.detail
      : `@${instagram.detail}`
    : null;

  return {
    projectId,
    ideas: rows.map((row) => toBoardIdea(row, links.get(row.id))),
    kit,
    brandName: twin?.name ?? "",
    handle,
    channels: ideaChannelsOf(channelOptions(connections)),
    health: {
      fresh: health.fresh,
      poolSize: health.poolSize,
      lastRunAt: health.last?.createdAt.toISOString() ?? null,
      due: refillDue({
        fresh: health.fresh,
        lowWater: lowWaterOf(health.poolSize, health.unlimited),
        last: health.last,
        now,
        room: health.room,
      }),
    },
    timezone,
    modules,
  };
}
