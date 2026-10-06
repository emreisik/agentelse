import "server-only";

import { prisma } from "@/lib/prisma";
import { dateToDayKey } from "@/lib/website-analytics/days";
import { GaFlags } from "@/lib/website-analytics/flags";
import {
  summarizeGaLinks,
  type GaHealthCounters,
} from "@/lib/website-analytics/health-counters";
import { Heartbeat } from "@/server/observability/heartbeat";
import { readGaApiCounters } from "@/server/website-analytics/api-counters";

// /health "Google Analytics" sayaçları (docs/google-analytics-plan.md §3.9):
// birincil bağlar, ambardaki en yeni gün, senkron nabzı ve son 24 saatin API
// çağrı/hata sayıları. Yalnız sayılar döner (Limited Use); GA_SYNC kapalıyken
// null ve hiçbir sorgu yapılmaz.

const HEARTBEAT_KEY = "ga.sync";

// Bağ başına GaDailyTotal'daki en yeni gün.
async function latestDays(
  ids: string[],
): Promise<{ linkId: string; date: Date | null }[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.gaDailyTotal.groupBy({
    by: ["linkId"],
    _max: { date: true },
    where: { linkId: { in: ids } },
  });
  return rows.map((row) => ({ linkId: row.linkId, date: row._max.date }));
}

export async function loadGaHealthCounters(
  now: Date = new Date(),
): Promise<GaHealthCounters | null> {
  if (!GaFlags.sync()) return null;

  const links = await prisma.gaPropertyLink.findMany({
    where: { isPrimary: true },
    select: {
      id: true,
      health: true,
      isMock: true,
      consecutiveFailures: true,
      rateLimitedUntil: true,
      lastDailyAt: true,
      backfillDoneAt: true,
      lastQuota: true,
      catalog: true,
      backfill: true,
      timeZone: true,
    },
  });
  const ids = links.map((link) => link.id);

  const [latest, heartbeat, api] = await Promise.all([
    latestDays(ids),
    Heartbeat.read(HEARTBEAT_KEY),
    readGaApiCounters(now),
  ]);
  const latestById = new Map(
    latest.map((row) => [row.linkId, row.date ? dateToDayKey(row.date) : null]),
  );

  const summary = summarizeGaLinks(
    links.map(({ id, ...link }) => ({
      ...link,
      latestDay: latestById.get(id) ?? null,
    })),
    now,
  );
  const lastOkAt = heartbeat?.lastOkAt ?? null;
  return {
    ...summary,
    sync: {
      ...summary.sync,
      heartbeatMinutesAgo: lastOkAt
        ? Math.max(0, Math.floor((now.getTime() - lastOkAt.getTime()) / 60_000))
        : null,
    },
    api,
  };
}
