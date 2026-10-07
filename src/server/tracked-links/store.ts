import "server-only";

import { Prisma, type TrackedLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { newTrackedLinkCode } from "@/lib/tracked-links/codes";
import {
  carriesAgxCode,
  isTrackedEntityType,
  isUtmChannel,
  parseMetaAdEntityId,
  type TrackedEntityType,
  type TrackedLinkRecord,
} from "@/lib/tracked-links/types";
import { mergeUtm, utmFor, type UtmChannel } from "@/lib/utm";

// Etiketli linklerin deposu (GA-F6). Her (proje, varlık türü, varlık) için tek
// satır; kod bütün projelerde benzersiz. Google verisi tutmaz.

const DESTINATION_MAX = 2048;
const LABEL_MAX = 120;
const LIST_LIMIT_MAX = 2000;
// Kod çakışmasında ilk denemeden sonra en çok 5 yeniden deneme.
const CODE_RETRIES = 5;

export type EnsureTrackedLinkInput = {
  workspaceId: string;
  projectId: string;
  entityType: TrackedEntityType;
  entityId: string;
  channel: UtmChannel;
  destinationUrl: string;
  // Zaten agx- öneki taşıyan kampanya adı (agxCampaignName çıktısı).
  campaign: string;
  label: string | null;
  userId: string | null;
};

function toRecord(row: TrackedLink): TrackedLinkRecord | null {
  if (!isTrackedEntityType(row.entityType) || !isUtmChannel(row.channel)) {
    return null;
  }
  return {
    id: row.id,
    code: row.code,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    entityType: row.entityType,
    entityId: row.entityId,
    channel: row.channel,
    destinationUrl: row.destinationUrl,
    taggedUrl: row.taggedUrl,
    utmSource: row.utmSource,
    utmMedium: row.utmMedium,
    utmCampaign: row.utmCampaign,
    utmContent: row.utmContent,
    label: row.label,
    campaignExternalId: row.campaignExternalId,
    adExternalId: row.adExternalId,
    carriesCode: carriesAgxCode(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requireRecord(row: TrackedLink): TrackedLinkRecord {
  const record = toRecord(row);
  if (!record) throw new Error("tracked_link_unknown_type");
  return record;
}

function clipLabel(label: string | null): string | null {
  const clipped = (label ?? "").trim().slice(0, LABEL_MAX).trim();
  return clipped === "" ? null : clipped;
}

// P2002'nin hangi benzersiz kısıttan geldiği: hedef alan listesi ya da dizin adı.
function uniqueTarget(error: unknown): "code" | "entity" | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return /(^|[^a-z])code([^a-z]|$)/i.test(text) ? "code" : "entity";
}

export async function findTrackedLink(
  projectId: string,
  entityType: TrackedEntityType,
  entityId: string,
): Promise<TrackedLinkRecord | null> {
  const row = await prisma.trackedLink.findUnique({
    where: { projectId_entityType_entityId: { projectId, entityType, entityId } },
  });
  return row ? toRecord(row) : null;
}

export async function ensureTrackedLink(
  input: EnsureTrackedLinkInput,
): Promise<TrackedLinkRecord> {
  const destinationUrl = input.destinationUrl.trim().slice(0, DESTINATION_MAX);
  const label = clipLabel(input.label);
  const key = {
    projectId: input.projectId,
    entityType: input.entityType,
    entityId: input.entityId,
  };

  const existing = await prisma.trackedLink.findUnique({
    where: { projectId_entityType_entityId: key },
  });
  if (existing) return refreshExisting(existing, input, destinationUrl, label);

  for (let attempt = 0; attempt <= CODE_RETRIES; attempt += 1) {
    const code = newTrackedLinkCode();
    const params = utmFor({ channel: input.channel, campaign: input.campaign, code });
    try {
      const row = await prisma.trackedLink.create({
        data: {
          code,
          workspaceId: input.workspaceId,
          ...key,
          channel: input.channel,
          destinationUrl,
          taggedUrl: mergeUtm(destinationUrl, params).url,
          utmSource: params.utm_source ?? "",
          utmMedium: params.utm_medium ?? "",
          utmCampaign: params.utm_campaign ?? "",
          utmContent: params.utm_content ?? "",
          label,
          createdByUserId: input.userId,
        },
      });
      return requireRecord(row);
    } catch (error) {
      const target = uniqueTarget(error);
      if (target === "code") continue;
      if (target === "entity") {
        // Aynı varlık için eşzamanlı yazma: kazananın satırı döner.
        const winner = await prisma.trackedLink.findUnique({
          where: { projectId_entityType_entityId: key },
        });
        if (winner) return requireRecord(winner);
      }
      throw error;
    }
  }
  throw new Error("tracked_link_code_exhausted");
}

// Var olan satır kodunu korur; yalnız değişen alanlar yazılır, değişen yoksa
// hiç yazılmaz (updatedAt oynamaz).
async function refreshExisting(
  existing: TrackedLink,
  input: EnsureTrackedLinkInput,
  destinationUrl: string,
  label: string | null,
): Promise<TrackedLinkRecord> {
  const params = utmFor({
    channel: input.channel,
    campaign: input.campaign,
    code: existing.code,
  });
  const next = {
    channel: input.channel,
    destinationUrl,
    taggedUrl: mergeUtm(destinationUrl, params).url,
    utmSource: params.utm_source ?? "",
    utmMedium: params.utm_medium ?? "",
    utmCampaign: params.utm_campaign ?? "",
    utmContent: params.utm_content ?? "",
    label,
  };
  const changed = (Object.keys(next) as (keyof typeof next)[]).some(
    (field) => existing[field] !== next[field],
  );
  if (!changed) return requireRecord(existing);
  const row = await prisma.trackedLink.update({
    where: { id: existing.id },
    data: next,
  });
  return requireRecord(row);
}

// Projenin etiketli linkleri, en yeni önce. Bilinmeyen tür ya da kanal taşıyan
// satırlar atlanır.
export async function findTrackedLinksForProject(
  projectId: string,
  options: { entityTypes?: readonly TrackedEntityType[]; limit?: number } = {},
): Promise<TrackedLinkRecord[]> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? LIST_LIMIT_MAX), 1),
    LIST_LIMIT_MAX,
  );
  const rows = await prisma.trackedLink.findMany({
    where: {
      projectId,
      ...(options.entityTypes ? { entityType: { in: [...options.entityTypes] } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  const out: TrackedLinkRecord[] = [];
  for (const row of rows) {
    const record = toRecord(row);
    if (record) out.push(record);
  }
  return out;
}

function adIdOf(progress: unknown, adIndex: number): string | null {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
    return null;
  }
  const ads = (progress as { ads?: unknown }).ads;
  if (!ads || typeof ads !== "object" || Array.isArray(ads)) return null;
  const id = (ads as Record<string, unknown>)[String(adIndex)];
  return typeof id === "string" && id !== "" ? id : null;
}

// Meta reklam linklerinin kampanya ve reklam kimlikleri lansman ilerledikçe
// tembel çözülür: tek AdsLaunch sorgusu, sonuç satıra önbelleklenir. Önbellek
// yazımı başarısız olursa bellekteki çözüm yine de döner.
export async function resolveMetaAdLinks(
  links: readonly TrackedLinkRecord[],
): Promise<TrackedLinkRecord[]> {
  const pending = links.flatMap((link) => {
    if (link.entityType !== "meta_ad") return [];
    if (link.campaignExternalId !== null && link.adExternalId !== null) return [];
    const parsed = parseMetaAdEntityId(link.entityId);
    return parsed ? [{ link, ...parsed }] : [];
  });
  if (pending.length === 0) return [...links];

  // Başka projenin lansmanı bu projenin satırına kimlik yazamaz: sorgu da
  // eşleştirme de projeye bağlıdır.
  const launches = await prisma.adsLaunch.findMany({
    where: {
      projectId: { in: [...new Set(pending.map((item) => item.link.projectId))] },
      commandId: { in: [...new Set(pending.map((item) => item.commandId))] },
      campaignExternalId: { not: null },
    },
    select: {
      projectId: true,
      commandId: true,
      campaignExternalId: true,
      progress: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  const newest = new Map<string, (typeof launches)[number]>();
  for (const launch of launches) {
    const key = `${launch.projectId}|${launch.commandId}`;
    if (!newest.has(key)) newest.set(key, launch);
  }

  const resolved = new Map<string, TrackedLinkRecord>();
  const writes: Promise<unknown>[] = [];
  for (const { link, commandId, adIndex } of pending) {
    const launch = newest.get(`${link.projectId}|${commandId}`);
    if (!launch) continue;
    const campaignExternalId = link.campaignExternalId ?? launch.campaignExternalId;
    const adExternalId = link.adExternalId ?? adIdOf(launch.progress, adIndex);
    if (
      campaignExternalId === link.campaignExternalId &&
      adExternalId === link.adExternalId
    ) {
      continue;
    }
    resolved.set(link.id, { ...link, campaignExternalId, adExternalId });
    writes.push(
      prisma.trackedLink.updateMany({
        // Yalnız hâlâ boş olan alan yazılır; eşzamanlı çözüm birbirini ezmez.
        where:
          link.campaignExternalId === null
            ? { id: link.id, campaignExternalId: null }
            : { id: link.id, adExternalId: null },
        data: {
          ...(link.campaignExternalId === null ? { campaignExternalId } : {}),
          ...(link.adExternalId === null && adExternalId !== null ? { adExternalId } : {}),
        },
      }),
    );
  }
  await Promise.allSettled(writes);
  return links.map((link) => resolved.get(link.id) ?? link);
}
