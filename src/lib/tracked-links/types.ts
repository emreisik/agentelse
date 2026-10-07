// Etiketli dış linklerin ortak tipleri (GA-F6, GA_UTM; docs/website-attribution.md).
// Saf ve izomorfik. TrackedLink satırının uygulama içi görünümü: kod GA4'te
// utm_content=agx_<kod> olarak geri gelir ve campaign dilimlerini Agentelse
// varlığına bağlar.

import { agxContent, parseUtm, UTM_CHANNELS, type UtmChannel } from "@/lib/utm";

export const TRACKED_ENTITY_TYPES = [
  "meta_ad",
  "instagram_bio",
  "facebook_post",
  "social_post",
] as const;
export type TrackedEntityType = (typeof TRACKED_ENTITY_TYPES)[number];

// Instagram bio linki projede tektir.
export const INSTAGRAM_BIO_ENTITY_ID = "bio";

export type TrackedLinkRef = {
  id: string;
  code: string;
  entityType: TrackedEntityType;
  entityId: string;
  channel: UtmChannel;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  label: string | null;
  campaignExternalId: string | null;
  adExternalId: string | null;
  // Kod GA'ya gerçekten ulaşıyor mu: hedef adreste kullanıcının kendi
  // utm_content'i varsa bizimki eklenmez ve link kodla eşleştirilemez.
  carriesCode: boolean;
  createdAt: string;
};

export type TrackedLinkRecord = TrackedLinkRef & {
  workspaceId: string;
  projectId: string;
  destinationUrl: string;
  taggedUrl: string;
  updatedAt: string;
};

export function carriesAgxCode(input: { code: string; taggedUrl: string }): boolean {
  const content = parseUtm(input.taggedUrl)?.utm_content;
  return content?.toLowerCase() === agxContent(input.code);
}

// Meta reklamı için varlık anahtarı: AdsLaunch satırı Review'da henüz yoktur,
// bu yüzden kart komutu ve reklam sırası kullanılır.
export function metaAdEntityId(commandId: string, adIndex: number): string {
  return `${commandId}:${adIndex}`;
}

export function parseMetaAdEntityId(
  entityId: string,
): { commandId: string; adIndex: number } | null {
  const at = entityId.lastIndexOf(":");
  if (at <= 0) return null;
  const commandId = entityId.slice(0, at);
  const index = entityId.slice(at + 1);
  if (!/^\d{1,6}$/.test(index)) return null;
  return { commandId, adIndex: Number(index) };
}

export function isTrackedEntityType(value: unknown): value is TrackedEntityType {
  return (
    typeof value === "string" &&
    (TRACKED_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

export function isUtmChannel(value: unknown): value is UtmChannel {
  return (
    typeof value === "string" && (UTM_CHANNELS as readonly string[]).includes(value)
  );
}

export function entityKindLabel(entityType: TrackedEntityType): string {
  switch (entityType) {
    case "meta_ad":
      return "Meta ads";
    case "instagram_bio":
      return "Instagram bio link";
    case "facebook_post":
      return "Facebook post";
    case "social_post":
      return "Social post";
  }
}
