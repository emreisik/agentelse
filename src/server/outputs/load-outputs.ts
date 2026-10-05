import "server-only";

import type { Prisma } from "@prisma/client";

import { CHANNELS, isChannelKey, resolveFormat } from "@/lib/content-channels";
import type {
  OutputDelivery,
  OutputPostsPayload,
} from "@/lib/calendar/output-posts";
import { sourceOf } from "@/lib/calendar/source";
import {
  KIND_LABEL,
  kindOf,
  phaseOf,
  type OutputStatus,
} from "@/lib/outputs/panel";
import { prisma } from "@/lib/prisma";
import { utcToZonedDateTimeLocal } from "@/lib/timezone";

// Bir istekte gelen en çok parça. Süzme/sayma istemcide yapıldığı için liste
// tek seferde gelir; bundan eskisi "truncated" ile belirtilir.
export const OUTPUTS_LIMIT = 400;

function clip(text: string | null | undefined, max: number): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

const PLATFORM_LABEL: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TIKTOK: "TikTok",
  LINKEDIN: "LinkedIn",
  X: "X",
  YOUTUBE: "YouTube",
  PINTEREST: "Pinterest",
};

const TYPE_LABEL: Record<string, string> = {
  SOCIAL_POST: "Social post",
  AD_CREATIVE: "Ad",
  CAPTION: "Caption",
  COPY: "Copy",
  CAMPAIGN_BRIEF: "Campaign brief",
  CONTENT_PLAN: "Content plan",
};

const OUTPUT_SELECT = {
  id: true,
  postId: true,
  title: true,
  type: true,
  status: true,
  platform: true,
  channel: true,
  formatKey: true,
  scheduledFor: true,
  createdAt: true,
  updatedAt: true,
  versions: {
    orderBy: { version: "desc" },
    take: 1,
    select: {
      version: true,
      caption: true,
      copy: true,
      contentFormat: true,
      asset: {
        select: { id: true, mimeType: true, storageKey: true },
      },
    },
  },
} satisfies Prisma.CreativeSelect;

type OutputRow = Prisma.CreativeGetPayload<{ select: typeof OUTPUT_SELECT }>;

// Sınır bir postun ortasına düşebilir (liste teslimat sayar, post değil):
// listeye giren postların dışarıda kalan mecraları da okunur, böylece bir
// post panelde hiçbir zaman eksik mecrayla görünmez. Dışarıda kalan her satır
// sınırdan eski ya da sınırla aynı andadır; aynı andakilerden listede
// olanlar hariç tutulur.
async function restOfCutPosts(
  where: Prisma.CreativeWhereInput,
  shown: readonly OutputRow[],
): Promise<OutputRow[]> {
  const boundary = shown.at(-1)?.createdAt;
  const postIds = [
    ...new Set(shown.flatMap((row) => (row.postId ? [row.postId] : []))),
  ];
  if (!boundary || postIds.length === 0) return [];
  const atBoundary = shown
    .filter((row) => row.createdAt.getTime() === boundary.getTime())
    .map((row) => row.id);
  return prisma.creative.findMany({
    where: {
      ...where,
      postId: { in: postIds },
      createdAt: { lte: boundary },
      id: { notIn: atBoundary },
    },
    orderBy: { createdAt: "desc" },
    select: OUTPUT_SELECT,
  });
}

function deliveryOf(
  creative: OutputRow,
  approvalId: string | null,
  timezone: string,
): OutputDelivery {
  const version = creative.versions[0];
  const asset = version?.asset;
  const hasImage = Boolean(
    asset &&
    asset.mimeType.startsWith("image/") &&
    !asset.storageKey.startsWith("mock://"),
  );
  const format =
    isChannelKey(creative.channel) && creative.formatKey
      ? resolveFormat(creative.channel, creative.formatKey)
      : undefined;
  const kind = kindOf({
    type: creative.type,
    contentFormat: version?.contentFormat ?? null,
    glyph: format?.glyph ?? null,
  });
  const source = sourceOf(creative.channel, creative.platform);
  const where = isChannelKey(creative.channel)
    ? CHANNELS[creative.channel].label
    : creative.platform
      ? (PLATFORM_LABEL[creative.platform] ?? source.label)
      : (TYPE_LABEL[creative.type] ?? "Output");
  const scheduledFor = creative.scheduledFor?.toISOString() ?? null;
  const text = version?.copy?.trim() || version?.caption?.trim() || null;
  // ARCHIVED sorguda elendi; kalan değerler OutputStatus'tur.
  const status = creative.status as OutputStatus;

  return {
    id: creative.id,
    postId: creative.postId ?? null,
    title: creative.title,
    preview: clip(text, 140),
    text,
    status,
    phase: phaseOf(status, scheduledFor),
    kind,
    label: `${where} · ${format?.label ?? KIND_LABEL[kind]}`,
    source,
    assetId: hasImage && asset ? asset.id : null,
    version: version?.version ?? null,
    approvalId: creative.status === "IN_REVIEW" ? approvalId : null,
    createdAt: creative.createdAt.toISOString(),
    updatedAt: creative.updatedAt.toISOString(),
    scheduledFor,
    scheduledLocal: creative.scheduledFor
      ? utcToZonedDateTimeLocal(creative.scheduledFor, timezone)
      : null,
  };
}

// Sağ panel Outputs sekmesinin verisi: arşivlenmemiş her parça (en yeniden),
// son sürümü, bekleyen onayı, yayın zamanı ve postu. Aynı postun teslimatları
// istemcide tek kart olur (lib/calendar/output-posts.ts groupOutputs); sınır
// bir postu bölmez (restOfCutPosts). Okuma anı bindirmesi, hiçbir şey
// yazılmaz.
export async function loadOutputs(input: {
  projectId: string;
  timezone: string;
}): Promise<OutputPostsPayload> {
  // A channel left out of its post is not an output.
  const where: Prisma.CreativeWhereInput = {
    projectId: input.projectId,
    status: { not: "ARCHIVED" },
    excludedAt: null,
  };
  const [creatives, approvals] = await Promise.all([
    prisma.creative.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: OUTPUTS_LIMIT + 1,
      select: OUTPUT_SELECT,
    }),
    prisma.approval.findMany({
      where: {
        projectId: input.projectId,
        entityType: "Creative",
        status: "PENDING",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, entityId: true },
    }),
  ]);

  const approvalOf = new Map<string, string>();
  for (const approval of approvals) {
    // En yeni bekleyen onay kazanır (sorgu azalan sıralı).
    if (!approvalOf.has(approval.entityId)) {
      approvalOf.set(approval.entityId, approval.id);
    }
  }

  const truncated = creatives.length > OUTPUTS_LIMIT;
  const shown = creatives.slice(0, OUTPUTS_LIMIT);
  const rest = truncated ? await restOfCutPosts(where, shown) : [];
  const items = [...shown, ...rest].map((creative) =>
    deliveryOf(creative, approvalOf.get(creative.id) ?? null, input.timezone),
  );

  return { items, truncated, timezone: input.timezone };
}
