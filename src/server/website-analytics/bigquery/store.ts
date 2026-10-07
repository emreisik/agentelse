import "server-only";

import type { GaBigQuerySource } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// GA4 BigQuery kaynağı satırı için küçük yardımcılar (GA-F8). Google'a gitmez.

// Yenileme isteği bu süreden sık olamaz (son okumadan beri).
export const GA_BQ_REFRESH_THROTTLE_MS = 60 * 60_000;

export async function getBigQuerySource(
  projectId: string,
  linkId: string,
): Promise<GaBigQuerySource | null> {
  return prisma.gaBigQuerySource.findFirst({ where: { projectId, linkId } });
}

// Kaynağı ve okunmuş günlerini siler; denetim kaydı yalnız kimlik taşır.
export async function removeBigQuerySource(input: {
  projectId: string;
  linkId: string;
  userId?: string;
}): Promise<"ok" | "not_found"> {
  const source = await getBigQuerySource(input.projectId, input.linkId);
  if (!source) return "not_found";
  await prisma.$transaction([
    prisma.gaBigQueryDay.deleteMany({ where: { linkId: source.linkId } }),
    prisma.gaBigQuerySource.deleteMany({ where: { id: source.id } }),
  ]);
  await AuditLogRepository.record({
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    actorType: input.userId ? "USER" : "SYSTEM",
    actorId: input.userId,
    action: "ga_bigquery.source_removed",
    entityType: "GaBigQuerySource",
    entityId: source.id,
    metadata: { linkId: source.linkId },
  });
  return "ok";
}

// "Refresh": bir sonraki tick'te okunsun (nextRunAt = şimdi). Son okuma 1 saatten
// yeniyse reddedilir; sorgu maliyetini kullanıcı tıklamasıyla kat kat artırmasın.
export async function requestBigQueryRefresh(input: {
  projectId: string;
  linkId: string;
  now?: Date;
}): Promise<"ok" | "throttled" | "not_found"> {
  const now = input.now ?? new Date();
  const source = await getBigQuerySource(input.projectId, input.linkId);
  if (!source) return "not_found";
  if (
    source.lastRunAt &&
    now.getTime() - source.lastRunAt.getTime() < GA_BQ_REFRESH_THROTTLE_MS
  ) {
    return "throttled";
  }
  await prisma.gaBigQuerySource.updateMany({
    where: { id: source.id },
    data: { nextRunAt: now },
  });
  return "ok";
}
