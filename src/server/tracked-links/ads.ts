import "server-only";

import { prisma } from "@/lib/prisma";
import { ADS_LIMITS } from "@/lib/module-flows/ads/state";
import { metaAdTaggable, metaAdUrlTags } from "@/lib/tracked-links/ads";
import { utmFeatureOn } from "@/lib/tracked-links/flags";
import { metaAdEntityId } from "@/lib/tracked-links/types";
import { agxCampaignName } from "@/lib/utm";

import { projectSiteDomains } from "./domains";
import { utmTaggingOnFor } from "./settings";
import { ensureTrackedLink } from "./store";

const LINK_MAX = 2048;

// Lansmanın kaç reklam kuracağı (launchSpecFromFlow ile aynı kural): carousel
// tek reklamdır (ek postlar kart olur), diğerlerinde ana reklam + en çok
// ADS_LIMITS.maxExtraSeparate ek reklam.
function plannedAdCount(brief: {
  messages?: unknown;
  objective?: string;
  adFormat?: string;
  extraSources?: readonly unknown[];
}): number {
  const extras = brief.extraSources?.length ?? 0;
  const carousel =
    brief.adFormat === "carousel" &&
    !brief.messages &&
    brief.objective !== "OUTCOME_LEADS" &&
    extras >= 1;
  return carousel ? 1 : 1 + Math.min(extras, ADS_LIMITS.maxExtraSeparate);
}

// Bu Review'da etiketlenmeyecek reklamların önceki Review'dan kalan satırlarını
// siler: kod taşımayan reklam atıf grubunda görünmesin, sahte tıklama kaybı
// uyarısı çıkmasın. Lansmanı yapılmış (adExternalId dolu) satıra dokunmaz.
async function pruneStaleAdLinks(
  projectId: string,
  commandId: string,
  keepEntityIds: readonly string[],
): Promise<void> {
  try {
    await prisma.trackedLink.deleteMany({
      where: {
        projectId,
        entityType: "meta_ad",
        entityId: {
          startsWith: `${commandId}:`,
          ...(keepEntityIds.length > 0 ? { notIn: [...keepEntityIds] } : {}),
        },
        adExternalId: null,
      },
    });
  } catch (error) {
    console.warn(
      "[tracked-links] stale ad links not pruned:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}

// Meta lansmanında (Review) reklam başına url_tags. undefined = bugünkü
// DEFAULT_URL_TAGS kalır (bayrak/ayar kapalı, mesaj reklamı, yabancı ya da
// utm_content'li link, hata). Aynı girdi aynı dizeleri verir: TrackedLink
// (projectId, meta_ad, commandId:index) tektir ve kodunu korur.
export async function adLaunchUrlTags(input: {
  workspaceId: string;
  projectId: string;
  commandId: string;
  userId: string;
  brief: {
    link: string;
    messages?: unknown;
    objective?: string;
    adFormat?: string;
    extraSources?: readonly unknown[];
  };
  plan: { campaignName: string };
}): Promise<string[] | undefined> {
  if (!utmFeatureOn()) return undefined;
  const tags = await buildAdTags(input);
  // Etiketlenmeyen Review (ayar kapandı, link değişti, hata) önceki Review'dan
  // kalan satırları bırakmaz; kısmen yazılmış satırlar da burada temizlenir.
  await pruneStaleAdLinks(
    input.projectId,
    input.commandId,
    tags.entityIds,
  );
  return tags.urlTags;
}

async function buildAdTags(
  input: Parameters<typeof adLaunchUrlTags>[0],
): Promise<{ urlTags: string[] | undefined; entityIds: string[] }> {
  const none = { urlTags: undefined, entityIds: [] };
  try {
    if (!(await utmTaggingOnFor(input.projectId))) return none;
    const domains = await projectSiteDomains(input.projectId);
    const link = input.brief.link.trim();
    if (
      link.length > LINK_MAX ||
      !metaAdTaggable({ link, messages: input.brief.messages, domains })
    ) {
      return none;
    }

    const campaign = agxCampaignName(input.plan.campaignName);
    const adCount = plannedAdCount(input.brief);
    const tags: string[] = [];
    const entityIds: string[] = [];
    // Sıralı: kod çakışması yeniden denemesi satırları birbirine karıştırmasın.
    for (let adIndex = 0; adIndex < adCount; adIndex += 1) {
      const entityId = metaAdEntityId(input.commandId, adIndex);
      const record = await ensureTrackedLink({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        entityType: "meta_ad",
        entityId,
        channel: "meta_ads",
        destinationUrl: link,
        campaign,
        label: input.plan.campaignName,
        userId: input.userId,
      });
      const urlTags = metaAdUrlTags({ link, campaign, code: record.code });
      if (!urlTags) return none;
      tags.push(urlTags);
      entityIds.push(entityId);
    }
    return { urlTags: tags, entityIds };
  } catch (error) {
    console.warn(
      "[tracked-links] ad tags skipped:",
      error instanceof Error ? error.name : "unknown",
    );
    return none;
  }
}
