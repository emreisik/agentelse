import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SeoReportFlags } from "@/lib/seo/reports/flags";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";

// /health operatör kartı (docs/search-reports.md "Operatör"): yalnız sayılar;
// proje adı, adres ya da Google verisi yok. SEO_REPORTS kapalıyken sorgu yok.

export type SeoReportCounters = {
  linksTracked: number;
  weekly7d: number;
  monthly35d: number;
  pulses7d: number;
  roadmaps35d: number;
  narrativeSkipped30d: number;
  failingLinks: number;
  goalsTracked: number;
};

const DAY_MS = 86_400_000;

function ago(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export async function loadSeoReportCounters(
  now: Date = new Date(),
): Promise<SeoReportCounters | null> {
  if (!SeoReportFlags.on()) return null;
  const isMock = gscMockMode();
  const since = (kind: string, days: number) => ({
    isMock,
    kind,
    createdAt: { gte: ago(now, days) },
  });
  const [
    linksTracked,
    weekly7d,
    monthly35d,
    pulses7d,
    roadmaps35d,
    narrativeSkipped30d,
    failingLinks,
    goalsTracked,
  ] = await Promise.all([
    prisma.seoReportState.count({ where: { isMock } }),
    prisma.seoReport.count({ where: since("WEEKLY", 7) }),
    prisma.seoReport.count({ where: since("MONTHLY", 35) }),
    prisma.seoReport.count({ where: since("PULSE", 7) }),
    prisma.seoReport.count({ where: since("ROADMAP", 35) }),
    prisma.seoReport.count({
      where: {
        isMock,
        kind: { in: ["WEEKLY", "MONTHLY"] },
        narrative: { equals: Prisma.DbNull },
        createdAt: { gte: ago(now, 30) },
      },
    }),
    prisma.seoReportState.count({
      where: { isMock, consecutiveFailures: { gt: 0 } },
    }),
    prisma.seoGoalProgress.count({ where: { isMock } }),
  ]);
  return {
    linksTracked,
    weekly7d,
    monthly35d,
    pulses7d,
    roadmaps35d,
    narrativeSkipped30d,
    failingLinks,
    goalsTracked,
  };
}
