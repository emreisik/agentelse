import "server-only";

import { prisma } from "@/lib/prisma";
import { gaReportsEnabled } from "@/lib/website-analytics/reports/flags";
import {
  readGaReportSettings,
  type GaReportSettingsValue,
  type GaReportSettingsView,
} from "@/lib/website-analytics/reports/settings";

// GA-F5 rapor tercihleri (GaReportSettings, proje başına tek satır). Satır
// yoksa varsayılanlar geçerlidir ve hiçbir şey yazılmaz.

export async function loadGaReportSettings(
  projectId: string,
): Promise<GaReportSettingsView> {
  const row = await prisma.gaReportSettings.findUnique({
    where: { projectId },
  });
  return readGaReportSettings(row);
}

export async function saveGaReportSettings(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  value: GaReportSettingsValue;
}): Promise<GaReportSettingsView> {
  const row = await prisma.gaReportSettings.upsert({
    where: { projectId: input.projectId },
    create: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ...input.value,
      updatedByUserId: input.userId,
    },
    update: { ...input.value, updatedByUserId: input.userId },
  });
  return readGaReportSettings(row);
}

// SiteAlerts.notifyIfDue'nun sorusu: GA4 uyarısı projenin Telegram'ına gitsin
// mi. Bayrak kapalıyken sorgusuz true (davranış değişmez); okuma hatası da
// true (uyarı yutulmaz).
export async function gaAlertTelegramAllowed(
  projectId: string,
): Promise<boolean> {
  if (!gaReportsEnabled()) return true;
  try {
    const row = await prisma.gaReportSettings.findUnique({
      where: { projectId },
      select: { alertTelegram: true },
    });
    return row?.alertTelegram ?? true;
  } catch (error) {
    console.error(
      "[ga-reports] alert telegram setting could not be read:",
      error instanceof Error ? error.name : "error",
    );
    return true;
  }
}
