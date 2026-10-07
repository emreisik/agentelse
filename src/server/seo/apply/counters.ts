import "server-only";

import { prisma } from "@/lib/prisma";
import { seoApplyEnabled } from "@/lib/seo/apply/flags";

// /health "Website changes" sayaçları (docs/website-apply.md): yalnız sayılar
// döner; sayfa yolu, başlık, içerik ya da kimlik yok. SEO_APPLY kapalıyken
// null ve hiçbir sorgu yapılmaz.

const WINDOW_MS = 30 * 24 * 3_600_000;
const FAILED_SAMPLE = 200;

export type SeoApplyCounters = {
  sites: number;
  healthy: number;
  pendingApprovals: number;
  last30d: {
    proposed: number;
    verified: number;
    failed: number;
    undone: number;
    rejected: number;
    expired: number;
  };
  byKind30d: Record<string, number>;
  failedByCode: Record<string, number>;
  indexNow: { projects: number; sent30d: number; failed30d: number };
  linkedActions: number;
};

function errorCodeOf(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "unknown";
  }
  const { code } = value as { code?: unknown };
  return typeof code === "string" && code.length <= 40 ? code : "unknown";
}

export async function loadSeoApplyCounters(
  now: Date = new Date(),
): Promise<SeoApplyCounters | null> {
  if (!seoApplyEnabled()) return null;
  const since = new Date(now.getTime() - WINDOW_MS);

  const [
    sites,
    healthy,
    pending,
    byStatus,
    byKind,
    failed,
    indexNowProjects,
    indexNowSent,
    indexNowFailed,
    linked,
  ] = await Promise.all([
    prisma.cmsSite.count(),
    prisma.cmsSite.count({ where: { health: { in: ["OK", "LIMITED"] } } }),
    prisma.seoChange.count({ where: { status: "PROPOSED" } }),
    prisma.seoChange.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.seoChange.groupBy({
      by: ["kind"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.seoChange.findMany({
      where: { status: "FAILED", createdAt: { gte: since } },
      select: { error: true },
      orderBy: { failedAt: { sort: "desc", nulls: "last" } },
      take: FAILED_SAMPLE,
    }),
    prisma.seoApplySetting.count({ where: { indexNowEnabled: true } }),
    prisma.seoChange.count({
      where: {
        createdAt: { gte: since },
        indexNow: { path: ["state"], equals: "SENT" },
      },
    }),
    prisma.seoChange.count({
      where: {
        createdAt: { gte: since },
        indexNow: { path: ["state"], equals: "FAILED" },
      },
    }),
    prisma.seoChange.count({
      where: {
        createdAt: { gte: since },
        status: "VERIFIED",
        seoActionId: { not: null },
      },
    }),
  ]);

  const statusCount = new Map(
    byStatus.map((row) => [row.status, row._count._all]),
  );
  const count = (status: string): number => statusCount.get(status) ?? 0;
  const byKind30d: Record<string, number> = {};
  for (const row of byKind) byKind30d[row.kind] = row._count._all;
  const failedByCode: Record<string, number> = {};
  for (const row of failed) {
    const code = errorCodeOf(row.error);
    failedByCode[code] = (failedByCode[code] ?? 0) + 1;
  }

  return {
    sites,
    healthy,
    pendingApprovals: pending,
    last30d: {
      // Her satır bir öneridir; durumu ne olursa olsun önerilmiş sayılır.
      proposed: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      verified: count("VERIFIED"),
      failed: count("FAILED"),
      undone: count("UNDONE"),
      rejected: count("REJECTED"),
      expired: count("EXPIRED"),
    },
    byKind30d,
    failedByCode,
    indexNow: {
      projects: indexNowProjects,
      sent30d: indexNowSent,
      failed30d: indexNowFailed,
    },
    linkedActions: linked,
  };
}
