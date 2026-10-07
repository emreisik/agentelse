import "server-only";

import { prisma } from "@/lib/prisma";
import { reportShareOn } from "@/lib/report-share/flags";
import type { ShareCounters } from "@/lib/seo/agency/types";

// /health operatör sayaçları: yalnız sayılar; bağlantı, rapor, proje ya da
// marka adı yok. Bayraklar kapalıyken sorgu yok.

const DAY_MS = 86_400_000;

export async function loadShareCounters(
  now: Date = new Date(),
): Promise<ShareCounters | null> {
  if (!reportShareOn()) return null;
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const [active, created7d, viewed7d, brandedWorkspaces] = await Promise.all([
    prisma.reportShare.count({
      where: { revokedAt: null, expiresAt: { gt: now } },
    }),
    prisma.reportShare.count({ where: { createdAt: { gte: since } } }),
    // Görüntüleme başına kayıt yok (viewCount ömür boyu toplamdır); bu yüzden
    // son 7 günde en az bir kez açılmış bağlantı sayısı verilir.
    prisma.reportShare.count({ where: { lastViewedAt: { gte: since } } }),
    prisma.reportBranding.count(),
  ]);
  return {
    active,
    created7d,
    viewed7d,
    brandedWorkspaces,
  };
}
