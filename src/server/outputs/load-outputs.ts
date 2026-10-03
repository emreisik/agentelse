import "server-only";

import { CHANNELS, isChannelKey, resolveFormat } from "@/lib/content-channels";
import { sourceOf } from "@/lib/calendar/source";
import {
  KIND_LABEL,
  kindOf,
  phaseOf,
  type OutputItem,
  type OutputStatus,
  type OutputsPayload,
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

// Sağ panel Outputs sekmesinin verisi: arşivlenmemiş her parça (en yeniden),
// son sürümü, bekleyen onayı ve yayın zamanı. Okuma anı bindirmesi, hiçbir şey
// yazılmaz.
export async function loadOutputs(input: {
  projectId: string;
  timezone: string;
}): Promise<OutputsPayload> {
  const [creatives, approvals] = await Promise.all([
    prisma.creative.findMany({
      where: { projectId: input.projectId, status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "desc" },
      take: OUTPUTS_LIMIT + 1,
      select: {
        id: true,
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
      },
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
  const items = creatives.slice(0, OUTPUTS_LIMIT).map((creative): OutputItem => {
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
      approvalId:
        creative.status === "IN_REVIEW"
          ? (approvalOf.get(creative.id) ?? null)
          : null,
      createdAt: creative.createdAt.toISOString(),
      updatedAt: creative.updatedAt.toISOString(),
      scheduledFor,
      scheduledLocal: creative.scheduledFor
        ? utcToZonedDateTimeLocal(creative.scheduledFor, input.timezone)
        : null,
    };
  });

  return { items, truncated, timezone: input.timezone };
}
