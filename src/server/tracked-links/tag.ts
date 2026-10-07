import "server-only";

import { utmFeatureOn } from "@/lib/tracked-links/flags";
import type { TrackedEntityType } from "@/lib/tracked-links/types";
import {
  agxCampaignName,
  tagOutboundUrl,
  utmFor,
  type TagSkipReason,
  type UtmChannel,
} from "@/lib/utm";

import { projectSiteDomains } from "./domains";
import { utmTaggingOnFor } from "./settings";
import { ensureTrackedLink } from "./store";

export type TagOutboundResult = {
  url: string;
  trackedLinkId: string | null;
  reason: TagSkipReason | "off" | "error" | null;
};

// Genel dış link etiketleyici (ileride link içeren gönderiler için): proje
// ayarı açık ve link projenin kendi sitesindeyse TrackedLink satırı açar ve
// etiketli adresi döndürür. Bayrak kapalıyken sorgusuz, aynı adres. Asla
// fırlatmaz; hata halinde linki aynen bırakır.
export async function tagOutboundLink(input: {
  workspaceId: string;
  projectId: string;
  entityType: TrackedEntityType;
  entityId: string;
  channel: UtmChannel;
  url: string;
  campaignName: string;
  label?: string | null;
  userId?: string | null;
}): Promise<TagOutboundResult> {
  if (!utmFeatureOn()) return { url: input.url, trackedLinkId: null, reason: "off" };
  try {
    if (!(await utmTaggingOnFor(input.projectId))) {
      return { url: input.url, trackedLinkId: null, reason: "off" };
    }
    const campaign = agxCampaignName(input.campaignName);
    const domains = await projectSiteDomains(input.projectId);
    // Kod henüz yok: etiketlenebilirlik yer tutucu kodla yoklanır.
    const decision = tagOutboundUrl({
      url: input.url,
      domains,
      params: utmFor({ channel: input.channel, campaign, code: "000000" }),
      context: "outbound",
    });
    if (!decision.tagged) {
      return { url: input.url, trackedLinkId: null, reason: decision.reason };
    }
    const record = await ensureTrackedLink({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      channel: input.channel,
      destinationUrl: input.url,
      campaign,
      label: input.label ?? input.campaignName,
      userId: input.userId ?? null,
    });
    return { url: record.taggedUrl, trackedLinkId: record.id, reason: null };
  } catch (error) {
    console.warn(
      "[tracked-links] tag failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return { url: input.url, trackedLinkId: null, reason: "error" };
  }
}
