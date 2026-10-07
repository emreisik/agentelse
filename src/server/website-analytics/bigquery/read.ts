import "server-only";

import { prisma } from "@/lib/prisma";
import { gaBigQueryEnabledFor } from "@/lib/website-analytics/agency/flags";
import {
  monthKeyOf,
  monthlyBudgetBytes,
} from "@/lib/website-analytics/bigquery/budget";
import {
  compareExportToApi,
  type ExportCompare,
} from "@/lib/website-analytics/bigquery/compare";
import { defaultExportDataset } from "@/lib/website-analytics/bigquery/config";
import { addDays, dateToDayKey, dayKeyToDate } from "@/lib/website-analytics/days";
import { readDailyTotals } from "@/server/website-analytics/store";

import { prepareGaBigQueryClient, type GaBigQueryDeps } from "./verify";

export type { GaBigQueryDeps } from "./verify";

// Export check kartının verisi (GA-F8). Yalnız ambardan okur; Google'a ve
// BigQuery'ye gitmez (istemci yalnız yapılandırma/servis hesabı e-postası için sorulur).

const COMPARE_DAYS = 28;
const TOP_LIMIT = 10;

export type BigQueryCardView = {
  state: "off" | "not_configured" | "not_set_up" | "pending" | "ok" | "error";
  serviceAccountEmail: string | null;
  suggestedDataset: string;
  config: {
    gcpProjectId: string;
    datasetId: string;
    location: string | null;
  } | null;
  lastDay: string | null;
  errorCode: string | null;
  compare: ExportCompare | null;
  topEvents: { name: string; count: number }[];
  topPages: { page: string; views: number }[];
  usageBytes: number;
  budgetBytes: number;
};

function offView(): BigQueryCardView {
  return {
    state: "off",
    serviceAccountEmail: null,
    suggestedDataset: "",
    config: null,
    lastDay: null,
    errorCode: null,
    compare: null,
    topEvents: [],
    topPages: [],
    usageBytes: 0,
    budgetBytes: monthlyBudgetBytes(),
  };
}

function entries(value: unknown): unknown[][] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is unknown[] => Array.isArray(item));
}

function topN<T>(map: Map<string, number>, make: (key: string, n: number) => T) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_LIMIT)
    .map(([key, n]) => make(key, n));
}

export async function loadBigQueryCard(
  projectId: string,
  linkId: string,
  deps: GaBigQueryDeps = {},
): Promise<BigQueryCardView> {
  if (!gaBigQueryEnabledFor(projectId)) return offView();

  const link = await prisma.gaPropertyLink.findFirst({
    where: { id: linkId, projectId },
    include: { bigQuerySource: true },
  });
  if (!link) return offView();

  const client = prepareGaBigQueryClient(deps);
  const base = {
    serviceAccountEmail: client.serviceAccountEmail(),
    suggestedDataset: defaultExportDataset(link.propertyId),
    budgetBytes: monthlyBudgetBytes(),
  };
  const empty = {
    config: null,
    lastDay: null,
    errorCode: null,
    compare: null,
    topEvents: [],
    topPages: [],
    usageBytes: 0,
  };

  if (!client.configured()) {
    return { ...base, ...empty, state: "not_configured" };
  }
  const source = link.bigQuerySource;
  if (!source) return { ...base, ...empty, state: "not_set_up" };

  const now = (deps.now ?? (() => new Date()))();
  const usageBytes =
    source.usageMonth === monthKeyOf(now) ? Number(source.usageBytes) : 0;
  const config = {
    gcpProjectId: source.gcpProjectId,
    datasetId: source.datasetId,
    location: source.location,
  };
  const common = {
    ...base,
    config,
    lastDay: source.lastDay,
    errorCode: source.lastError,
    usageBytes,
  };

  if (source.status === "ERROR") {
    return {
      ...common,
      state: "error",
      compare: null,
      topEvents: [],
      topPages: [],
    };
  }
  if (!source.lastDay) {
    return {
      ...common,
      state: "pending",
      compare: null,
      topEvents: [],
      topPages: [],
    };
  }

  // Son 28 gün: dışa aktarım ile GA API (ambar) karşılaştırması ve üst listeler.
  const toDay = source.lastDay;
  const fromDay = addDays(toDay, -(COMPARE_DAYS - 1));
  const [days, totals] = await Promise.all([
    prisma.gaBigQueryDay.findMany({
      where: {
        linkId: link.id,
        date: { gte: dayKeyToDate(fromDay), lte: dayKeyToDate(toDay) },
      },
      orderBy: { date: "asc" },
    }),
    readDailyTotals(link.id, fromDay, toDay),
  ]);

  const events = new Map<string, number>();
  const pages = new Map<string, number>();
  for (const day of days) {
    for (const [name, count] of entries(day.topEvents)) {
      if (typeof name === "string" && typeof count === "number") {
        events.set(name, (events.get(name) ?? 0) + count);
      }
    }
    for (const [page, views] of entries(day.topPages)) {
      if (typeof page === "string" && typeof views === "number") {
        pages.set(page, (pages.get(page) ?? 0) + views);
      }
    }
  }

  return {
    ...common,
    state: "ok",
    compare: compareExportToApi({
      exported: days.map((day) => ({
        day: dateToDayKey(day.date),
        sessions: day.sessions,
        users: day.users,
      })),
      api: totals.map((total) => ({
        day: total.day,
        sessions: total.sessions,
        users: total.activeUsers,
      })),
    }),
    topEvents: topN(events, (name, count) => ({ name, count })),
    topPages: topN(pages, (page, views) => ({ page, views })),
  };
}
