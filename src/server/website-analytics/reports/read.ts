import "server-only";

import { prisma } from "@/lib/prisma";
import { gaReportsEnabled } from "@/lib/website-analytics/reports/flags";
import { goalFormatOf } from "@/lib/website-analytics/reports/goal-keys";
import { readWebsiteReportCard } from "@/lib/website-analytics/reports/card";
import { monthLabel } from "@/lib/website-analytics/reports/copy";
import {
  reportCommandPrefix,
  reportHrefs,
  websiteWorkId,
} from "@/lib/website-analytics/reports/ids";
import { paceLabel, paceTone } from "@/lib/website-analytics/reports/pace";
import type {
  GoalPaceChipView,
  WebsiteReportArchiveItem,
} from "@/lib/website-analytics/reports/types";
import { GaFlags } from "@/lib/website-analytics/flags";

import { GaGoals } from "./goals";

// GA-F5 okuyucuları: Brand Brain → Goals tempo çipleri ve Website sayfasının
// "Reports" arşivi. Bayrak kapalıyken sorgusuz boş döner.

const ARCHIVE_LIMIT = 12;

// Anahtar hedef kimliğidir.
export async function loadGoalPaceMap(
  projectId: string,
): Promise<Map<string, GoalPaceChipView>> {
  const result = new Map<string, GoalPaceChipView>();
  if (!gaReportsEnabled()) return result;
  const progress = await GaGoals.loadProgress(projectId);
  if (progress.length === 0) return result;
  const links = await prisma.gaPropertyLink.findMany({
    where: { projectId, isPrimary: true },
    select: { currencyCode: true },
    take: 1,
  });
  const currency = links[0]?.currencyCode ?? null;
  for (const view of progress) {
    result.set(view.goalId, {
      goalId: view.goalId,
      metricKey: view.metricKey,
      pace: view.pace,
      label: paceLabel(view.pace),
      tone: paceTone(view.pace),
      month: view.month,
      monthLabel: monthLabel(view.month),
      through: view.through,
      monthToDate: view.monthToDate,
      target: view.target,
      forecast: view.forecast,
      low: view.forecastLow,
      high: view.forecastHigh,
      basis: view.forecastBasis,
      format: goalFormatOf(view.metricKey),
      currency,
    });
  }
  return result;
}

function cardOf(parsedIntent: unknown): unknown {
  return parsedIntent && typeof parsedIntent === "object"
    ? (parsedIntent as { card?: unknown }).card
    : null;
}

// Website analytics sohbetindeki en yeni haftalık, aylık ve plan kartları
// (nabız ve uyarı kartları arşive girmez). Geçersiz kart satırı düşer.
export async function loadWebsiteReportArchive(
  projectId: string,
  limit: number = ARCHIVE_LIMIT,
): Promise<WebsiteReportArchiveItem[] | null> {
  if (!gaReportsEnabled()) return null;
  const rows = await prisma.command.findMany({
    where: {
      projectId,
      workId: websiteWorkId(projectId),
      source: "SYSTEM",
      OR: (["weekly", "monthly", "plan"] as const).map((variant) => ({
        id: { startsWith: reportCommandPrefix(variant) },
      })),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, parsedIntent: true, createdAt: true },
  });
  const chatHref = reportHrefs(projectId, GaFlags.websitePage()).chat;
  const items: WebsiteReportArchiveItem[] = [];
  for (const row of rows) {
    const card = readWebsiteReportCard(cardOf(row.parsedIntent));
    if (!card) continue;
    if (
      card.variant !== "weekly" &&
      card.variant !== "monthly" &&
      card.variant !== "plan"
    ) {
      continue;
    }
    items.push({
      commandId: row.id,
      variant: card.variant,
      title: card.title,
      periodLabel: card.periodLabel,
      builtAt: card.builtAt,
      chatHref,
      card,
    });
  }
  return items;
}
