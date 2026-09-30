import "server-only";

import { prisma } from "@/lib/prisma";
import {
  isChannelKey,
  isPlanGoal,
  resolveFormat,
  type ChannelKey,
  type PlanGoal,
} from "@/lib/content-channels";
import { addDaysKey } from "@/lib/journey";
import { dayKeyInTimezone } from "@/lib/timezone";
import { getProjectTimezone, todayInTimezone } from "@/server/chat/content-plan";

// What the next plan inherits from the last one, so "plan the next weeks" is
// "Next, Next" and not an interview: the same goal, the same channels and
// formats, and a start date right after the last planned piece (so the
// calendar has no gap and no overlap).

export type PlanContinuation = {
  goal?: PlanGoal;
  // Channel -> the format keys the last plan used on it.
  formats: Partial<Record<ChannelKey, string[]>>;
  // The day after the last planned piece, when that is still ahead.
  continueFrom?: string;
};

type ContinuationRow = {
  goal: string | null;
  channel: string | null;
  formatKey: string | null;
  scheduledFor: Date | null;
};

// `rows` newest plan first: the goal of the most recent plan that had one wins.
export function summarizeContinuation(
  rows: readonly ContinuationRow[],
  timezone: string,
  today: string,
): PlanContinuation | null {
  if (rows.length === 0) return null;

  const formats: Partial<Record<ChannelKey, string[]>> = {};
  let goal: PlanGoal | undefined;
  let lastDate: string | undefined;
  for (const row of rows) {
    if (!goal && isPlanGoal(row.goal)) goal = row.goal;
    if (
      isChannelKey(row.channel) &&
      row.formatKey &&
      resolveFormat(row.channel, row.formatKey)
    ) {
      const list = (formats[row.channel] ??= []);
      if (!list.includes(row.formatKey)) list.push(row.formatKey);
    }
    if (row.scheduledFor) {
      const day = dayKeyInTimezone(row.scheduledFor, timezone);
      if (!lastDate || day > lastDate) lastDate = day;
    }
  }

  return {
    goal,
    formats,
    continueFrom: lastDate && lastDate >= today ? addDaysKey(lastDate, 1) : undefined,
  };
}

// Never throws: a plan wizard without a head start is still a wizard.
export async function loadPlanContinuation(
  projectId: string,
): Promise<PlanContinuation | null> {
  try {
    const timezone = await getProjectTimezone(projectId);
    const rows = await prisma.creative.findMany({
      where: {
        projectId,
        planId: { not: null },
        status: { not: "ARCHIVED" },
      },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: {
        goal: true,
        channel: true,
        formatKey: true,
        scheduledFor: true,
      },
    });
    return summarizeContinuation(rows, timezone, todayInTimezone(timezone));
  } catch (error) {
    console.error("[journey] continuation failed:", error);
    return null;
  }
}
