import "server-only";

import { prisma } from "@/lib/prisma";
import {
  gaAttributionEnabled,
  gaAttributionEnabledFor,
} from "@/lib/website-analytics/attribution/flags";
import {
  ATTRIBUTION_LEARNING_GATE,
  attributionLearningOf,
} from "@/lib/website-analytics/attribution/learning";
import type { AttributionMetrics } from "@/lib/website-analytics/attribution/types";
import { addDays } from "@/lib/website-analytics/days";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { claimPeriodic } from "@/server/observability/periodic";
import { GA_LEARNING_SOURCE_TYPE } from "@/server/website-analytics/analysis/learnings";
import { attributeWindow } from "@/server/website-analytics/attribution/data";
import {
  loadMeasurementSummaryForLink,
  readGaSuspectDays,
} from "@/server/website-analytics/health/read";
import {
  gaDataThrough,
  primaryGaLink,
  readDailyTotals,
} from "@/server/website-analytics/store";

// GA-F6 öğrenmeleri (docs/website-attribution.md "Öğrenmeler"): etiketli bir
// grup (Meta kampanyası, bio linki, gönderi) sitenin geri kalanına göre key
// event oranında kapıyı (learning.ts) geçerse sayısız tek bir BrandLearning.
// Günde bir koşar; projeler güne göre döner, hiçbiri aç kalmaz. Sinyal, fikir
// ya da Telegram yazmaz.

const DAY_MS = 86_400_000;
const PERIOD_MS = DAY_MS;
const TIME_BUDGET_MS = 120_000;
const DEV_THROTTLE_MS = 30 * 60_000;
const DEFAULT_LIMIT = 200;
const HEARTBEAT_KEY = "ga.attribution.learnings";
const SKIP_HEALTH = [
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
];

// Yerel geliştirmede süreç içi kısma (claimPeriodic/heartbeat yazılmaz).
let devLastRunAt = 0;

function devProjectIds(): string[] {
  return (process.env.GA_SYNC_DEV_PROJECTS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function candidateProjects(devOnly: string[] | null): Promise<string[]> {
  const tracked = await prisma.trackedLink.groupBy({
    by: ["projectId"],
    ...(devOnly ? { where: { projectId: { in: devOnly } } } : {}),
  });
  const projectIds = tracked.map((row) => row.projectId);
  if (projectIds.length === 0) return [];
  const links = await prisma.gaPropertyLink.findMany({
    where: {
      projectId: { in: projectIds },
      isPrimary: true,
      isMock: false,
      health: { notIn: SKIP_HEALTH },
    },
    select: { projectId: true },
  });
  return [...new Set(links.map((link) => link.projectId))].sort();
}

function dayNumber(now: Date): number {
  return Math.floor(now.getTime() / DAY_MS);
}

// Bütün sitenin penceredeki toplamı (şüpheli günler çıkarılmış).
async function siteTotals(
  linkId: string,
  from: string,
  to: string,
  exclude: ReadonlySet<string>,
): Promise<AttributionMetrics> {
  const totals: AttributionMetrics = {
    sessions: 0,
    engagedSessions: 0,
    keyEvents: 0,
    revenue: 0,
  };
  for (const row of await readDailyTotals(linkId, from, to)) {
    if (exclude.has(row.day)) continue;
    totals.sessions += row.sessions;
    totals.engagedSessions += row.engagedSessions;
    totals.keyEvents += row.keyEvents;
    totals.revenue += Number(row.revenueMicros) / 1_000_000;
  }
  return totals;
}

function restOf(
  site: AttributionMetrics,
  group: AttributionMetrics,
): AttributionMetrics {
  return {
    sessions: Math.max(0, site.sessions - group.sessions),
    engagedSessions: Math.max(0, site.engagedSessions - group.engagedSessions),
    keyEvents: Math.max(0, site.keyEvents - group.keyEvents),
    revenue: Math.max(0, site.revenue - group.revenue),
  };
}

async function runProject(projectId: string, now: Date): Promise<number> {
  if (!gaAttributionEnabledFor(projectId)) return 0;
  const link = await primaryGaLink(projectId);
  if (!link || link.isMock) return 0;
  const summary = await loadMeasurementSummaryForLink(link.id);
  if (summary && summary.critical > 0) return 0;

  const { finalThrough } = await gaDataThrough(link.id);
  if (!finalThrough) return 0;
  const range = {
    from: addDays(finalThrough, -(ATTRIBUTION_LEARNING_GATE.windowDays - 1)),
    to: finalThrough,
  };
  const exclude = new Set(
    (await readGaSuspectDays(link.id, range.from, range.to)).keys(),
  );
  const { result } = await attributeWindow({
    projectId,
    linkId: link.id,
    range,
    exclude,
  });
  if (result.groups.length === 0) return 0;
  const site = await siteTotals(link.id, range.from, range.to, exclude);

  let brandId: string | null | undefined;
  let written = 0;
  for (const group of result.groups) {
    const learning = attributionLearningOf({
      group,
      rest: restOf(site, group.metrics),
    });
    if (!learning) continue;
    const exists = await prisma.brandLearning.findFirst({
      where: {
        projectId,
        sourceType: GA_LEARNING_SOURCE_TYPE,
        sourceRef: learning.sourceRef,
      },
      select: { id: true },
    });
    if (exists) continue;
    if (brandId === undefined) {
      brandId =
        (
          await prisma.brand.findFirst({
            where: { projectId, isDefault: true },
            select: { id: true },
          })
        )?.id ?? null;
    }
    if (!brandId) return written;
    await prisma.brandLearning.create({
      data: {
        workspaceId: link.workspaceId,
        projectId,
        brandId,
        insight: learning.insight,
        sourceType: GA_LEARNING_SOURCE_TYPE,
        sourceRef: learning.sourceRef,
        confidence: learning.confidence,
        polarity: learning.polarity,
        lastReinforcedAt: now,
      },
    });
    written += 1;
  }
  return written;
}

async function runDue(
  limit: number = DEFAULT_LIMIT,
  now: Date = new Date(),
): Promise<number> {
  if (!gaAttributionEnabled()) return 0;
  const global = gaGlobalWorkAllowedHere();
  let devOnly: string[] | null = null;
  if (global) {
    if (!(await claimPeriodic(HEARTBEAT_KEY, PERIOD_MS, now))) return 0;
  } else {
    devOnly = devProjectIds();
    if (devOnly.length === 0) return 0;
    if (now.getTime() - devLastRunAt < DEV_THROTTLE_MS) return 0;
    devLastRunAt = now.getTime();
  }

  const candidates = await candidateProjects(devOnly);
  if (candidates.length === 0) return 0;
  const take = Math.min(Math.max(1, Math.floor(limit)), candidates.length);
  const start =
    (dayNumber(now) * Math.max(1, Math.floor(limit))) % candidates.length;
  const startedAt = Date.now();
  let written = 0;
  for (let index = 0; index < take; index += 1) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const projectId = candidates[(start + index) % candidates.length]!;
    try {
      written += await runProject(projectId, now);
    } catch (error) {
      console.warn(
        `[ga-attribution-learnings] project ${projectId} skipped: ${
          error instanceof Error ? error.name : "error"
        }`,
      );
    }
  }
  return written;
}

export const GaAttributionLearnings = {
  runDue,
  runProject,
};
