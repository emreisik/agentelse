import "server-only";

import {
  COVERAGE_MIN_SAMPLE,
  estimateCoverage,
  type CoverageEstimate,
} from "@/lib/seo/coverage";
import {
  addWeeks,
  dateToDayKey,
  dayKeyToDate,
  gscToday,
  weekStartOf,
} from "@/lib/seo/dates";
import { seoMockMode } from "@/lib/seo/health-flags";
import { prisma } from "@/lib/prisma";
import { primaryGscLink } from "@/server/seo/store";

// Haftalık kapsam tahmini (docs/search-health.md "URL Inspection"): son 4
// PT haftasının P6 örneğindeki (sampleWeek) URL'lerin indekslenmiş payı.
// En az COVERAGE_MIN_SAMPLE örnek varsa bu haftanın GscCoverageWeek satırı
// yazılır. Satırlar Search Console bağına cascade'lidir (Google verisi).

export type CoverageWeekRow = CoverageEstimate & {
  weekStart: string;
  population: number;
};

const SAMPLE_WEEKS = 4;
const HISTORY_WEEKS = 12;

function sampleWindow(now: Date): { from: string; to: string } {
  const week = weekStartOf(gscToday(now));
  return { from: addWeeks(week, -(SAMPLE_WEEKS - 1)), to: week };
}

type StoredWeek = {
  weekStart: Date;
  sampled: number;
  indexed: number;
  crawledNotIndexed: number;
  point: number;
  low: number;
  high: number;
  population: number;
};

function toRow(row: StoredWeek): CoverageWeekRow {
  return {
    weekStart: dateToDayKey(row.weekStart),
    sampled: row.sampled,
    indexed: row.indexed,
    crawledNotIndexed: row.crawledNotIndexed,
    point: row.point,
    low: row.low,
    high: row.high,
    population: row.population,
  };
}

export async function refreshCoverageWeek(
  link: { id: string; projectId: string },
  now: Date,
): Promise<CoverageWeekRow | null> {
  const window = sampleWindow(now);
  const rows = await prisma.gscUrlInspection.findMany({
    where: {
      linkId: link.id,
      sampleWeek: { gte: window.from, lte: window.to },
    },
    select: { verdict: true, coverageState: true },
  });
  if (rows.length < COVERAGE_MIN_SAMPLE) return null;
  const estimate = estimateCoverage(rows);
  // Örneklem havuzu: projenin geçerli kipteki sitesinin sitemap URL'leri.
  const population = await prisma.seoPage.count({
    where: {
      projectId: link.projectId,
      inSitemap: true,
      site: { isMock: seoMockMode() },
    },
  });
  const weekStart = dayKeyToDate(window.to);
  const data = {
    projectId: link.projectId,
    sampled: estimate.sampled,
    indexed: estimate.indexed,
    crawledNotIndexed: estimate.crawledNotIndexed,
    point: estimate.point,
    low: estimate.low,
    high: estimate.high,
    population,
    computedAt: now,
  };
  await prisma.gscCoverageWeek.upsert({
    where: { linkId_weekStart: { linkId: link.id, weekStart } },
    create: { ...data, linkId: link.id, weekStart },
    update: data,
  });
  return { ...estimate, weekStart: window.to, population };
}

export async function readCoverage(projectId: string): Promise<{
  current: CoverageWeekRow | null;
  fourWeeksAgo: CoverageWeekRow | null;
  history: CoverageWeekRow[];
  sampledSoFar: number;
} | null> {
  const link = await primaryGscLink(projectId);
  if (!link) return null;
  const window = sampleWindow(new Date());
  const [weeks, sampledSoFar] = await Promise.all([
    prisma.gscCoverageWeek.findMany({
      where: { linkId: link.id },
      orderBy: { weekStart: "desc" },
      take: HISTORY_WEEKS,
    }),
    prisma.gscUrlInspection.count({
      where: {
        linkId: link.id,
        sampleWeek: { gte: window.from, lte: window.to },
      },
    }),
  ]);
  const history = weeks.map(toRow).reverse();
  const current = history[history.length - 1] ?? null;
  // Dört hafta önceki (yoksa ondan önceki en yakın) satır.
  const target = current ? addWeeks(current.weekStart, -4) : null;
  const fourWeeksAgo = target
    ? ([...history].reverse().find((row) => row.weekStart <= target) ?? null)
    : null;
  return { current, fourWeeksAgo, history, sampledSoFar };
}
