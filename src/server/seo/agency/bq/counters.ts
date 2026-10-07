import "server-only";

import { prisma } from "@/lib/prisma";
import { currentUsageMonth } from "@/lib/seo/agency/bq/cost";
import { gscBigQueryOn } from "@/lib/seo/agency/flags";
import type { BqCounters } from "@/lib/seo/agency/types";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";

// Operatör sayaçları (yalnız sayılar; ad, proje ya da site yok).
export async function loadBqCounters(
  now: Date = new Date(),
): Promise<BqCounters | null> {
  if (!gscBigQueryOn()) return null;
  const isMock = gscMockMode();
  const [byStatus, imported, usage] = await Promise.all([
    prisma.gscBqSource.groupBy({
      by: ["status"],
      where: { isMock },
      _count: { _all: true },
    }),
    prisma.gscPeriodFetch.count({
      where: {
        source: "BQ",
        fetchedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
        link: { isMock },
      },
    }),
    prisma.gscBqSource.aggregate({
      where: { isMock, usageMonth: currentUsageMonth(now) },
      _sum: { bytesBilledMonth: true },
    }),
  ]);
  const count = (status: string) =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;
  return {
    sources: byStatus.reduce((sum, row) => sum + row._count._all, 0),
    active: count("ACTIVE"),
    error: count("ERROR"),
    budget: count("BUDGET"),
    paused: count("PAUSED"),
    periodsImported7d: imported,
    bytesBilledThisMonth: Number(usage._sum.bytesBilledMonth ?? BigInt(0)),
  };
}
