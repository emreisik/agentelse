import "server-only";

import { prisma } from "@/lib/prisma";
import { utmFeatureOn } from "@/lib/tracked-links/flags";
import {
  readLinkTrackingSettings,
  type LinkTrackingSettingsValue,
  type LinkTrackingSettingsView,
} from "@/lib/tracked-links/settings";

// Proje başına link izleme ayarı (GK10). Satır yoksa varsayılan (açık) döner
// ve hiçbir şey yazılmaz.

export async function loadLinkTrackingSettings(
  projectId: string,
): Promise<LinkTrackingSettingsView> {
  const row = await prisma.linkTrackingSetting.findUnique({
    where: { projectId },
    select: { utmEnabled: true },
  });
  return readLinkTrackingSettings(row);
}

// Yetki denetimi çağıranda (yalnız OWNER/ADMIN); burada yalnız yazılır.
export async function saveLinkTrackingSettings(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  value: LinkTrackingSettingsValue;
}): Promise<LinkTrackingSettingsView> {
  const row = await prisma.linkTrackingSetting.upsert({
    where: { projectId: input.projectId },
    create: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      utmEnabled: input.value.utmEnabled,
      updatedByUserId: input.userId,
    },
    update: {
      utmEnabled: input.value.utmEnabled,
      updatedByUserId: input.userId,
    },
    select: { utmEnabled: true },
  });
  return readLinkTrackingSettings(row);
}

// Etiketleme bu proje için açık mı: bayrak kapalıysa sorgusuz false; aksi
// halde ayar satırı (yoksa açık). Okuma hatası etiketlemeyi kapatır, asla
// fırlatmaz.
export async function utmTaggingOnFor(projectId: string): Promise<boolean> {
  if (!utmFeatureOn()) return false;
  try {
    const row = await prisma.linkTrackingSetting.findUnique({
      where: { projectId },
      select: { utmEnabled: true },
    });
    return readLinkTrackingSettings(row).utmEnabled;
  } catch {
    return false;
  }
}
