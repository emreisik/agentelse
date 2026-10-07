import "server-only";

import { prisma } from "@/lib/prisma";
import { applyMockMode, seoGeoEnabled, seoGeoTrafficEnabled } from "@/lib/seo/apply/flags";
import { parseGeoResult } from "@/lib/seo/geo/types";

// /health "AI search visibility" operatör sayaçları (SC-F8): yalnız sayılar.
// Proje adı, adres, sayfa ya da kurum adı hiç seçilmez; Limited Use için GA
// verisi de yoktur (yalnız GA bağlı proje sayısı). Bayrak kapalıyken
// veritabanına gidilmez. Yalnız geçerli kipin (gerçek/mock) satırları sayılır.

export type SeoGeoCounters = {
  sites: number;
  audited30d: number;
  scoreBuckets: { low: number; mid: number; high: number };
  warnByCheck: Record<string, number>;
  llmsPresent: number;
  trafficLinked: number;
};

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const ROW_LIMIT = 5_000;
const LOW_BELOW = 50;
const HIGH_FROM = 80;

export async function loadSeoGeoCounters(
  now: Date = new Date(),
): Promise<SeoGeoCounters | null> {
  if (!seoGeoEnabled()) return null;
  const isMock = applyMockMode();
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const rows = await prisma.seoGeoAudit.findMany({
    where: { isMock },
    take: ROW_LIMIT,
    select: { projectId: true, auditedAt: true, result: true },
  });

  const counters: SeoGeoCounters = {
    sites: rows.length,
    audited30d: 0,
    scoreBuckets: { low: 0, mid: 0, high: 0 },
    warnByCheck: {},
    llmsPresent: 0,
    trafficLinked: 0,
  };
  for (const row of rows) {
    const result = parseGeoResult(row.result);
    if (!result) continue;
    if (row.auditedAt >= since) counters.audited30d += 1;
    if (result.score !== null) {
      if (result.score < LOW_BELOW) counters.scoreBuckets.low += 1;
      else if (result.score < HIGH_FROM) counters.scoreBuckets.mid += 1;
      else counters.scoreBuckets.high += 1;
    }
    for (const check of result.checks) {
      if (check.status === "WARN") {
        counters.warnByCheck[check.id] =
          (counters.warnByCheck[check.id] ?? 0) + 1;
      }
    }
    if (result.llms.state === "present") counters.llmsPresent += 1;
  }

  if (seoGeoTrafficEnabled() && rows.length > 0) {
    counters.trafficLinked = await prisma.gaPropertyLink
      .count({
        where: {
          isPrimary: true,
          isMock,
          projectId: { in: [...new Set(rows.map((row) => row.projectId))] },
        },
      })
      .catch(() => 0);
  }
  return counters;
}
