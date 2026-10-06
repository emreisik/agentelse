import "server-only";

import type {
  GaPropertyLink,
  ProjectGoalStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { WEBSITE_GOAL_KEYS } from "@/lib/website-analytics/analysis/types";
import {
  goalMetricOf,
  isWebsiteGoalKey,
  roundGoalValue,
  WEBSITE_GOAL_DESCRIPTION,
  WEBSITE_GOAL_TITLE,
  type GaWebsiteGoalKey,
} from "@/lib/website-analytics/reports/goal-keys";
import {
  gaReportsEnabled,
  gaReportsEnabledFor,
} from "@/lib/website-analytics/reports/flags";
import {
  expectedShareToDate,
  progressViewOf,
} from "@/lib/website-analytics/reports/pace";
import { forecastMonthEnd } from "@/lib/website-analytics/reports/forecast";
import type {
  ForecastBasis,
  GoalProgressView,
  PlanTargetProposal,
} from "@/lib/website-analytics/reports/types";
import { completeThroughOf } from "@/lib/website-analytics/health/schedule";
import { projectCountry } from "@/server/website-analytics/analysis/inputs";
import { primaryGaLink } from "@/server/website-analytics/store";

import { loadForecastContext } from "./forecast";

// Web hedefleri (GA-F5): ProjectGoal.currentValue günde bir güncellenir (ay
// başından bugüne, mülk saatinde) ve GaGoalProgress tahmini tutar. Tempo
// saklanmaz; okurken hedefin güncel targetValue'su ile hesaplanır.

export const GA_GOAL_TRACKED_STATUSES: readonly ProjectGoalStatus[] = [
  "PROPOSED",
  "APPROVED",
  "ACTIVE",
  "PAUSED",
];

const FORECAST_BASES: readonly ForecastBasis[] = [
  "ok",
  "short_history",
  "no_baseline",
  "complete",
];

function basisOf(value: string): ForecastBasis {
  return FORECAST_BASES.find((basis) => basis === value) ?? "no_baseline";
}

type TrackedGoal = {
  id: string;
  title: string;
  status: string;
  metricKey: GaWebsiteGoalKey;
  targetValue: number | null;
};

async function loadTrackedGoals(projectId: string): Promise<TrackedGoal[]> {
  const rows = await prisma.projectGoal.findMany({
    where: {
      projectId,
      metricKey: { in: [...WEBSITE_GOAL_KEYS] },
      status: { in: [...GA_GOAL_TRACKED_STATUSES] },
    },
    select: {
      id: true,
      title: true,
      status: true,
      metricKey: true,
      targetValue: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const goals: TrackedGoal[] = [];
  for (const row of rows) {
    if (!isWebsiteGoalKey(row.metricKey)) continue;
    goals.push({
      id: row.id,
      title: row.title,
      status: row.status,
      metricKey: row.metricKey,
      targetValue: row.targetValue,
    });
  }
  return goals;
}

async function refreshLink(input: {
  link: Pick<GaPropertyLink, "id" | "projectId" | "workspaceId">;
  through: string;
  country: string | null;
  now: Date;
}): Promise<number | "gone"> {
  const { link, through } = input;
  const goals = await prisma.projectGoal.findMany({
    where: {
      projectId: link.projectId,
      metricKey: { in: [...WEBSITE_GOAL_KEYS] },
      status: { in: [...GA_GOAL_TRACKED_STATUSES] },
    },
    select: { id: true, metricKey: true, currentValue: true },
  });
  const tracked: {
    id: string;
    metricKey: GaWebsiteGoalKey;
    currentValue: number | null;
  }[] = [];
  for (const goal of goals) {
    if (isWebsiteGoalKey(goal.metricKey)) {
      tracked.push({
        id: goal.id,
        metricKey: goal.metricKey,
        currentValue: goal.currentValue,
      });
    }
  }
  // Ambar okuması işlemin dışında: uzun işlem tutmaz.
  const context =
    tracked.length > 0
      ? await loadForecastContext({
          linkId: link.id,
          through,
          country: input.country,
        })
      : null;
  const computed = tracked.map((goal) => {
    const metric = goalMetricOf(goal.metricKey);
    const forecast = context
      ? forecastMonthEnd({
          days: context.days,
          metric,
          through,
          exclude: context.exclude,
        })
      : null;
    const share = context
      ? expectedShareToDate({
          days: context.days,
          metric,
          through,
          exclude: context.exclude,
        })
      : null;
    return { goal, forecast, share };
  });

  return prisma.$transaction(async (tx) => {
    // Disconnect yarışı: bağ silinmişse GA rakamı geride bırakılmaz.
    const exists = await tx.gaPropertyLink.findUnique({
      where: { id: link.id },
      select: { id: true },
    });
    if (!exists) return "gone" as const;
    if (computed.length === 0) {
      await tx.gaGoalProgress.deleteMany({
        where: { projectId: link.projectId },
      });
      return 0;
    }
    let changed = 0;
    for (const { goal, forecast, share } of computed) {
      if (!forecast) continue;
      const value = roundGoalValue(goal.metricKey, forecast.monthToDate);
      if (goal.currentValue !== value) {
        await tx.projectGoal.update({
          where: { id: goal.id },
          data: { currentValue: value },
        });
        changed += 1;
      }
      const data = {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        metricKey: goal.metricKey,
        month: forecast.month,
        through: forecast.through,
        dayOfMonth: forecast.dayOfMonth,
        daysInMonth: forecast.daysInMonth,
        monthToDate: forecast.monthToDate,
        expectedShare: share,
        forecast: forecast.forecast,
        forecastLow: forecast.low,
        forecastHigh: forecast.high,
        forecastBasis: forecast.basis,
      };
      await tx.gaGoalProgress.upsert({
        where: { goalId: goal.id },
        create: { goalId: goal.id, ...data },
        update: data,
      });
    }
    await tx.gaGoalProgress.deleteMany({
      where: {
        projectId: link.projectId,
        goalId: { notIn: computed.map((entry) => entry.goal.id) },
      },
    });
    return changed;
  });
}

async function refreshProject(
  projectId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!gaReportsEnabledFor(projectId)) return 0;
  const link = await primaryGaLink(projectId);
  if (!link) return 0;
  const through = completeThroughOf(link.lastDailyDate);
  if (!through) return 0;
  const country = await projectCountry(projectId);
  const result = await refreshLink({ link, through, country, now });
  return result === "gone" ? 0 : result;
}

async function loadProgress(projectId: string): Promise<GoalProgressView[]> {
  if (!gaReportsEnabled()) return [];
  const [rows, goals] = await Promise.all([
    prisma.gaGoalProgress.findMany({ where: { projectId } }),
    loadTrackedGoals(projectId),
  ]);
  const byGoal = new Map(rows.map((row) => [row.goalId, row]));
  const views: GoalProgressView[] = [];
  for (const goal of goals) {
    const row = byGoal.get(goal.id);
    if (!row || row.metricKey !== goal.metricKey) continue;
    views.push(
      progressViewOf({
        goal,
        progress: {
          month: row.month,
          through: row.through,
          dayOfMonth: row.dayOfMonth,
          daysInMonth: row.daysInMonth,
          monthToDate: row.monthToDate,
          expectedShare: row.expectedShare,
          forecast: row.forecast,
          forecastLow: row.forecastLow,
          forecastHigh: row.forecastHigh,
          forecastBasis: basisOf(row.forecastBasis),
          updatedAt: row.updatedAt.toISOString(),
        },
      }),
    );
  }
  const order = (key: GaWebsiteGoalKey) => WEBSITE_GOAL_KEYS.indexOf(key);
  return views.sort((a, b) => order(a.metricKey) - order(b.metricKey));
}

async function applyPlanTargets(input: {
  projectId: string;
  workspaceId: string;
  userId: string;
  proposals: readonly PlanTargetProposal[];
  metricKeys: readonly GaWebsiteGoalKey[];
  isMock: boolean;
}): Promise<{ created: number; updated: number }> {
  const selected = input.metricKeys.flatMap((key) => {
    const proposal = input.proposals.find((item) => item.metricKey === key);
    return proposal ? [{ key, proposal }] : [];
  });
  if (selected.length === 0) return { created: 0, updated: 0 };
  return prisma.$transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let brandId: string | null | undefined;
    for (const { key, proposal } of selected) {
      const existing = await tx.projectGoal.findFirst({
        where: {
          projectId: input.projectId,
          metricKey: key,
          status: { in: [...GA_GOAL_TRACKED_STATUSES] },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      const fields = {
        title: WEBSITE_GOAL_TITLE[key],
        description: WEBSITE_GOAL_DESCRIPTION,
        targetValue: proposal.suggested,
        status: "ACTIVE" as const,
        approvedByType: "USER" as const,
        approvedByUserId: input.userId,
        priority: 2,
      };
      if (existing) {
        await tx.projectGoal.update({ where: { id: existing.id }, data: fields });
        updated += 1;
        continue;
      }
      if (brandId === undefined) {
        const brand = await tx.brand.findFirst({
          where: { projectId: input.projectId, isDefault: true },
          select: { id: true },
        });
        brandId = brand?.id ?? null;
      }
      if (!brandId) {
        throw new Error("The project has no default brand to attach goals to.");
      }
      await tx.projectGoal.create({
        data: {
          ...fields,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          brandId,
          metricKey: key,
          isMock: input.isMock,
        },
      });
      created += 1;
    }
    return { created, updated };
  });
}

export const GaGoals = {
  refreshLink,
  refreshProject,
  loadProgress,
  loadTrackedGoals,
  applyPlanTargets,
};
