import "server-only";

import { prisma } from "@/lib/prisma";
import {
  CHANNELS,
  isChannelKey,
  resolveFormat,
} from "@/lib/content-channels";
import type { JourneyResult } from "@/lib/journey";

// What the measurement loop has reported about the plan's published pieces
// (MeasurementEngine: a 24h/72h/7d check after each publish, its result an
// `observation` the check task wrote). Shown as reported: nothing here is
// computed or made up, and a check that ran in mock mode is left out. Only
// pieces the agency published itself are measured (a piece the client posted by
// hand has no publish task to measure).

const WINDOW_DAYS = 30;
const MAX_OBSERVATION_CHARS = 600;
const MAX_RESULTS = 12;

type PlanRow = {
  taskId: string | null;
  checks: {
    label: string;
    dueAt: Date;
    resultSummary: unknown;
  }[];
};

// The newest completed, real check of each measurement plan, tied to the plan
// piece it measured (publish task -> payload.creativeId -> the piece).
export function toPlanResults(input: {
  plans: readonly PlanRow[];
  tasks: readonly { id: string; payload: unknown }[];
  creatives: readonly {
    id: string;
    title: string | null;
    channel: string | null;
    formatKey: string | null;
  }[];
}): JourneyResult[] {
  const creativeByTask = new Map<string, string>();
  for (const task of input.tasks) {
    const creativeId = (task.payload as { creativeId?: unknown } | null)
      ?.creativeId;
    if (typeof creativeId === "string") creativeByTask.set(task.id, creativeId);
  }
  const creativeById = new Map(input.creatives.map((c) => [c.id, c] as const));

  const results: JourneyResult[] = [];
  for (const plan of input.plans) {
    const creative = plan.taskId
      ? creativeById.get(creativeByTask.get(plan.taskId) ?? "")
      : undefined;
    if (!creative) continue;

    const latest = [...plan.checks]
      .filter((check) => {
        const summary = check.resultSummary as {
          observation?: unknown;
          isMock?: unknown;
        } | null;
        return (
          summary?.isMock !== true &&
          typeof summary?.observation === "string" &&
          summary.observation.trim() !== ""
        );
      })
      .sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime())[0];
    if (!latest) continue;

    const channel = isChannelKey(creative.channel) ? creative.channel : undefined;
    const format =
      channel && creative.formatKey
        ? resolveFormat(channel, creative.formatKey)
        : undefined;
    const observation = (
      latest.resultSummary as { observation: string }
    ).observation
      .trim()
      .slice(0, MAX_OBSERVATION_CHARS);
    results.push({
      creativeId: creative.id,
      title: creative.title?.trim() || "Untitled",
      where: channel
        ? format
          ? `${CHANNELS[channel].label} · ${format.label}`
          : CHANNELS[channel].label
        : "Post",
      check: latest.label,
      observation,
      checkedAt: latest.dueAt.toISOString(),
    });
  }
  return results
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
    .slice(0, MAX_RESULTS);
}

// Never throws: no results is a normal answer.
export async function loadPlanResults(
  projectId: string,
  now: Date = new Date(),
): Promise<JourneyResult[]> {
  try {
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60_000);
    const plans = await prisma.measurementPlan.findMany({
      where: { projectId, taskId: { not: null }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        taskId: true,
        checks: {
          where: { status: "COMPLETED" },
          select: { label: true, dueAt: true, resultSummary: true },
        },
      },
    });
    const taskIds = plans.flatMap((plan) => (plan.taskId ? [plan.taskId] : []));
    if (taskIds.length === 0) return [];

    const tasks = await prisma.task.findMany({
      where: { id: { in: taskIds }, projectId },
      select: { id: true, payload: true },
    });
    const creativeIds = tasks.flatMap((task) => {
      const id = (task.payload as { creativeId?: unknown } | null)?.creativeId;
      return typeof id === "string" ? [id] : [];
    });
    if (creativeIds.length === 0) return [];

    // Plan pieces only: anything else is not this journey's to report on.
    const creatives = await prisma.creative.findMany({
      where: { id: { in: creativeIds }, projectId, planId: { not: null } },
      select: { id: true, title: true, channel: true, formatKey: true },
    });
    return toPlanResults({ plans, tasks, creatives });
  } catch (error) {
    console.error("[journey] results failed:", error);
    return [];
  }
}
