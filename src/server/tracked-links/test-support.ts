import { prisma } from "@/lib/prisma";
import type { TrackedEntityType } from "@/lib/tracked-links/types";
import { agxContent, mergeUtm, utmFor, type UtmChannel } from "@/lib/utm";

// Yalnız *.integration.test.ts dosyaları için: TrackedLink tohumlama ve temizlik.

export async function seedTrackedLink(input: {
  workspaceId: string;
  projectId: string;
  entityType: TrackedEntityType;
  entityId: string;
  channel: UtmChannel;
  code: string;
  utmCampaign: string;
  label?: string | null;
  campaignExternalId?: string | null;
  adExternalId?: string | null;
  destinationUrl?: string;
  utmContent?: string;
}): Promise<{ id: string }> {
  const destinationUrl = input.destinationUrl ?? "https://acme.test/";
  const utmContent = input.utmContent ?? agxContent(input.code);
  const params = {
    ...utmFor({
      channel: input.channel,
      campaign: input.utmCampaign,
      code: input.code,
    }),
    utm_content: utmContent,
  };
  const row = await prisma.trackedLink.create({
    data: {
      code: input.code,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      channel: input.channel,
      destinationUrl,
      taggedUrl: mergeUtm(destinationUrl, params).url,
      utmSource: params.utm_source ?? "",
      utmMedium: params.utm_medium ?? "",
      utmCampaign: input.utmCampaign,
      utmContent,
      label: input.label ?? null,
      campaignExternalId: input.campaignExternalId ?? null,
      adExternalId: input.adExternalId ?? null,
    },
    select: { id: true },
  });
  return { id: row.id };
}

export async function cleanupTrackedLinks(projectId: string): Promise<void> {
  await prisma.trackedLink.deleteMany({ where: { projectId } });
  await prisma.linkTrackingSetting.deleteMany({ where: { projectId } });
}
