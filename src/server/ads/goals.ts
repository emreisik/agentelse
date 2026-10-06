import "server-only";

import { kpiMetricFor } from "@/lib/ads/kpi";
import { formatMoney, toMinorUnits } from "@/lib/ads/money";
import { recipeByKey } from "@/lib/ads/objectives";
import type { AdsLaunchSpec } from "@/lib/ads/launch-spec";
import { prisma } from "@/lib/prisma";
import { AdsMirror } from "@/server/ads/mirror-reads";
import { claimPeriodic } from "@/server/observability/periodic";

// Reklam KPI hedefi → ProjectGoal (docs/meta-ads-plan.md §3.3 "KPI hedefi").
// Kullanıcının onayladığı lansmanın hedefi ACTIVE ve USER onaylı yazılır
// (varsayılan PROPOSED'dır); güncel değer haftada bir aynadan güncellenir.

export async function upsertAdsGoal(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  userId: string;
  spec: AdsLaunchSpec;
}): Promise<void> {
  const kpi = input.spec.kpi;
  if (!kpi) return;
  const recipe = recipeByKey(input.spec.recipe);
  const metric = kpiMetricFor(recipe?.resultActionType ?? null);
  const target = toMinorUnits(kpi.target, input.spec.currency);
  const title = `Keep the ${metric.label} under ${formatMoney(target, input.spec.currency)}`;
  const existing = await prisma.projectGoal.findFirst({
    where: { projectId: input.projectId, metricKey: metric.metricKey },
    select: { id: true },
  });
  const data = {
    title,
    description: "Target from the Ads Manager brief (break-even based or entered by you).",
    targetValue: kpi.target,
    status: "ACTIVE" as const,
    approvedByType: "USER" as const,
    approvedByUserId: input.userId,
  };
  if (existing) {
    await prisma.projectGoal.update({ where: { id: existing.id }, data });
  } else {
    await prisma.projectGoal.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        metricKey: metric.metricKey,
        ...data,
      },
    });
  }
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

// Haftalık: aktif reklam hedeflerinin güncel değeri (son 7 gün, hesap
// toplamından; ana birim). Sonuç türü hedefle eşleşmiyorsa yazılmaz.
export async function refreshAdsGoals(now: Date = new Date()): Promise<number> {
  if (!(await claimPeriodic("ads.goals", WEEK_MS, now))) return 0;
  const goals = await prisma.projectGoal.findMany({
    where: { status: "ACTIVE", metricKey: { startsWith: "ads." } },
    select: { id: true, projectId: true, metricKey: true },
    take: 200,
  });
  let updated = 0;
  for (const goal of goals) {
    const account = await AdsMirror.accountFor(goal.projectId).catch(() => null);
    if (!account) continue;
    const row = (await AdsMirror.insightsByObject(account, "ACCOUNT", "last_7d", { now }))
      .get(account.externalId);
    if (!row || row.costPerResult === undefined) continue;
    const label = (row.resultLabel ?? "").toLowerCase();
    const matches =
      (goal.metricKey === "ads.cpl" && label === "leads") ||
      (goal.metricKey === "ads.cost_per_conversation" && label === "conversations started") ||
      (goal.metricKey === "ads.cost_per_click" && (label === "link clicks" || label === "landing page views")) ||
      goal.metricKey === "ads.cpa";
    if (!matches) continue;
    await prisma.projectGoal.update({
      where: { id: goal.id },
      data: { currentValue: Math.round(row.costPerResult * 100) / 100 },
    });
    updated += 1;
  }
  return updated;
}
