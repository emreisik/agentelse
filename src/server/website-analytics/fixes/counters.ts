import "server-only";

import { prisma } from "@/lib/prisma";
import {
  gaFixAlphaEnabled,
  gaFixesEnabled,
} from "@/lib/website-analytics/fixes/flags";
import type { GaFixCounters } from "@/lib/website-analytics/fixes/view-types";

// /health "Google Analytics fixes" sayaçları (docs/website-fixes.md): yalnız
// sayılar döner (Limited Use); olay adı, mülk ya da Google verisi yok.
// GA_FIXES kapalıyken null ve hiçbir sorgu yapılmaz.

const WINDOW_MS = 30 * 24 * 3_600_000;
const FAILED_SAMPLE = 200;

function errorCodeOf(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "unknown";
  }
  const { code } = value as { code?: unknown };
  return typeof code === "string" && code.length <= 40 ? code : "unknown";
}

export async function loadGaFixCounters(
  now: Date = new Date(),
): Promise<GaFixCounters | null> {
  if (!gaFixesEnabled()) return null;
  const since = new Date(now.getTime() - WINDOW_MS);

  const [grouped, pending, failed, editLinks, watch, watchErrors, outside] =
    await Promise.all([
      prisma.gaConfigChange.groupBy({
        by: ["status"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.gaConfigChange.count({ where: { status: "PROPOSED" } }),
      prisma.gaConfigChange.findMany({
        where: { status: "FAILED" },
        select: { error: true },
        orderBy: { failedAt: { sort: "desc", nulls: "last" } },
        take: FAILED_SAMPLE,
      }),
      prisma.$queryRaw<
        { n: number }[]
      >`SELECT COUNT(*)::int AS n FROM "GaPropertyLink" l JOIN "IntegrationCredential" c ON c."id" = l."credentialId" WHERE l."isPrimary" = true AND c."status" = 'ACTIVE' AND c."metadata" -> 'gaEdit' IS NOT NULL`,
      prisma.gaChangeWatch.aggregate({
        _count: { _all: true },
        _max: { lastRunAt: true },
      }),
      prisma.gaChangeWatch.count({ where: { lastError: { not: null } } }),
      prisma.adsAlert.count({
        where: {
          source: "GA4",
          kind: {
            in: ["GA_CHG_KEY_EVENT_REMOVED", "GA_CHG_RETENTION_SHORTENED"],
          },
          status: { in: ["OPEN", "ACKED"] },
        },
      }),
    ]);

  const byStatus = new Map(grouped.map((row) => [row.status, row._count._all]));
  const count = (status: string): number => byStatus.get(status) ?? 0;
  const failedByCode: Record<string, number> = {};
  for (const row of failed) {
    const code = errorCodeOf(row.error);
    failedByCode[code] = (failedByCode[code] ?? 0) + 1;
  }
  const lastRunAt = watch._max.lastRunAt;

  return {
    linksWithEditAccess: Number(editLinks[0]?.n ?? 0),
    pendingApprovals: pending,
    last30d: {
      // Her satır bir öneridir; durumu ne olursa olsun önerilmiş sayılır.
      proposed: grouped.reduce((sum, row) => sum + row._count._all, 0),
      verified: count("VERIFIED"),
      failed: count("FAILED"),
      undone: count("UNDONE"),
      rejected: count("REJECTED"),
      expired: count("EXPIRED"),
    },
    failedByCode,
    watch: {
      links: watch._count._all,
      lastRunMinutesAgo: lastRunAt
        ? Math.max(
            0,
            Math.floor((now.getTime() - lastRunAt.getTime()) / 60_000),
          )
        : null,
      errors: watchErrors,
    },
    outsideAlertsOpen: outside,
    alphaEnabled: gaFixAlphaEnabled(),
  };
}
