import "server-only";

import type { IdeaStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { CHANNELS, type ChannelKey } from "@/lib/content-channels";
import {
  ideaKeyText,
  parseIdeaConcept,
  type IdeaConcept,
} from "@/lib/ideas/concept";
import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";
import { channelOptions } from "@/lib/works/work";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";
import type { MatchPhoto } from "@/lib/media-match";
import { MemoryService } from "@/server/memory/memory-service";

// Everything the idea engine (idea-engine.ts) shows the model, read in one go:
// the brand, its channels and layouts, what the market is doing (signals,
// opportunities), what worked, and what the pool and the recent posts already
// hold, so new ideas neither miss the point nor repeat. docs/ideas.md.

const RECENT_POSTS = 30;
const SIGNALS = 8;
const OPPORTUNITIES = 5;
const IDEAS_READ = 250;
const DISMISSED = 15;
const SAVED = 8;

const POOL: ReadonlySet<IdeaStatus> = new Set(IDEA_POOL_STATUSES);

export type IdeaRow = {
  id: string;
  status: IdeaStatus;
  title: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  concept: IdeaConcept | null;
  isMock: boolean;
};

export type IdeaContext = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  timezone: string;
  today: string;
  brand: unknown;
  channels: ChannelKey[];
  layouts: { id: string; name: string; headline: boolean; formats: string[] }[];
  defaultLayoutId: string | null;
  signals: {
    n: number;
    title: string;
    summary?: string;
    when?: string;
    url?: string | null;
  }[];
  opportunities: { title: string; description?: string; until?: string }[];
  postResults: { worked: string[]; didNotWork: string[] };
  recentPosts: string[];
  ideas: IdeaRow[];
  // The brand's own photos that are ready to be a post's picture.
  photos: MatchPhoto[];
};

const PHOTOS_READ = 200;

// The library's analysed, live photos, as the matcher reads them.
export async function readMatchPhotos(
  projectId: string,
  // The idea engine and the chat only use photos that were understood; a
  // person choosing a photo by eye on the Ideas board sees every live one.
  options: { understoodOnly?: boolean } = {},
): Promise<MatchPhoto[]> {
  const understoodOnly = options.understoodOnly ?? true;
  const rows = await prisma.brandMedia
    .findMany({
      where: {
        projectId,
        kind: "IMAGE",
        archivedAt: null,
        ...(understoodOnly ? { status: "OK" as const } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: PHOTOS_READ,
      select: {
        assetId: true,
        description: true,
        tags: true,
        subjects: true,
        setting: true,
        quality: true,
        useCount: true,
        lastUsedAt: true,
      },
    })
    .catch((error: unknown) => {
      // Most often: the BrandMedia migration is not applied on this database.
      console.error(
        "[idea-context] brand photos not read:",
        error instanceof Error ? error.message : error,
      );
      return [];
    });
  if (rows.length === 0) return [];
  const sizes = await prisma.asset
    .findMany({
      where: { id: { in: rows.map((row) => row.assetId) }, projectId },
      select: { id: true, width: true, height: true },
    })
    .catch(() => []);
  const sizeOf = new Map(sizes.map((asset) => [asset.id, asset]));
  return rows.map((row) => ({
    ...row,
    width: sizeOf.get(row.assetId)?.width ?? null,
    height: sizeOf.get(row.assetId)?.height ?? null,
  }));
}

// The social channels ideas are made for: the connected ones (as the chat's
// defaults pick them), else Instagram.
export function ideaChannelsOf(
  options: readonly { key: ChannelKey; connected: boolean }[],
): ChannelKey[] {
  const connected = options
    .filter(
      (option) => option.connected && CHANNELS[option.key].group === "social",
    )
    .map((option) => option.key);
  return connected.length > 0 ? connected : ["instagram"];
}

export async function readIdeaRows(projectId: string): Promise<IdeaRow[]> {
  const rows = await prisma.idea.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: IDEAS_READ,
    select: {
      id: true,
      status: true,
      title: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      concept: true,
      isMock: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    concept: parseIdeaConcept(row.concept),
  }));
}

export async function loadIdeaContext(input: {
  projectId: string;
  now: Date;
}): Promise<IdeaContext | null> {
  const { projectId, now } = input;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const brandRow = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  if (!project || !brandRow) return null;
  const brandId = brandRow.id;

  const [
    brand,
    postResults,
    style,
    connections,
    timezone,
    signals,
    opportunities,
    posts,
    ideas,
    photos,
  ] = await Promise.all([
    ConstitutionService.getBrandContext(brandId),
    MemoryService.postLessons(brandId),
    resolveBrandStyleContext(brandId).catch(() => null),
    getChannelConnections(projectId).catch(() => ({})),
    getProjectTimezone(projectId),
    prisma.signal.findMany({
      where: { projectId, status: { in: ["PROMOTED", "SCORED", "NEW"] } },
      orderBy: { createdAt: "desc" },
      take: SIGNALS,
      select: {
        title: true,
        summary: true,
        externalRef: true,
        occurredAt: true,
      },
    }),
    prisma.opportunity.findMany({
      where: {
        projectId,
        status: { in: ["EVALUATED", "ACCEPTED", "REVIEWING"] },
      },
      orderBy: { createdAt: "desc" },
      take: OPPORTUNITIES,
      select: { title: true, description: true, timeWindowEnd: true },
    }),
    prisma.post.findMany({
      where: { projectId, archivedAt: null },
      orderBy: { createdAt: "desc" },
      take: RECENT_POSTS,
      select: { topic: true },
    }),
    readIdeaRows(projectId),
    readMatchPhotos(projectId),
  ]);

  const layouts = style?.visualIdentity?.layoutTemplates ?? null;
  return {
    workspaceId: project.workspaceId,
    projectId,
    brandId,
    timezone,
    today: utcToZonedDateTimeLocal(now, timezone).slice(0, 10),
    brand,
    channels: ideaChannelsOf(channelOptions(connections)),
    layouts: (layouts?.items ?? []).map((layout) => ({
      id: layout.id,
      name: layout.name,
      headline: layout.headline.enabled,
      formats: layout.formats,
    })),
    defaultLayoutId: layouts?.defaultId ?? null,
    signals: signals.map((signal, index) => ({
      n: index + 1,
      title: signal.title,
      ...(signal.summary ? { summary: signal.summary.slice(0, 280) } : {}),
      ...(signal.occurredAt
        ? { when: signal.occurredAt.toISOString().slice(0, 10) }
        : {}),
      url: signal.externalRef,
    })),
    opportunities: opportunities.map((opportunity) => ({
      title: opportunity.title,
      ...(opportunity.description
        ? { description: opportunity.description.slice(0, 280) }
        : {}),
      ...(opportunity.timeWindowEnd
        ? { until: opportunity.timeWindowEnd.toISOString().slice(0, 10) }
        : {}),
    })),
    postResults,
    recentPosts: posts.map((post) => post.topic).filter(Boolean),
    ideas,
    photos,
  };
}

// What the prompt needs of the idea rows: the pool's hooks (do not repeat),
// the saved ones (more like these) and the turned-down ones with their reason.
export function ideaMemoryOf(rows: readonly IdeaRow[]): {
  pool: string[];
  saved: string[];
  dismissed: { idea: string; reason?: string }[];
} {
  const live = rows.filter((row) => !row.isMock);
  return {
    pool: live
      .filter((row) => POOL.has(row.status))
      .map((row) => (row.concept ? ideaKeyText(row.concept) : row.title)),
    saved: live
      .filter((row) => row.status === "APPROVED")
      .slice(0, SAVED)
      .map((row) => (row.concept ? ideaKeyText(row.concept) : row.title)),
    dismissed: live
      .filter((row) => row.status === "REJECTED" && row.concept)
      .slice(0, DISMISSED)
      .map((row) => ({
        idea: ideaKeyText(row.concept!),
        ...(row.concept?.feedback
          ? { reason: row.concept.feedback.reason }
          : {}),
      })),
  };
}
