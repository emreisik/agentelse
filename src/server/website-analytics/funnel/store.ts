import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gaFunnelEnabledFor } from "@/lib/website-analytics/agency/flags";
import { isGaEngineLink } from "@/lib/website-analytics/agency/scope";
import { validateFunnelDefinition } from "@/lib/website-analytics/funnel/definition";
import {
  funnelInsight,
  type FunnelInsight,
} from "@/lib/website-analytics/funnel/insight";
import {
  readStoredFunnelResult,
  readStoredFunnelSteps,
} from "@/lib/website-analytics/funnel/parse";
import type {
  FunnelDefinition,
  FunnelResult,
  FunnelStep,
} from "@/lib/website-analytics/funnel/types";

// Huni tanımları (GA-F8, GA_FUNNEL): mülk (bağ) başına en çok 5. Her yazım
// gaFunnelEnabledFor(projectId) ister (bayrak + yerel geliştirme koruması).

export const GA_MAX_FUNNELS_PER_LINK = 5;

export type FunnelView = {
  id: string;
  name: string;
  isOpen: boolean;
  steps: FunnelStep[];
  periodDays: number;
  lastRunAt: Date | null;
  lastError: string | null;
  result: FunnelResult | null;
  insight: FunnelInsight | null;
};

export async function listFunnels(
  projectId: string,
  linkId: string,
): Promise<FunnelView[]> {
  const rows = await prisma.gaFunnel.findMany({
    where: { projectId, linkId },
    orderBy: { createdAt: "asc" },
  });
  const views: FunnelView[] = [];
  for (const row of rows) {
    const steps = readStoredFunnelSteps(row.steps);
    if (!steps) continue;
    const result = readStoredFunnelResult(row.lastResult);
    views.push({
      id: row.id,
      name: row.name,
      isOpen: row.isOpen,
      steps,
      periodDays: row.periodDays,
      lastRunAt: row.lastRunAt,
      lastError: row.lastError,
      result,
      insight: result ? funnelInsight(steps, result) : null,
    });
  }
  return views;
}

export type SaveFunnelResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: "off" | "invalid" | "limit" | "no_link" | "not_found";
      message?: string;
    };

export async function saveFunnel(input: {
  projectId: string;
  linkId: string;
  userId: string;
  id?: string;
  definition: FunnelDefinition;
}): Promise<SaveFunnelResult> {
  if (!gaFunnelEnabledFor(input.projectId)) {
    return { ok: false, reason: "off" };
  }
  const checked = validateFunnelDefinition(input.definition);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", message: checked.message };
  }
  const { definition } = checked;

  const link = await prisma.gaPropertyLink.findFirst({
    where: { id: input.linkId, projectId: input.projectId },
    select: { id: true, workspaceId: true, isPrimary: true, isSecondary: true },
  });
  if (!link || !isGaEngineLink(link)) return { ok: false, reason: "no_link" };

  const steps = definition.steps as unknown as Prisma.InputJsonValue;
  if (input.id) {
    const existing = await prisma.gaFunnel.findFirst({
      where: { id: input.id, projectId: input.projectId, linkId: link.id },
      select: { id: true },
    });
    if (!existing) return { ok: false, reason: "not_found" };
    // Tanım değişince eski sonuç yanıltır; çalıştırma sayaçları ve
    // lastRunAt kalır (düzenleyerek günlük sınır aşılmasın).
    await prisma.gaFunnel.update({
      where: { id: existing.id },
      data: {
        name: definition.name,
        isOpen: definition.isOpen,
        periodDays: definition.periodDays,
        steps,
        lastResult: Prisma.DbNull,
        lastError: null,
      },
    });
    return { ok: true, id: existing.id };
  }

  const count = await prisma.gaFunnel.count({ where: { linkId: link.id } });
  if (count >= GA_MAX_FUNNELS_PER_LINK) return { ok: false, reason: "limit" };
  const created = await prisma.gaFunnel.create({
    data: {
      workspaceId: link.workspaceId,
      projectId: input.projectId,
      linkId: link.id,
      name: definition.name,
      isOpen: definition.isOpen,
      periodDays: definition.periodDays,
      steps,
      createdByUserId: input.userId,
    },
    select: { id: true },
  });
  return { ok: true, id: created.id };
}

export async function deleteFunnel(input: {
  projectId: string;
  funnelId: string;
}): Promise<"ok" | "not_found"> {
  if (!gaFunnelEnabledFor(input.projectId)) return "not_found";
  const result = await prisma.gaFunnel.deleteMany({
    where: { id: input.funnelId, projectId: input.projectId },
  });
  return result.count > 0 ? "ok" : "not_found";
}
